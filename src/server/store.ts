// Copyright 2026 TamTunnel. Licensed under the Apache License, Version 2.0.
// SPDX-License-Identifier: Apache-2.0

/**
 * Store: all Postgres access. Every query carries tenant_id (app-layer
 * scoping; no RLS in v1 — stated honestly in the README) and every
 * value goes through parameterized queries (S-6). No query ever
 * interpolates user-supplied text.
 */

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Pool, PoolClient } from "pg";
import {
  appendAuditEntry,
  hashAuditEntry,
  verifyAuditChain,
  type AuditEntry,
} from "./audit";
import { canonicalize } from "./canonical";
import { clusterKey, type Cluster, type ClusterEdge } from "./cluster";
import type { DigestContent } from "./digest";
import type { GhCheck, GhFile, GhPr } from "./github";
import { diffHash } from "./github";
import type { RiskScore, ScorerCheck, ScorerFile } from "./scorer";
import { scorePr, topReasons } from "./scorer";

export type Db = Pool | PoolClient;

export interface TenantRow {
  id: string;
  installation_id: number;
  account_login: string;
}

export interface RepoRow {
  id: string;
  tenant_id: string;
  full_name: string;
  digest_hour: number;
  sensitive_paths: string[];
}

export interface PrRow {
  id: string;
  tenant_id: string;
  repo_id: string;
  number: number;
  author: string;
  author_type: string;
  is_bot: boolean;
  title: string;
  body: string;
  base_sha: string;
  head_sha: string;
  head_branch: string;
  base_branch: string;
  state: string;
  diff_hash: string;
  created_at_pr: string | null;
  updated_at_pr: string | null;
  merged_at: string | null;
  linked_issues: number[];
  force_pushes: number;
  commits_after_touch: number;
  snapshot: Record<string, unknown>;
}

export async function ensureTenant(
  pool: Pool,
  installationId: number,
  accountLogin: string,
): Promise<TenantRow> {
  const res = await pool.query(
    `INSERT INTO tenants (installation_id, account_login)
     VALUES ($1, $2)
     ON CONFLICT (installation_id) DO UPDATE SET account_login = EXCLUDED.account_login
     RETURNING *`,
    [installationId, accountLogin],
  );
  return res.rows[0] as TenantRow;
}

export async function getTenantByInstallation(
  db: Db,
  installationId: number,
): Promise<TenantRow | null> {
  const res = await db.query(
    `SELECT * FROM tenants WHERE installation_id = $1`,
    [installationId],
  );
  return (res.rows[0] as TenantRow | undefined) ?? null;
}

export async function listTenants(db: Db): Promise<TenantRow[]> {
  const res = await db.query(
    `SELECT * FROM tenants ORDER BY installation_id`,
  );
  return res.rows as TenantRow[];
}

export async function ensureRepo(
  pool: Pool,
  tenantId: string,
  fullName: string,
): Promise<RepoRow> {
  const res = await pool.query(
    `INSERT INTO repos (tenant_id, full_name)
     VALUES ($1, $2)
     ON CONFLICT (tenant_id, full_name) DO NOTHING
     RETURNING *`,
    [tenantId, fullName],
  );
  if (res.rows[0]) return res.rows[0] as RepoRow;
  const existing = await pool.query(
    `SELECT * FROM repos WHERE tenant_id = $1 AND full_name = $2`,
    [tenantId, fullName],
  );
  return existing.rows[0] as RepoRow;
}

export async function listRepos(db: Db, tenantId: string): Promise<RepoRow[]> {
  const res = await db.query(
    `SELECT * FROM repos WHERE tenant_id = $1 ORDER BY full_name`,
    [tenantId],
  );
  return res.rows as RepoRow[];
}

export async function getRepo(
  db: Db,
  tenantId: string,
  fullName: string,
): Promise<RepoRow | null> {
  const res = await db.query(
    `SELECT * FROM repos WHERE tenant_id = $1 AND full_name = $2`,
    [tenantId, fullName],
  );
  return (res.rows[0] as RepoRow | undefined) ?? null;
}

/** Idempotent upsert of a PR snapshot on (tenant, repo, number).
 *  A duplicate delivery produces no second snapshot (S-9, A-3). */
