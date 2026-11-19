// Copyright 2026 TamTunnel. Licensed under the Apache License, Version 2.0.
// SPDX-License-Identifier: Apache-2.0

/**
 * Worker: DB-backed job queue consumer (WishShip/Filliz pattern).
 * Job types:
 *   webhook  — one GitHub delivery: fetch the PR snapshot via the
 *               GitHub client, upsert it, score it, recluster the repo.
 *   digest   — build the daily digest/1 for a repo.
 *   email    — send a built digest via SMTP (skipped when SMTP is not
 *               configured; the web UI alone is a complete product).
 *   backfill — reconcile a repo's open PRs against the GitHub API.
 *   prune    — bounded retention of merged/closed PR snapshots (A-6).
 *
 * Jobs retry with jittered backoff and dead-letter after max attempts
 * (A-5). Rate-limit errors (A-2) are retried, not dropped; the digest
 * notes which PRs are stale via their snapshot_at.
 */

import type { Pool } from "pg";
import { clusterPrs, DEFAULT_AGENT_BRANCH_PREFIXES } from "./cluster";
import type { HeadgateConfig } from "./config";
import type { DigestContent } from "./digest";
import { buildDigestForRepo, todayDateString } from "./digestBuild";
import { sendDigestEmail, createTransporter, smtpConfigured } from "./email";
import { RateLimitedError, type GitHubClient } from "./github";
import * as store from "./store";

export interface WorkerDeps {
  pool: Pool;
  config: HeadgateConfig;
  github: GitHubClient;
}

