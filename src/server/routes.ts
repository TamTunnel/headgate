// Copyright 2026 TamTunnel. Licensed under the Apache License, Version 2.0.
// SPDX-License-Identifier: Apache-2.0

/**
 * HTTP routes. Tenant scoping: every repo-scoped endpoint requires an
 * installation_id (query param or X-Headgate-Installation header) and
 * every store call filters by that tenant (S-4). On top of that, every
 * /api/* route except /api/health requires the operator ADMIN_TOKEN
 * (F1): installation_id is caller-supplied labeling, not a credential.
 * PR titles/bodies are untrusted data: they are never interpolated into
 * SQL (parameterized queries only, in store.ts) and the dashboard renders
 * them escaped (React does this by default) (S-6).
 *
 * Headgate never writes to GitHub in v1: no endpoint approves, merges,
 * comments, or labels anything. "Reviewed" is a Headgate-side queue
 * state, not a GitHub state.
 */

import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import type { HeadgateConfig } from "./config";
import { buildDigestForRepo, todayDateString } from "./digestBuild";
import { recordDelivery, verifySignature } from "./webhook";
import { createTransporter, sendDigestEmail, smtpConfigured } from "./email";
import type { GitHubClient } from "./github";
import * as store from "./store";
import type { Worker } from "./worker";

export interface RouteDeps {
  pool: Pool;
  config: HeadgateConfig;
  github: GitHubClient;
  worker: Worker;
}

interface Body {
  [key: string]: unknown;
}