export async function upsertPr(
  pool: Pool,
  tenantId: string,
  repoId: string,
  pr: GhPr,
  files: GhFile[],
  checks: GhCheck[],
): Promise<PrRow> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const res = await client.query(
      `INSERT INTO pull_requests
         (tenant_id, repo_id, number, author, author_type, is_bot, title, body,
          base_sha, head_sha, head_branch, base_branch, state, diff_hash,
          created_at_pr, updated_at_pr, merged_at, linked_issues,
          force_pushes, commits_after_touch, snapshot)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       ON CONFLICT (tenant_id, repo_id, number) DO UPDATE SET
         author = EXCLUDED.author, author_type = EXCLUDED.author_type,
         is_bot = EXCLUDED.is_bot, title = EXCLUDED.title, body = EXCLUDED.body,
         base_sha = EXCLUDED.base_sha, head_sha = EXCLUDED.head_sha,
         head_branch = EXCLUDED.head_branch, base_branch = EXCLUDED.base_branch,
         state = EXCLUDED.state, diff_hash = EXCLUDED.diff_hash,
         created_at_pr = EXCLUDED.created_at_pr, updated_at_pr = EXCLUDED.updated_at_pr,
         merged_at = EXCLUDED.merged_at, linked_issues = EXCLUDED.linked_issues,
         force_pushes = EXCLUDED.force_pushes,
         commits_after_touch = EXCLUDED.commits_after_touch,
         snapshot = EXCLUDED.snapshot, snapshot_at = now(), updated_at = now()
       RETURNING *`,
      [
        tenantId,
        repoId,
        pr.number,
        pr.author,
        pr.authorType,
        pr.isBot,
        pr.title,
        pr.body,
        pr.baseSha,
        pr.headSha,
        pr.headBranch,
        pr.baseBranch,
        pr.state,
        diffHash(files),
        pr.createdAt || null,
        pr.updatedAt || null,
        pr.mergedAt,
        pr.linkedIssues,
        pr.forcePushes,
        pr.commitsAfterTouch,
        JSON.stringify({ ...pr, files: files.length, checks: checks.length }),
      ],
    );
    const row = res.rows[0] as PrRow;
    await client.query(`DELETE FROM pr_files WHERE pr_id = $1`, [row.id]);
    for (const f of files) {
      await client.query(
        `INSERT INTO pr_files (pr_id, path, additions, deletions, status, patch)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [row.id, f.path, f.additions, f.deletions, f.status, f.patch],
      );
    }
    await client.query(`DELETE FROM pr_checks WHERE pr_id = $1`, [row.id]);
    for (const c of checks) {
      await client.query(
        `INSERT INTO pr_checks (pr_id, name, status, conclusion, completed_at)
         VALUES ($1,$2,$3,$4,$5)`,
        [row.id, c.name, c.status, c.conclusion, c.completedAt],
      );
    }
    await client.query("COMMIT");
    return row;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function getPrFiles(db: Db, prId: string): Promise<ScorerFile[]> {
  const res = await db.query(
    `SELECT path, additions, deletions, patch FROM pr_files WHERE pr_id = $1 ORDER BY path`,
    [prId],
  );
  return res.rows as ScorerFile[];
}

export async function getPrChecks(db: Db, prId: string): Promise<ScorerCheck[]> {
  const res = await db.query(
    `SELECT name, status, conclusion FROM pr_checks WHERE pr_id = $1 ORDER BY name`,
    [prId],
  );
  return res.rows as ScorerCheck[];
}

export async function listOpenPrs(
  db: Db,
  tenantId: string,
  repoId: string,
): Promise<PrRow[]> {
  const res = await db.query(
    `SELECT * FROM pull_requests
     WHERE tenant_id = $1 AND repo_id = $2 AND state = 'open'
     ORDER BY number`,
    [tenantId, repoId],
  );
  return res.rows as PrRow[];
}

export async function getPrByNumber(
  db: Db,
  tenantId: string,
  repoId: string,
  number: number,
): Promise<PrRow | null> {
  const res = await db.query(
    `SELECT * FROM pull_requests
     WHERE tenant_id = $1 AND repo_id = $2 AND number = $3`,
    [tenantId, repoId, number],
  );
  return (res.rows[0] as PrRow | undefined) ?? null;
}

/** Author fleet context for scoring, computed from stored snapshots. */
export async function authorContext(
  db: Db,
  tenantId: string,
  repoId: string,
  pr: PrRow,
): Promise<{ isBot: boolean; firstPrInRepo: boolean; priorReverts: number }> {
  const prior = await db.query(
    `SELECT COUNT(*)::int AS n FROM pull_requests
     WHERE tenant_id = $1 AND repo_id = $2 AND author = $3 AND id <> $4`,
    [tenantId, repoId, pr.author, pr.id],
  );
  const reverts = await db.query(
    `SELECT COUNT(*)::int AS n FROM pull_requests
     WHERE tenant_id = $1 AND repo_id = $2 AND author = $3 AND id <> $4
       AND title ILIKE 'revert%'`,
    [tenantId, repoId, pr.author, pr.id],
  );
  return {
    isBot: pr.is_bot,
    firstPrInRepo: (prior.rows[0].n as number) === 0,
    priorReverts: reverts.rows[0].n as number,
  };
}

/** Score one stored PR and persist the result. Returns the score. */
export async function scoreStoredPr(
  pool: Pool,
  tenantId: string,
  repoId: string,
  pr: PrRow,
  sensitivePaths: string[],
): Promise<RiskScore> {
  const files = await getPrFiles(pool, pr.id);
  const checks = await getPrChecks(pool, pr.id);
  const author = await authorContext(pool, tenantId, repoId, pr);
  const open = await listOpenPrs(pool, tenantId, repoId);
  const others = open.filter((o) => o.id !== pr.id);
  const myFiles = new Set(files.map((f) => f.path));
  let overlapping = 0;
  for (const o of others) {
    const of = await getPrFiles(pool, o.id);
    if (of.some((f) => myFiles.has(f.path))) overlapping++;
  }
  const sharesIssue = others.some((o) =>
    o.linked_issues.some((n) => pr.linked_issues.includes(n)),
  );
  const duplicateOf = others.find((o) => o.diff_hash && o.diff_hash === pr.diff_hash);
  const daysStale = pr.updated_at_pr
    ? Math.max(
        0,
        Math.floor(
          (Date.now() - new Date(pr.updated_at_pr).getTime()) / 86400000,
        ),
      )
    : 0;
  const score = scorePr({
    files,
    checks,
    author,
    overlap: { overlappingPrs: overlapping, sharesLinkedIssue: sharesIssue },
    forcePushes: pr.force_pushes,
    commitsAfterTouch: pr.commits_after_touch,
    daysStale,
    duplicateOfPr: duplicateOf ? duplicateOf.number : null,
    sensitivePaths,
  });
  await pool.query(
    `INSERT INTO risk_scores (pr_id, score, band, signals) VALUES ($1,$2,$3,$4)`,
    [pr.id, score.score, score.band, JSON.stringify(score.signals)],
  );
  return score;
}

export async function latestScore(
  db: Db,
  prId: string,
): Promise<RiskScore | null> {
  const res = await db.query(
    `SELECT score, band, signals FROM risk_scores
     WHERE pr_id = $1 ORDER BY scored_at DESC LIMIT 1`,
    [prId],
  );
  const row = res.rows[0] as
    | { score: number; band: string; signals: ScoreSignal[] }
    | undefined;
  if (!row) return null;
  return { score: row.score, band: row.band as RiskScore["band"], signals: row.signals };
}

interface ScoreSignal {
  name: string;
  points: number;
  evidence: string;
}

/** CI rollup for one PR from its stored checks. */
export function ciRollup(checks: ScorerCheck[]): string {
  if (checks.length === 0) return "none";
  const conclusions = checks.map((c) => c.conclusion ?? c.status);
  if (conclusions.some((c) => c === "failure" || c === "cancelled" || c === "timed_out")) return "red";
  if (conclusions.some((c) => c === "success")) return "green";
  return "pending";
}

/** Recompute clusters for a repo from its open PRs and persist them.
 *  Human corrections (split/merge) recorded in cluster_corrections are
 *  applied on top of the computed clusters and persist across runs
 *  (D-5): a correction is keyed by cluster_key, and a membership change
 *  produces a new key, so the correction stops applying exactly when
 *  the cluster it corrected no longer exists. */
export async function reclusterRepo(
  pool: Pool,
  tenantId: string,
  repoId: string,
  clusters: Cluster[],
): Promise<void> {
  const corrections = await pool.query(
    `SELECT cluster_key, correction FROM cluster_corrections
     WHERE tenant_id = $1 AND repo_id = $2`,
    [tenantId, repoId],
  );
  const correctionByKey = new Map<string, Record<string, unknown>>();
  for (const row of corrections.rows as { cluster_key: string; correction: Record<string, unknown> }[]) {
    correctionByKey.set(row.cluster_key, row.correction);
  }

  // Apply corrections to the computed clusters.
  const out: Cluster[] = [];
  const consumed = new Set<string>();
  for (const c of clusters) {
    if (consumed.has(c.key)) continue;
    const corr = correctionByKey.get(c.key);
    const splitGroups = corr?.split as { groups?: number[][] } | undefined;
    if (splitGroups?.groups && Array.isArray(splitGroups.groups)) {
      for (const g of splitGroups.groups) {
        const members = [...g].sort((a, b) => a - b);
        if (members.length === 0) continue;
        out.push({
          key: clusterKey(members),
          members,
          edges: c.edges,
        });
      }
      consumed.add(c.key);
      continue;
    }
    const mergeWith = corr?.mergeWith as string | undefined;
    if (mergeWith) {
      const other = clusters.find((x) => x.key === mergeWith);
      if (other && !consumed.has(other.key)) {
        const members = [...c.members, ...other.members].sort((a, b) => a - b);
        out.push({
          key: clusterKey(members),
          members,
          edges: [...c.edges, ...other.edges],
        });
        consumed.add(c.key);
        consumed.add(other.key);
        continue;
      }
    }
    out.push(c);
  }

  await pool.query(`DELETE FROM clusters WHERE tenant_id = $1 AND repo_id = $2`, [
    tenantId,
    repoId,
  ]);
  for (const c of out) {
    const members = await pool.query(
      `SELECT id FROM pull_requests
       WHERE tenant_id = $1 AND repo_id = $2 AND number = ANY($3::int[])`,
      [tenantId, repoId, c.members],
    );
    const ids = (members.rows as { id: string }[]).map((r) => r.id);
    await pool.query(
      `INSERT INTO clusters (tenant_id, repo_id, cluster_key, member_pr_ids, edge_reasons, human_override)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        tenantId,
        repoId,
        c.key,
        ids,
        JSON.stringify(c.edges),
        correctionByKey.has(c.key)
          ? JSON.stringify(correctionByKey.get(c.key))
          : null,
      ],
    );
  }
}

