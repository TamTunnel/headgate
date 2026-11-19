// Copyright 2026 TamTunnel. Licensed under the Apache License, Version 2.0.
// SPDX-License-Identifier: Apache-2.0

/**
 * Digest build service: builds one digest/1 record for a repo from its
 * stored open PRs, scores, and clusters. Used by the worker (daily job)
 * and the manual build endpoint. The digest is immutable once issued —
 * rebuilding the same day from the same snapshots reproduces the
 * identical digest id (D-4), so a rebuild is a no-op.
 */

import type { Pool } from "pg";
import {
  clusterPrs,
  DEFAULT_AGENT_BRANCH_PREFIXES,
  type ClusterPr,
} from "./cluster";
import { buildDigest, type DigestClusterInput, type DigestExcluded, type DigestPr } from "./digest";
import { createHash } from "node:crypto";
import * as store from "./store";

export function todayDateString(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** F13: a snapshot is stale when it is older than 24h at digest build
 *  time. A missing or unparseable snapshot time counts as stale — the
 *  digest must say so rather than silently present old data as fresh. */
export const STALE_SNAPSHOT_MS = 24 * 60 * 60 * 1000;
export function snapshotIsStale(
  snapshotAt: string | Date | null | undefined,
  nowMs = Date.now(),
): boolean {
  if (!snapshotAt) return true;
  const t =
    snapshotAt instanceof Date
      ? snapshotAt.getTime()
      : new Date(snapshotAt).getTime();
  if (Number.isNaN(t)) return true;
  return nowMs - t > STALE_SNAPSHOT_MS;
}

/** pg returns timestamptz columns as Date objects; digest content
 *  hashes strings, so normalize to ISO. */
export function isoDate(v: string | Date | null | undefined): string {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string" && v) return v;
  return new Date().toISOString();
}

/** Build (or return the existing) digest for a repo on a date. */
export async function buildDigestForRepo(
  pool: Pool,
  tenantId: string,
  repoId: string,
  fullName: string,
  date: string,
): Promise<{ digestId: string; created: boolean }> {
  const existing = await store.getDigest(pool, tenantId, repoId, date);
  if (existing) return { digestId: existing.digest_id, created: false };

  const repo = await pool.query(
    `SELECT sensitive_paths, agent_branch_prefixes FROM repos WHERE id = $1`,
    [repoId],
  );
  const sensitivePaths: string[] =
    (repo.rows[0]?.sensitive_paths as string[]) ?? [];
  const agentPrefixes: string[] =
    (repo.rows[0]?.agent_branch_prefixes as string[] | null)?.length
      ? (repo.rows[0].agent_branch_prefixes as string[])
      : DEFAULT_AGENT_BRANCH_PREFIXES;

  const openPrs = await store.listOpenPrs(pool, tenantId, repoId);

  // Score any open PR that has no score yet (a snapshot that arrived
  // without a scoring run, e.g. after a crash mid-job).
  for (const pr of openPrs) {
    const existingScore = await store.latestScore(pool, pr.id);
    if (!existingScore) {
      await store.scoreStoredPr(pool, tenantId, repoId, pr, sensitivePaths);
    }
  }

  // Cluster from stored snapshots.
  const clusterInputs: ClusterPr[] = [];
  for (const pr of openPrs) {
    const files = await store.getPrFiles(pool, pr.id);
    clusterInputs.push({
      number: pr.number,
      files: files.map((f) => f.path),
      linkedIssues: pr.linked_issues,
      headBranch: pr.head_branch,
      diffHash: pr.diff_hash,
    });
  }
  const clusters = clusterPrs(clusterInputs, agentPrefixes);
  await store.reclusterRepo(pool, tenantId, repoId, clusters);

  // Human decisions that exclude PRs/clusters from the digest (D-6):
  // a reviewed cluster's members and snoozed PRs land in `excluded`
  // with a reason instead of silently vanishing.
  const decisions = await store.listDecisions(pool, tenantId);
  const excludedPrs = new Map<number, string>();
  const excludedClusters = new Set<string>();
  const escalatedClusters = new Set<string>();
  const removedPrs = new Set<number>();
  const now = Date.now();
  for (const d of decisions) {
    // Expired snoozes no longer exclude anything: the PR returns to
    // the digest after its snooze window.
    const expiresAt = d.expires_at as string | null;
    if (expiresAt && new Date(expiresAt).getTime() <= now) continue;
    const action = String(d.action);
    const targetType = String(d.target_type);
    const targetId = String(d.target_id);
    if (targetType === "cluster" && action === "reviewed") {
      excludedClusters.add(targetId);
    }
    if (targetType === "cluster" && action === "escalate") {
      escalatedClusters.add(targetId);
    }
    if (targetType === "pr" && action === "snooze") {
      const n = Number(targetId);
      if (!Number.isNaN(n)) excludedPrs.set(n, `snoozed: ${String(d.reason ?? "")}`);
    }
    if (targetType === "pr" && action === "remove") {
      const n = Number(targetId);
      if (!Number.isNaN(n)) removedPrs.add(n);
    }
  }

  const storedClusters = await store.listClusters(pool, tenantId, repoId);
  const prByNumber = new Map(openPrs.map((p) => [p.number, p]));
  const digestClusters: DigestClusterInput[] = [];
  const excluded: DigestExcluded[] = [];
  const removedMembers: DigestPr[] = [];

  for (const sc of storedClusters) {
    const memberRows = await pool.query(
      `SELECT number FROM pull_requests WHERE id = ANY($1::uuid[])`,
      [sc.member_pr_ids],
    );
    const memberNumbers = (memberRows.rows as { number: number }[]).map(
      (r) => r.number,
    );
    if (excludedClusters.has(sc.cluster_key)) {
      for (const n of memberNumbers) {
        excluded.push({ pr_number: n, reason: "cluster marked reviewed" });
      }
      continue;
    }
    const members: DigestPr[] = [];
    for (const n of memberNumbers) {
      const pr = prByNumber.get(n);
      if (!pr) continue;
      if (excludedPrs.has(n)) {
        excluded.push({ pr_number: n, reason: excludedPrs.get(n) ?? "snoozed" });
        continue;
      }
      const score = await store.latestScore(pool, pr.id);
      const checks = await store.getPrChecks(pool, pr.id);
      const member: DigestPr = {
        number: pr.number,
        title: pr.title,
        url: `https://github.com/${fullName}/pull/${pr.number}`,
        author: pr.author,
        isBot: pr.is_bot,
        score: score ?? { score: 0, band: "low", signals: [] },
        createdAt: isoDate(pr.created_at_pr),
        ci: store.ciRollup(checks),
        snapshotAt: isoDate(pr.snapshot_at),
        stale: snapshotIsStale(pr.snapshot_at),
      };
      // "Remove from cluster": the PR leaves its cluster and stands
      // alone as a singleton in the digest.
      if (removedPrs.has(n)) {
        removedMembers.push(member);
        continue;
      }
      members.push(member);
    }
    if (members.length > 0) {
      digestClusters.push({
        key: sc.cluster_key,
        members,
        edges: sc.edge_reasons,
      });
    }
  }

  // Any open PR not in any stored cluster (e.g. it arrived after the
  // last clustering run) becomes a singleton cluster — never a silent
  // drop (D-6). Removed-from-cluster members become singletons too.
  const covered = new Set(
    digestClusters.flatMap((c) => c.members.map((m) => m.number)),
  );
  for (const member of removedMembers) {
    const key = createHash("sha256")
      .update(JSON.stringify([member.number]))
      .digest("hex")
      .slice(0, 16);
    digestClusters.push({ key, members: [member], edges: [] });
    covered.add(member.number);
  }
  for (const pr of openPrs) {
    if (covered.has(pr.number) || excluded.some((e) => e.pr_number === pr.number)) continue;
    if (excludedPrs.has(pr.number)) {
      excluded.push({ pr_number: pr.number, reason: excludedPrs.get(pr.number) ?? "snoozed" });
      continue;
    }
    const score = await store.latestScore(pool, pr.id);
    const checks = await store.getPrChecks(pool, pr.id);
    const key = createHash("sha256")
      .update(JSON.stringify([pr.number]))
      .digest("hex")
      .slice(0, 16);
    digestClusters.push({
      key,
      members: [
        {
          number: pr.number,
          title: pr.title,
          url: `https://github.com/${fullName}/pull/${pr.number}`,
          author: pr.author,
          isBot: pr.is_bot,
          score: score ?? { score: 0, band: "low", signals: [] },
          createdAt: isoDate(pr.created_at_pr),
          ci: store.ciRollup(checks),
          snapshotAt: isoDate(pr.snapshot_at),
          stale: snapshotIsStale(pr.snapshot_at),
        },
      ],
      edges: [],
    });
  }

  const { digestId, content } = buildDigest(
    fullName,
    date,
    digestClusters,
    excluded,
    escalatedClusters,
  );
  // F7: `created` comes from the insert itself, not from the
  // check-then-act above — two concurrent builds for the same
  // (tenant, repo, date) both pass the early getDigest check, but only
  // the winner of the insert reports created=true, so exactly one
  // digest_issued audit entry is written.
  const created = await store.storeDigest(pool, tenantId, repoId, date, digestId, content);
  return { digestId, created };
}