function bodyOf(req: FastifyRequest): Body {
  return (req.body ?? {}) as Body;
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Resolve the tenant from the request. Every repo-scoped endpoint
 *  requires it; without it the request is refused, not defaulted.
 *  Accepts the query param, the X-Headgate-Installation header, or
 *  the JSON body (POST endpoints). */
async function resolveTenant(
  req: FastifyRequest,
  pool: Pool,
): Promise<store.TenantRow | null> {
  const q = req.query as Record<string, unknown>;
  const b = (req.body ?? {}) as Record<string, unknown>;
  const raw =
    q.installation_id ??
    (req.headers["x-headgate-installation"] as string | undefined) ??
    b.installation_id;
  const installationId = Number(raw);
  if (!installationId) return null;
  return store.getTenantByInstallation(pool, installationId);
}

async function requireTenant(
  req: FastifyRequest,
  reply: FastifyReply,
  pool: Pool,
): Promise<store.TenantRow | null> {
  const tenant = await resolveTenant(req, pool);
  if (!tenant) {
    void reply.code(400).send({ error: "installation_id is required" });
    return null;
  }
  return tenant;
}

function repoParam(req: FastifyRequest): string {
  const q = req.query as Record<string, unknown>;
  return str(q.repo ?? bodyOf(req).repo);
}

/** F1: the operator token, from `Authorization: Bearer …` or the
 *  `X-Headgate-Admin` header, compared in constant time. An empty or
 *  unconfigured token authenticates nobody (fail closed). */
function adminTokenValid(req: FastifyRequest, adminToken: string): boolean {
  if (!adminToken) return false;
  const raw = req.headers.authorization ?? req.headers["x-headgate-admin"];
  if (typeof raw !== "string") return false;
  const token = raw.startsWith("Bearer ") ? raw.slice("Bearer ".length) : raw;
  const a = Buffer.from(token, "utf8");
  const b = Buffer.from(adminToken, "utf8");
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export function registerRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { pool, config } = deps;

  // F1: every /api/* route except /api/health requires the operator
  // token. Webhooks keep HMAC auth and are not /api/*; the dashboard
  // shell (/*) is public, but every data call it makes is /api/*.
  app.addHook("onRequest", async (req, reply) => {
    const url = req.url.split("?")[0];
    if (!url.startsWith("/api/") || url === "/api/health") return;
    if (!adminTokenValid(req, config.adminToken)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
  });

  app.get("/api/health", async () => ({
    ok: true,
    service: "headgate",
    version: "0.1.0",
  }));

  // ---- Webhooks (S-1, S-9, A-3) ----
  app.post("/webhooks/github", async (req, reply) => {
    const rawBody = (req as FastifyRequest & { rawBody?: Buffer }).rawBody;
    if (!rawBody) {
      return reply.code(400).send({ error: "missing raw body" });
    }
    const signature = req.headers["x-hub-signature-256"] as string | undefined;
    if (!verifySignature(config.webhookSecret, rawBody, signature)) {
      // Wrong or missing HMAC: 401, logged, never enqueued (S-1).
      req.log.warn(
        { event: req.headers["x-github-event"] ?? "" },
        "webhook rejected: bad signature",
      );
      return reply.code(401).send({ error: "invalid signature" });
    }
    const deliveryId = req.headers["x-github-delivery"] as string | undefined;
    if (!deliveryId) {
      return reply.code(400).send({ error: "missing X-GitHub-Delivery" });
    }
    const event = (req.headers["x-github-event"] as string | undefined) ?? "";
    // F3: record the delivery and enqueue the job in ONE transaction.
    // If the enqueue fails, the delivery row rolls back with it, so the
    // redelivery GitHub sends is processed instead of deduped — the
    // event is never silently lost (A-1).
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const seen = await recordDelivery(client, deliveryId, event);
      if (!seen) {
        // Replay: acknowledged, not re-processed (S-9).
        await client.query("ROLLBACK");
        return reply.code(200).send({ ok: true, deduped: true });
      }
      let payload: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(rawBody.toString("utf8"));
        // N1: a valid-JSON non-object body (e.g. literal `null`) is
        // not a webhook payload — ignore it like any other non-PR
        // event instead of 500ing on `payload.installation`.
        if (typeof parsed !== "object" || parsed === null) {
          await client.query("ROLLBACK");
          return reply.code(200).send({ ok: true, ignored: true });
        }
        payload = parsed as Record<string, unknown>;
      } catch {
        await client.query("ROLLBACK");
        return reply.code(400).send({ error: "invalid JSON" });
      }
      const installation = (payload.installation ?? {}) as Record<string, unknown>;
      const repository = (payload.repository ?? {}) as Record<string, unknown>;
      const pr = (payload.pull_request ?? {}) as Record<string, unknown>;
      const installationId = Number(installation.id ?? 0);
      const repoFullName = String(repository.full_name ?? "");
      const prNumber = Number(pr.number ?? 0);
      const account = (installation.account ?? {}) as Record<string, unknown>;
      if (!installationId || !repoFullName || !prNumber) {
        // Not a PR event we can act on (e.g. installation events):
        // accepted, nothing enqueued. The delivery row rolls back too —
        // a redelivery is re-examined, not deduped.
        await client.query("ROLLBACK");
        return reply.code(200).send({ ok: true, ignored: true });
      }
      await store.enqueueJob(
        client,
        "webhook",
        `webhook:${deliveryId}`,
        {
          installation_id: installationId,
          repo_full_name: repoFullName,
          pr_number: prNumber,
          account_login: String(account.login ?? ""),
          event,
        },
      );
      await client.query("COMMIT");
      return reply.code(202).send({ ok: true, queued: true });
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // The connection is already gone; nothing left to roll back.
      }
      throw err;
    } finally {
      client.release();
    }
  });

  // ---- Tenants / repos ----
  app.get("/api/tenants", async () => {
    const tenants = await store.listTenants(pool);
    return { tenants };
  });

  app.get("/api/repos", async (req, reply) => {
    const tenant = await requireTenant(req, reply, pool);
    if (!tenant) return;
    const repos = await store.listRepos(pool, tenant.id);
    return { repos };
  });

  // ---- Digest ----
  app.get("/api/digest", async (req, reply) => {
    const tenant = await requireTenant(req, reply, pool);
    if (!tenant) return;
    const repoName = repoParam(req);
    if (!repoName) return reply.code(400).send({ error: "repo is required" });
    const repo = await store.getRepo(pool, tenant.id, repoName);
    if (!repo) return reply.code(404).send({ error: "repo not found" });
    const q = req.query as Record<string, unknown>;
    const date = str(q.date, todayDateString());
    const digest = await store.getDigest(pool, tenant.id, repo.id, date);
    if (!digest) return reply.code(404).send({ error: "no digest for this date" });
    return { digest_id: digest.digest_id, state: digest.state, content: digest.content };
  });

  app.get("/api/digests", async (req, reply) => {
    const tenant = await requireTenant(req, reply, pool);
    if (!tenant) return;
    const repoName = repoParam(req);
    if (!repoName) return reply.code(400).send({ error: "repo is required" });
    const repo = await store.getRepo(pool, tenant.id, repoName);
    if (!repo) return reply.code(404).send({ error: "repo not found" });
    return { digests: await store.listDigests(pool, tenant.id, repo.id) };
  });

  app.post("/api/digest/build", async (req, reply) => {
    const tenant = await requireTenant(req, reply, pool);
    if (!tenant) return;
    const b = bodyOf(req);
    const repoName = str(b.repo);
    if (!repoName) return reply.code(400).send({ error: "repo is required" });
    const repo = await store.getRepo(pool, tenant.id, repoName);
    if (!repo) return reply.code(404).send({ error: "repo not found" });
    const date = str(b.date, todayDateString());
    const { digestId, created } = await buildDigestForRepo(
      pool,
      tenant.id,
      repo.id,
      repo.full_name,
      date,
    );
    if (created) {
      await store.appendAudit(pool, config.auditLogPath, "digest_issued", {
        tenant_id: tenant.id,
        repo: repo.full_name,
        date,
        digest_id: digestId,
      });
    }
    return { digest_id: digestId, created };
  });

  app.post("/api/digest/:digestId/email", async (req, reply) => {
    const tenant = await requireTenant(req, reply, pool);
    if (!tenant) return;
    const { digestId } = req.params as { digestId: string };
    const smtp = {
      host: config.smtpHost,
      port: config.smtpPort,
      user: config.smtpUser,
      pass: config.smtpPass,
      from: config.smtpFrom,
    };
    if (!smtpConfigured(smtp)) {
      return reply.code(409).send({ error: "SMTP is not configured" });
    }
    const recipients = config.digestRecipients
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (recipients.length === 0) {
      return reply.code(409).send({ error: "no digest recipients configured" });
    }
    const row = await pool.query(
      `SELECT content FROM digests WHERE digest_id = $1 AND tenant_id = $2`,
      [digestId, tenant.id],
    );
    if (!row.rows[0]) return reply.code(404).send({ error: "digest not found" });
    const transporter = createTransporter(smtp);
    await sendDigestEmail(
      transporter,
      smtp,
      recipients,
      row.rows[0].content as Parameters<typeof sendDigestEmail>[3],
      config.baseUrl,
    );
    await store.markDigestDelivered(pool, digestId);
    await store.appendAudit(pool, config.auditLogPath, "digest_emailed", {
      tenant_id: tenant.id,
      digest_id: digestId,
      recipients: recipients.length,
    });
    return { ok: true };
  });

  // ---- Live queue ----
  app.get("/api/queue", async (req, reply) => {
    const tenant = await requireTenant(req, reply, pool);
    if (!tenant) return;
    const repoName = repoParam(req);
    if (!repoName) return reply.code(400).send({ error: "repo is required" });
    const repo = await store.getRepo(pool, tenant.id, repoName);
    if (!repo) return reply.code(404).send({ error: "repo not found" });
    const openPrs = await store.listOpenPrs(pool, tenant.id, repo.id);
    const clusters = await store.listClusters(pool, tenant.id, repo.id);
    const prs = [];
    for (const pr of openPrs) {
      const score = await store.latestScore(pool, pr.id);
      const checks = await store.getPrChecks(pool, pr.id);
      prs.push({
        number: pr.number,
        title: pr.title,
        author: pr.author,
        is_bot: pr.is_bot,
        state: pr.state,
        url: `https://github.com/${repo.full_name}/pull/${pr.number}`,
        created_at: pr.created_at_pr,
        score: score?.score ?? null,
        band: score?.band ?? null,
        signals: score?.signals ?? [],
        ci: store.ciRollup(checks),
      });
    }
    const clusterViews = [];
    for (const c of clusters) {
      const members = await pool.query(
        `SELECT number FROM pull_requests WHERE id = ANY($1::uuid[]) ORDER BY number`,
        [c.member_pr_ids],
      );
      clusterViews.push({
        cluster_key: c.cluster_key,
        members: (members.rows as { number: number }[]).map((r) => r.number),
        edge_reasons: c.edge_reasons,
        human_override: c.human_override,
      });
    }
    return { repo: repo.full_name, prs, clusters: clusterViews };
  });

  // ---- Human actions (Headgate-side state only) ----
  const CLUSTER_ACTIONS = new Set([
    "reviewed",
    "snooze",
    "assign",
    "escalate",
    "split",
    "merge",
  ]);
  app.post("/api/cluster/action", async (req, reply) => {
    const tenant = await requireTenant(req, reply, pool);
    if (!tenant) return;
    const b = bodyOf(req);
    const repoName = str(b.repo);
    const clusterKey = str(b.cluster_key);
    const action = str(b.action);
    const actor = str(b.actor, "operator");
    const reason = str(b.reason);
    if (!repoName || !clusterKey || !CLUSTER_ACTIONS.has(action)) {
      return reply.code(400).send({ error: "repo, cluster_key and a valid action are required" });
    }
    const repo = await store.getRepo(pool, tenant.id, repoName);
    if (!repo) return reply.code(404).send({ error: "repo not found" });
    const clusters = await store.listClusters(pool, tenant.id, repo.id);
    const cluster = clusters.find((c) => c.cluster_key === clusterKey);
    if (!cluster) return reply.code(404).send({ error: "cluster not found" });

    let expiresAt: string | null = null;
    if (action === "snooze") {
      const days = num(b.snooze_days, 3);
      expiresAt = new Date(Date.now() + days * 86400000).toISOString();
    }
    if (action === "split") {
      const groups = b.groups as unknown;
      if (
        !Array.isArray(groups) ||
        groups.some((g) => !Array.isArray(g) || g.some((n) => typeof n !== "number"))
      ) {
        return reply.code(400).send({ error: "split requires groups: number[][]" });
      }
      await store.recordClusterCorrection(pool, tenant.id, repo.id, clusterKey, { split: { groups } }, actor, reason);
    }
    if (action === "merge") {
      const withKey = str(b.with_cluster_key);
      if (!withKey || !clusters.some((c) => c.cluster_key === withKey)) {
        return reply.code(400).send({ error: "merge requires with_cluster_key of an existing cluster" });
      }
      await store.recordClusterCorrection(pool, tenant.id, repo.id, clusterKey, { mergeWith: withKey }, actor, reason);
    }
    await store.recordDecision(pool, tenant.id, "cluster", clusterKey, action, actor, reason, expiresAt);
    await store.appendAudit(pool, config.auditLogPath, "cluster_action", {
      tenant_id: tenant.id,
      repo: repoName,
      cluster_key: clusterKey,
      action,
      actor,
      reason,
    });
    return { ok: true };
  });

  const PR_ACTIONS = new Set(["remove", "snooze", "assign"]);
  app.post("/api/pr/action", async (req, reply) => {
    const tenant = await requireTenant(req, reply, pool);
    if (!tenant) return;
    const b = bodyOf(req);
    const repoName = str(b.repo);
    const number = num(b.number);
    const action = str(b.action);
    const actor = str(b.actor, "operator");
    const reason = str(b.reason);
    if (!repoName || !number || !PR_ACTIONS.has(action)) {
      return reply.code(400).send({ error: "repo, number and a valid action are required" });
    }
    const repo = await store.getRepo(pool, tenant.id, repoName);
    if (!repo) return reply.code(404).send({ error: "repo not found" });
    const pr = await store.getPrByNumber(pool, tenant.id, repo.id, number);
    if (!pr) return reply.code(404).send({ error: "PR not found" });
    let expiresAt: string | null = null;
    if (action === "snooze") {
      const days = num(b.snooze_days, 3);
      expiresAt = new Date(Date.now() + days * 86400000).toISOString();
    }
    await store.recordDecision(pool, tenant.id, "pr", String(number), action, actor, reason, expiresAt);
    await store.appendAudit(pool, config.auditLogPath, "pr_action", {
      tenant_id: tenant.id,
      repo: repoName,
      pr_number: number,
      action,
      actor,
      reason,
    });
    return { ok: true };
  });

  // ---- Audit log ----
  app.get("/api/audit", async (req, reply) => {
    const tenant = await requireTenant(req, reply, pool);
    if (!tenant) return;
    const q = req.query as Record<string, unknown>;
    const limit = Math.min(200, Math.max(1, num(q.limit, 100)));
    const entries = await store.listAuditEntries(pool, limit);
    // Tenant filter: entries carry tenant_id in their payload.
    const filtered = entries.filter((e) => {
      const tid = (e.payload as Record<string, unknown>).tenant_id;
      return tid === undefined || tid === tenant.id;
    });
    return { entries: filtered };
  });

  app.get("/api/audit/verify", async (_req, reply) => {
    const result = await store.verifyAudit(pool);
    return reply.code(result.ok ? 200 : 500).send(result);
  });

  // ---- Ops ----
  app.get("/api/jobs/dead", async (_req, _reply) => {
    return { jobs: await store.listDeadJobs(pool) };
  });

  app.get("/api/jobs", async (_req, _reply) => {
    return { counts: await store.countJobsByState(pool) };
  });

  app.post("/api/backfill", async (req, reply) => {
    const tenant = await requireTenant(req, reply, pool);
    if (!tenant) return;
    const b = bodyOf(req);
    const repoName = str(b.repo);
    if (!repoName) return reply.code(400).send({ error: "repo is required" });
    const repo = await store.getRepo(pool, tenant.id, repoName);
    if (!repo) return reply.code(404).send({ error: "repo not found" });
    await store.enqueueJob(pool, "backfill", `backfill:${tenant.id}:${repo.id}:${Date.now()}`, {
      installation_id: tenant.installation_id,
      repo_full_name: repo.full_name,
    });
    return { ok: true, queued: true };
  });
}