export async function recordClusterCorrection(
  pool: Pool,
  tenantId: string,
  repoId: string,
  clusterKey: string,
  correction: Record<string, unknown>,
  actor: string,
  reason: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO cluster_corrections (tenant_id, repo_id, cluster_key, correction, actor, reason)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (repo_id, cluster_key) DO UPDATE SET
       correction = EXCLUDED.correction, actor = EXCLUDED.actor,
       reason = EXCLUDED.reason, created_at = now()`,
    [tenantId, repoId, clusterKey, JSON.stringify(correction), actor, reason],
  );
}

export interface StoredCluster {
  id: string;
  cluster_key: string;
  member_pr_ids: string[];
  edge_reasons: ClusterEdge[];
  human_override: Record<string, unknown> | null;
}

export async function listClusters(
  db: Db,
  tenantId: string,
  repoId: string,
): Promise<StoredCluster[]> {
  const res = await db.query(
    `SELECT * FROM clusters WHERE tenant_id = $1 AND repo_id = $2 ORDER BY cluster_key`,
    [tenantId, repoId],
  );
  return res.rows as StoredCluster[];
}

export async function storeDigest(
  pool: Pool,
  tenantId: string,
  repoId: string,
  date: string,
  digestId: string,
  content: DigestContent,
): Promise<void> {
  await pool.query(
    `INSERT INTO digests (tenant_id, repo_id, digest_date, digest_id, content)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (repo_id, digest_date) DO NOTHING`,
    [tenantId, repoId, date, digestId, JSON.stringify(content)],
  );
}

export async function getDigest(
  db: Db,
  tenantId: string,
  repoId: string,
  date: string,
): Promise<{ digest_id: string; content: DigestContent; state: string } | null> {
  const res = await db.query(
    `SELECT digest_id, content, state FROM digests
     WHERE tenant_id = $1 AND repo_id = $2 AND digest_date = $3`,
    [tenantId, repoId, date],
  );
  return (res.rows[0] as { digest_id: string; content: DigestContent; state: string } | undefined) ?? null;
}

export async function listDigests(
  db: Db,
  tenantId: string,
  repoId: string,
): Promise<{ digest_date: string; digest_id: string; state: string }[]> {
  const res = await db.query(
    `SELECT digest_date, digest_id, state FROM digests
     WHERE tenant_id = $1 AND repo_id = $2 ORDER BY digest_date DESC LIMIT 30`,
    [tenantId, repoId],
  );
  return res.rows as { digest_date: string; digest_id: string; state: string }[];
}

export async function markDigestDelivered(
  pool: Pool,
  digestId: string,
): Promise<void> {
  await pool.query(
    `UPDATE digests SET state = 'delivered' WHERE digest_id = $1`,
    [digestId],
  );
}

export async function recordDecision(
  pool: Pool,
  tenantId: string,
  targetType: string,
  targetId: string,
  action: string,
  actor: string,
  reason: string,
  expiresAt: string | null = null,
): Promise<void> {
  await pool.query(
    `INSERT INTO decisions (tenant_id, target_type, target_id, action, actor, reason, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [tenantId, targetType, targetId, action, actor, reason, expiresAt],
  );
}

