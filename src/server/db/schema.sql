-- Headgate schema (Postgres 16+). Applied idempotently on boot.
-- Tenancy is app-layer scoping: every row carries tenant_id and every
-- query filters on it. There is no row-level security in v1 (stated
-- honestly in the README); the tenant filter is the boundary.

CREATE TABLE IF NOT EXISTS tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  installation_id BIGINT NOT NULL UNIQUE,
  account_login TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS repos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  full_name TEXT NOT NULL,
  digest_hour INT NOT NULL DEFAULT 9,
  -- The sensitive-path list is the only per-repo score config in v1.
  -- Score weights are fixed (see src/server/scorer.ts).
  sensitive_paths TEXT[] NOT NULL DEFAULT '{}',
  -- Agent branch prefixes that imply related work for clustering (F4).
  -- NULL or empty means the built-in default allowlist
  -- (see src/server/cluster.ts DEFAULT_AGENT_BRANCH_PREFIXES).
  agent_branch_prefixes TEXT[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, full_name)
);
-- Idempotent on boot: existing databases gain the column (migrate()
-- re-runs this file on every boot).
ALTER TABLE repos ADD COLUMN IF NOT EXISTS agent_branch_prefixes TEXT[];
CREATE INDEX IF NOT EXISTS repos_tenant_idx ON repos (tenant_id);

CREATE TABLE IF NOT EXISTS pull_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  repo_id UUID NOT NULL REFERENCES repos(id),
  number INT NOT NULL,
  author TEXT NOT NULL DEFAULT '',
  author_type TEXT NOT NULL DEFAULT 'User',
  is_bot BOOLEAN NOT NULL DEFAULT false,
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  base_sha TEXT NOT NULL DEFAULT '',
  head_sha TEXT NOT NULL DEFAULT '',
  head_branch TEXT NOT NULL DEFAULT '',
  base_branch TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','closed','merged')),
  diff_hash TEXT NOT NULL DEFAULT '',
  created_at_pr TIMESTAMPTZ,
  updated_at_pr TIMESTAMPTZ,
  merged_at TIMESTAMPTZ,
  linked_issues INT[] NOT NULL DEFAULT '{}',
  force_pushes INT NOT NULL DEFAULT 0,
  commits_after_touch INT NOT NULL DEFAULT 0,
  snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  snapshot_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, repo_id, number)
);
CREATE INDEX IF NOT EXISTS pull_requests_repo_state_idx
  ON pull_requests (repo_id, state);
CREATE INDEX IF NOT EXISTS pull_requests_author_idx
  ON pull_requests (repo_id, author);

CREATE TABLE IF NOT EXISTS pr_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pr_id UUID NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  additions INT NOT NULL DEFAULT 0,
  deletions INT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'modified',
  patch TEXT NOT NULL DEFAULT '',
  UNIQUE (pr_id, path)
);
CREATE INDEX IF NOT EXISTS pr_files_pr_idx ON pr_files (pr_id);

CREATE TABLE IF NOT EXISTS pr_checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pr_id UUID NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  conclusion TEXT,
  completed_at TIMESTAMPTZ,
  UNIQUE (pr_id, name)
);
CREATE INDEX IF NOT EXISTS pr_checks_pr_idx ON pr_checks (pr_id);

CREATE TABLE IF NOT EXISTS risk_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pr_id UUID NOT NULL REFERENCES pull_requests(id) ON DELETE CASCADE,
  score INT NOT NULL CHECK (score >= 0 AND score <= 100),
  band TEXT NOT NULL CHECK (band IN ('low','medium','high','critical')),
  signals JSONB NOT NULL DEFAULT '[]'::jsonb,
  scored_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS risk_scores_pr_idx ON risk_scores (pr_id, scored_at DESC);

CREATE TABLE IF NOT EXISTS clusters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  repo_id UUID NOT NULL REFERENCES repos(id),
  cluster_key TEXT NOT NULL,
  member_pr_ids UUID[] NOT NULL DEFAULT '{}',
  edge_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Human corrections (split/merge) recorded here; the next clustering
  -- run does not silently re-apply a corrected membership (D-5).
  human_override JSONB,
  formed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (repo_id, cluster_key)
);
CREATE INDEX IF NOT EXISTS clusters_repo_idx ON clusters (repo_id);