export class Worker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly deps: WorkerDeps) {}

  start(intervalMs = 2000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Process up to `batch` claimable jobs (one tick drains a burst
   *  instead of one job per interval — A-1: 200 events in 10 minutes
   *  must not sit behind a 2s-per-job drip). Returns how many ran. */
  async tick(batch = 10): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      let ran = 0;
      for (let i = 0; i < batch; i++) {
        const job = await store.claimJob(this.deps.pool);
        if (!job) break;
        ran++;
        try {
          await this.handle(job.type, job.payload as Record<string, unknown>);
          await store.finishJob(this.deps.pool, job.id, true);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          // Rate limits back off harder and never dead-letter on the
          // first hits: the job is re-queued with a longer delay.
          if (err instanceof RateLimitedError) {
            await this.deps.pool.query(
              `UPDATE jobs SET state = 'failed', last_error = $2,
                 next_run_at = now() + interval '15 minutes', updated_at = now()
               WHERE id = $1`,
              [job.id, message.slice(0, 500)],
            );
          } else {
            await store.finishJob(this.deps.pool, job.id, false, message);
          }
        }
      }
      return ran;
    } finally {
      this.running = false;
    }
  }

  /** Drain the queue (used by tests and the smoke script). */
  async drain(maxJobs = 100): Promise<number> {
    let ran = 0;
    for (let i = 0; i < maxJobs; i++) {
      const did = await this.tick();
      if (!did) break;
      ran += did;
    }
    return ran;
  }

  private async handle(
    type: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    switch (type) {
      case "webhook":
        await this.handleWebhook(payload);
        break;
      case "digest":
        await this.handleDigest(payload);
        break;
      case "email":
        await this.handleEmail(payload);
        break;
      case "backfill":
        await this.handleBackfill(payload);
        break;
      case "prune":
        await this.handlePrune(payload);
        break;
      default:
        throw new Error(`unknown job type: ${type}`);
    }
  }

  private async handleWebhook(payload: Record<string, unknown>): Promise<void> {
    const { pool, config, github } = this.deps;
    const installationId = Number(payload.installation_id);
    const repoFullName = String(payload.repo_full_name ?? "");
    const prNumber = Number(payload.pr_number);
    const accountLogin = String(payload.account_login ?? "");
    if (!installationId || !repoFullName || !prNumber) {
      throw new Error("webhook job missing installation_id/repo_full_name/pr_number");
    }
    const tenant = await store.ensureTenant(pool, installationId, accountLogin);
    const repo = await store.ensureRepo(pool, tenant.id, repoFullName);
    const pr = await github.fetchPr(installationId, repoFullName, prNumber);
    const files = await github.fetchPrFiles(installationId, repoFullName, prNumber);
    const checks = await github.fetchPrChecks(installationId, repoFullName, pr);
    const row = await store.upsertPr(pool, tenant.id, repo.id, pr, files, checks);
    const repoRow = await store.getRepo(pool, tenant.id, repoFullName);
    await store.scoreStoredPr(
      pool,
      tenant.id,
      repo.id,
      row,
      repoRow?.sensitive_paths ?? [],
    );
    await this.recluster(pool, tenant.id, repo.id);
    await store.appendAudit(pool, config.auditLogPath, "pr_ingested", {
      tenant_id: tenant.id,
      repo: repoFullName,
      pr_number: prNumber,
      state: pr.state,
    });
  }

  private async recluster(pool: Pool, tenantId: string, repoId: string): Promise<void> {
    const openPrs = await store.listOpenPrs(pool, tenantId, repoId);
    const repo = await store.getRepoById(pool, repoId);
    const agentPrefixes =
      repo?.agent_branch_prefixes?.length
        ? repo.agent_branch_prefixes
        : DEFAULT_AGENT_BRANCH_PREFIXES;
    const inputs = [];
    for (const pr of openPrs) {
      const files = await store.getPrFiles(pool, pr.id);
      inputs.push({
        number: pr.number,
        files: files.map((f) => f.path),
        linkedIssues: pr.linked_issues,
        headBranch: pr.head_branch,
        diffHash: pr.diff_hash,
      });
    }
    await store.reclusterRepo(pool, tenantId, repoId, clusterPrs(inputs, agentPrefixes));
  }

  private async handleDigest(payload: Record<string, unknown>): Promise<void> {
    const { pool } = this.deps;
    const tenant = await store.getTenantByInstallation(
      pool,
      Number(payload.installation_id),
    );
    if (!tenant) throw new Error("digest job: unknown tenant");
    const repo = await store.getRepo(pool, tenant.id, String(payload.repo_full_name ?? ""));
    if (!repo) throw new Error("digest job: unknown repo");
    const date = String(payload.date ?? todayDateString());
    const { digestId, created } = await buildDigestForRepo(
      pool,
      tenant.id,
      repo.id,
      repo.full_name,
      date,
    );
    if (created) {
      await store.appendAudit(pool, this.deps.config.auditLogPath, "digest_issued", {
        tenant_id: tenant.id,
        repo: repo.full_name,
        date,
        digest_id: digestId,
      });
      // Queue the email send when SMTP is configured and recipients exist.
      const recipients = this.deps.config.digestRecipients
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (
        smtpConfigured({
          host: this.deps.config.smtpHost,
          port: this.deps.config.smtpPort,
          user: this.deps.config.smtpUser,
          pass: this.deps.config.smtpPass,
          from: this.deps.config.smtpFrom,
        }) &&
        recipients.length > 0
      ) {
        await store.enqueueJob(
          pool,
          "email",
          `email:${digestId}`,
          { digest_id: digestId, tenant_id: tenant.id, repo_id: repo.id },
        );
      }
    }
  }

  private async handleEmail(payload: Record<string, unknown>): Promise<void> {
    const { pool, config } = this.deps;
    const digestId = String(payload.digest_id ?? "");
    const repoId = String(payload.repo_id ?? "");
    const tenantId = String(payload.tenant_id ?? "");
    const row = await pool.query(
      `SELECT content, repo_id FROM digests WHERE digest_id = $1`,
      [digestId],
    );
    if (!row.rows[0]) throw new Error(`email job: unknown digest ${digestId}`);
    const content = row.rows[0].content as DigestContent;
    const recipients = config.digestRecipients
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (recipients.length === 0) return; // Nothing to send to.
    const transporter = createTransporter({
      host: config.smtpHost,
      port: config.smtpPort,
      user: config.smtpUser,
      pass: config.smtpPass,
      from: config.smtpFrom,
    });
    await sendDigestEmail(
      transporter,
      {
        host: config.smtpHost,
        port: config.smtpPort,
        user: config.smtpUser,
        pass: config.smtpPass,
        from: config.smtpFrom,
      },
      recipients,
      content,
      config.baseUrl,
    );
    await store.markDigestDelivered(pool, digestId);
    await store.appendAudit(pool, config.auditLogPath, "digest_emailed", {
      tenant_id: tenantId,
      repo_id: repoId,
      digest_id: digestId,
      recipients: recipients.length,
    });
  }

  private async handleBackfill(payload: Record<string, unknown>): Promise<void> {
    const { pool, github } = this.deps;
    const installationId = Number(payload.installation_id);
    const repoFullName = String(payload.repo_full_name ?? "");
    const tenant = await store.getTenantByInstallation(pool, installationId);
    if (!tenant) throw new Error("backfill job: unknown tenant");
    const repo = await store.getRepo(pool, tenant.id, repoFullName);
    if (!repo) throw new Error("backfill job: unknown repo");
    const open = await github.listOpenPrs(installationId, repoFullName);
    for (const pr of open) {
      const files = await github.fetchPrFiles(installationId, repoFullName, pr.number);
      const checks = await github.fetchPrChecks(installationId, repoFullName, pr);
      const row = await store.upsertPr(pool, tenant.id, repo.id, pr, files, checks);
      await store.scoreStoredPr(pool, tenant.id, repo.id, row, repo.sensitive_paths);
    }
    await this.recluster(pool, tenant.id, repo.id);
  }

  private async handlePrune(payload: Record<string, unknown>): Promise<void> {
    const days = Number(payload.days ?? this.deps.config.retentionDays);
    await store.pruneOldSnapshots(this.deps.pool, days);
  }
}