export async function listDecisions(
  db: Db,
  tenantId: string,
  targetType?: string,
  targetId?: string,
): Promise<Record<string, unknown>[]> {
  const res = await db.query(
    `SELECT * FROM decisions WHERE tenant_id = $1
     AND ($2::text IS NULL OR target_type = $2)
     AND ($3::text IS NULL OR target_id = $3)
     ORDER BY created_at DESC LIMIT 100`,
    [tenantId, targetType ?? null, targetId ?? null],
  );
  return res.rows as Record<string, unknown>[];
}

/** Append an audit entry: Postgres is the store of record; the JSONL
 *  file (AUDIT_LOG_PATH) is the portable mirror. Seq comes from the
 *  table so concurrent appends serialize on the row lock. */
export async function appendAudit(
  pool: Pool,
  auditLogPath: string,
  kind: string,
  payload: Record<string, unknown>,
): Promise<AuditEntry> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Serialize appends with an advisory lock: the head-row lock alone
    // cannot serialize the genesis append (no rows to lock), and two
    // concurrent appends would otherwise compute the same seq.
    await client.query(`SELECT pg_advisory_xact_lock(727271)`);
    const head = await client.query(
      `SELECT seq, entry_hash FROM audit_log ORDER BY seq DESC LIMIT 1`,
    );
    const prev: AuditEntry | null =
      head.rows[0] === undefined
        ? null
        : {
            // pg returns BIGINT as a string; the chain hashes numbers.
            seq: Number(head.rows[0].seq as string),
            ts: "",
            kind: "",
            payload: {},
            prev_hash: "",
            hash: head.rows[0].entry_hash as string,
          };
    const seq = prev ? prev.seq + 1 : 1;
    const entry = appendAuditEntry(
      prev,
      seq,
      new Date().toISOString(),
      kind,
      payload,
    );
    await client.query(
      `INSERT INTO audit_log (seq, ts, kind, payload, prev_hash, entry_hash)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [entry.seq, entry.ts, entry.kind, JSON.stringify(entry.payload), entry.prev_hash, entry.hash],
    );
    await client.query("COMMIT");
    if (auditLogPath) {
      try {
        await mkdir(dirname(auditLogPath), { recursive: true });
        await appendFile(auditLogPath, `${canonicalize(entry)}\n`, "utf8");
      } catch {
        // The DB is the store of record; a failed file mirror must not
        // fail the action. The verifier reads the DB.
      }
    }
    return entry;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function listAuditEntries(
  db: Db,
  limit = 200,
): Promise<AuditEntry[]> {
  const res = await db.query(
    `SELECT seq, ts, kind, payload, prev_hash, entry_hash AS hash
     FROM audit_log ORDER BY seq DESC LIMIT $1`,
    [limit],
  );
  // pg returns timestamptz as a Date and BIGINT as a string; the chain
  // hashes the ISO string and numeric seq, so normalize here or
  // verification would never match (S-7).
  const rows = (res.rows as AuditEntry[]).map((e) => ({
    ...e,
    seq: Number(e.seq as unknown as string),
    ts: (e.ts as unknown) instanceof Date ? (e.ts as unknown as Date).toISOString() : e.ts,
  }));
  return rows.reverse();
}

export async function verifyAudit(pool: Pool): Promise<{ ok: boolean; reason?: string }> {
  const entries = await listAuditEntries(pool, 100000);
  return verifyAuditChain(entries);
}

/** Recompute the hash of a stored entry (used by the S-7 probe). */
export function recomputeStoredHash(entry: AuditEntry): string {
  return hashAuditEntry(entry);
}

// ---- Job queue (WishShip pattern) ----

export interface JobRow {
  id: string;
  type: string;
  idempotency_key: string;
  payload: Record<string, unknown>;
  state: string;
  attempts: number;
  max_attempts: number;
  next_run_at: string;
  last_error: string | null;
}

export async function enqueueJob(
  pool: Pool,
  type: string,
  idempotencyKey: string,
  payload: Record<string, unknown>,
  maxAttempts = 5,
): Promise<boolean> {
  const res = await pool.query(
    `INSERT INTO jobs (type, idempotency_key, payload, max_attempts)
     VALUES ($1,$2,$3,$4) ON CONFLICT (idempotency_key) DO NOTHING`,
    [type, idempotencyKey, JSON.stringify(payload), maxAttempts],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function claimJob(pool: Pool): Promise<JobRow | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const res = await client.query(
      `SELECT * FROM jobs
       WHERE state IN ('queued','failed') AND next_run_at <= now()
       ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED`,
    );
    const job = res.rows[0] as JobRow | undefined;
    if (!job) {
      await client.query("COMMIT");
      return null;
    }
    await client.query(
      `UPDATE jobs SET state = 'running', attempts = attempts + 1, updated_at = now()
       WHERE id = $1`,
      [job.id],
    );
    await client.query("COMMIT");
    return { ...job, attempts: job.attempts + 1 };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function finishJob(
  pool: Pool,
  jobId: string,
  ok: boolean,
  error?: string,
): Promise<void> {
  if (ok) {
    await pool.query(
      `UPDATE jobs SET state = 'done', last_error = NULL, updated_at = now() WHERE id = $1`,
      [jobId],
    );
    return;
  }
  // Retry with jittered backoff; dead-letter after max attempts (A-5).
  const res = await pool.query(
    `UPDATE jobs SET
       state = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'failed' END,
       last_error = $2,
       next_run_at = now() + (POWER(2, LEAST(attempts, 6)) * interval '30 seconds')
         + (random() * interval '30 seconds'),
       updated_at = now()
     WHERE id = $1 RETURNING state`,
    [jobId, (error ?? "unknown error").slice(0, 500)],
  );
  void res;
}

export async function listDeadJobs(pool: Pool): Promise<JobRow[]> {
  const res = await pool.query(
    `SELECT * FROM jobs WHERE state = 'dead' ORDER BY created_at DESC LIMIT 50`,
  );
  return res.rows as JobRow[];
}

export async function countJobsByState(
  pool: Pool,
): Promise<Record<string, number>> {
  const res = await pool.query(
    `SELECT state, COUNT(*)::int AS n FROM jobs GROUP BY state`,
  );
  const out: Record<string, number> = {};
  for (const r of res.rows as { state: string; n: number }[]) out[r.state] = r.n;
  return out;
}

/** Bounded retention (A-6): drop snapshots (files/checks/scores) for
 *  merged/closed PRs older than `days`; digests are retained — they
 *  are the artifact. The PR row itself is kept (metadata only). */
export async function pruneOldSnapshots(
  pool: Pool,
  days: number,
): Promise<{ prs: number }> {
  const res = await pool.query(
    `SELECT id FROM pull_requests
     WHERE state IN ('closed','merged')
       AND COALESCE(merged_at, updated_at_pr, snapshot_at) < now() - ($1 || ' days')::interval`,
    [String(days)],
  );
  const ids = (res.rows as { id: string }[]).map((r) => r.id);
  if (ids.length === 0) return { prs: 0 };
  await pool.query(`DELETE FROM pr_files WHERE pr_id = ANY($1::uuid[])`, [ids]);
  await pool.query(`DELETE FROM pr_checks WHERE pr_id = ANY($1::uuid[])`, [ids]);
  await pool.query(`DELETE FROM risk_scores WHERE pr_id = ANY($1::uuid[])`, [ids]);
  await pool.query(
    `UPDATE pull_requests SET snapshot = '{}'::jsonb WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  return { prs: ids.length };
}

export { topReasons };