-- Human cluster corrections (split/merge) that survive re-clustering.
-- Keyed by the cluster_key they were made against; a correction
-- persists until the cluster membership changes underneath it (D-5) —
-- a changed membership produces a new cluster_key, so the old
-- correction no longer matches and the fresh cluster is formed by the
-- rules again. The corrections table is never wiped by reclusterRepo.
CREATE TABLE IF NOT EXISTS cluster_corrections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  repo_id UUID NOT NULL REFERENCES repos(id),
  cluster_key TEXT NOT NULL,
  correction JSONB NOT NULL,
  actor TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (repo_id, cluster_key)
);

-- The digest is the artifact: stored, versioned, id-addressed, immutable
-- once issued. digest_id is the SHA-256 of the canonical digest/1
-- content (see src/server/digest.ts); rebuilding from stored snapshots
-- reproduces the identical id (D-4).
CREATE TABLE IF NOT EXISTS digests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  repo_id UUID NOT NULL REFERENCES repos(id),
  digest_date DATE NOT NULL,
  format TEXT NOT NULL DEFAULT 'digest/1',
  digest_id TEXT NOT NULL UNIQUE,
  content JSONB NOT NULL,
  state TEXT NOT NULL DEFAULT 'issued' CHECK (state IN ('issued','delivered')),
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (repo_id, digest_date)
);
CREATE INDEX IF NOT EXISTS digests_repo_date_idx ON digests (repo_id, digest_date DESC);

-- Human decisions: the queue-action record (reviewed/snoozed/assigned/
-- escalated/split/merged per cluster; remove/snooze/assign per PR).
CREATE TABLE IF NOT EXISTS decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  target_type TEXT NOT NULL CHECK (target_type IN ('cluster','pr','digest')),
  target_id TEXT NOT NULL,
  action TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  -- Snooze expiry: a snoozed PR/cluster returns to the digest after this
  -- timestamp. NULL for actions that do not expire.
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS decisions_target_idx ON decisions (target_type, target_id, created_at DESC);

-- Hash-chained audit log (Vouchard/Successor pattern). Tamper-evidence,
-- not tamper-proofing: a full-store rewrite is undetectable without an
-- off-box checkpoint, and the README says so. Entries are also mirrored
-- to a JSONL file (AUDIT_LOG_PATH) for portable export.
CREATE TABLE IF NOT EXISTS audit_log (
  seq BIGINT PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind TEXT NOT NULL,
  payload JSONB NOT NULL,
  prev_hash TEXT NOT NULL,
  entry_hash TEXT NOT NULL
);

-- Head anchor for the audit chain (B6): the latest seq + entry hash,
-- updated in the same transaction as each append. verifyAudit compares
-- the chain's head against it, so deleting the head (or the last N)
-- entries fails verification as "truncated". Without an off-box
-- checkpoint a coordinated rewrite of chain + anchor is still
-- undetectable — the README says so.
CREATE TABLE IF NOT EXISTS audit_head (
  id INT PRIMARY KEY CHECK (id = 1),
  seq BIGINT NOT NULL,
  entry_hash TEXT NOT NULL
);
-- Backfill for stores created before the anchor existed: seed it from
-- the current chain head. Appends upsert the row afterwards, so a
-- concurrent append cannot leave a stale anchor (the upsert wins, or
-- the row already exists and this is a no-op).
INSERT INTO audit_head (id, seq, entry_hash)
  SELECT 1, seq, entry_hash FROM audit_log ORDER BY seq DESC LIMIT 1
  ON CONFLICT (id) DO NOTHING;

-- Webhook delivery dedup: one row per GitHub delivery id. A replayed
-- delivery inserts nothing and is not re-processed (S-1, S-9, A-3).
CREATE TABLE IF NOT EXISTS deliveries (
  delivery_id TEXT PRIMARY KEY,
  event TEXT NOT NULL DEFAULT '',
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- DB-backed job queue (WishShip/Filliz pattern). Idempotency key makes
-- enqueueing the same logical job twice a no-op.
CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  state TEXT NOT NULL DEFAULT 'queued'
    CHECK (state IN ('queued','running','done','failed','dead')),
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 5,
  next_run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jobs_claim_idx
  ON jobs (state, next_run_at) WHERE state IN ('queued','failed');
