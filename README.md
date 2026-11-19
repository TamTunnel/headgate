// Copyright 2026 TamTunnel. Licensed under the Apache License, Version 2.0.
// SPDX-License-Identifier: Apache-2.0

# Headgate

**PR triage for agent fleets.**

## The problem, in layman's terms

Your coding agents now open more pull requests in a week than your team can read in a month. One tester went from 50 PRs a week to 1,900. Each PR still arrives alone, in the same queue, demanding the same human attention — and a quarter of them conflict with each other, a third of them get accepted (down from 84% for human PRs), and the rest wait five times longer than a human's PR to even get picked up. The team does not have a review problem. It has a queue problem: it cannot tell which of the 1,900 PRs matter, which six are the same change filed six times, and which one touches the payment code.

## The solution, in layman's terms

Headgate watches your repositories and groups the flood. PRs that touch the same files, implement the same ticket, or say the same thing become one cluster — one decision instead of six. Every PR gets a risk score computed from plain, checkable facts (how big is it, does it touch sensitive code, are the tests green, does it conflict with another open PR), and the score always shows its reasons. Once a day you get one digest: the riskiest clusters first, the safe ones at the bottom, each with a one-line summary and links. You work the list, mark clusters reviewed, snooze the ones that can wait — and the queue drains. Headgate never approves anything, never merges anything, and never writes a review. It only decides what you look at first.

## What it is — and what it is not

- **The digest is the product.** One ordered list a day, stored as a versioned `digest/1` artifact with a SHA-256 id, that a human can work through in an hour.
- **The risk score is deterministic and explainable.** Every point lists its reason. There is no LLM anywhere in scoring, reviewing, or summarizing — an LLM's "risky" cannot be audited, and the score's auditability is the point.
- **Headgate never writes to GitHub in v1.** No approvals, no merges, no comments, no labels. "Reviewed" in Headgate means "a human worked this cluster" — it is a queue state, not a GitHub state.
- **Human decisions are recorded, not just applied.** Every queue action goes into a hash-chained audit log.

## Quick start

### Prerequisites

- Node 24+, npm
- Postgres 16+

### 1. Install and configure

```sh
git clone https://github.com/TamTunnel/headgate.git
cd headgate
npm ci
cp .env.example .env   # then fill in the values below
```

Required environment:

| Variable | Meaning |
|---|---|
| `DATABASE_URL` | Postgres connection string, e.g. `postgres://headgate:headgate-dev@127.0.0.1:5432/headgate` |
| `GITHUB_WEBHOOK_SECRET` | Shared secret for webhook HMAC verification (set the same value in the GitHub App) |
| `ADMIN_TOKEN` | Operator token: required on every `/api/*` route except `/api/health` (send as `Authorization: Bearer …` or `X-Headgate-Admin`). Required in production; in development it defaults to a dev-only value |
| `GITHUB_APP_ID` | GitHub App id |
| `GITHUB_APP_PRIVATE_KEY` | GitHub App private key (PEM) |
| `GITHUB_APP_SLUG` | App slug, default `headgate` |

Optional:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` / `HOST` | `3000` / `127.0.0.1` | Listen address. The default binds localhost only; a non-localhost bind needs a reverse proxy in front, because the API is operator-only |
| `BASE_URL` | `http://localhost:3000` | Public URL, used in digest links |
| `DIGEST_HOUR` | `9` | Hour the daily digest is built |
| `RETENTION_DAYS` | `30` | Snapshot retention for merged/closed PRs |
| `AUDIT_LOG_PATH` | `data/audit.jsonl` | JSONL mirror of the hash-chained audit log |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | — | Pluggable SMTP for digest email (unset = no email; the web UI alone is a complete product) |
| `DIGEST_RECIPIENTS` | — | Comma-separated email recipients for the daily digest |

### 2. Create the database

```sh
# as the postgres superuser:
createuser -P headgate        # password: headgate-dev (dev only)
createdb -O headgate headgate
npm run db:reset              # drops the public schema; the server recreates it on boot
```

### 3. Install the GitHub App

Create the app from the manifest in `docs/github-app-manifest.json` (or create it manually in GitHub Settings → Developer settings → GitHub Apps). The app requests **read-only** permissions only:

- `pull_requests: read`
- `checks: read`
- `contents: read`
- `metadata: read`

No write scopes. The app cannot approve, merge, comment, or label anything — by permission, not just by policy. Set the webhook URL to `https://<your-host>/webhooks/github` and the webhook secret to `GITHUB_WEBHOOK_SECRET`.

Install the app on your org or repos.

### 4. Run

```sh
npm run build
npm start
```

Open `http://localhost:3000`. Pick the installation and repo, and work the digest.

### 5. Local development without GitHub

```sh
GITHUB_CLIENT=fake npm start
```

The fake client holds no PRs; seed them via the dev-only endpoint (registered only in fake mode):

```sh
curl -X POST localhost:3000/api/dev/seed-pr -H 'content-type: application/json' \
  -d '{"installation_id":1,"repo":"acme/app","pr":{"number":1,"title":"Add login","headBranch":"devin/1-login","linkedIssues":[42]},"files":[{"path":"src/auth/login.ts","additions":50,"deletions":0}],"checks":[{"name":"ci","conclusion":"success"}]}'
```

Then deliver a signed webhook (see `scripts/smoke.mjs` for the signing code) or run the smoke script:

```sh
npm run smoke
```

## Architecture

One self-hosted service: Fastify API + React/Vite dashboard + workers in a single Node process. Postgres holds everything. The only network traffic is GitHub's API and webhooks (inbound) and SMTP (outbound, operator-configured). No telemetry.

```
GitHub webhooks ──► /webhooks/github ──► deliveries (dedup by delivery id)
                        │  HMAC SHA-256 verified; bad signature -> 401, never enqueued
                        ▼
                   jobs (DB queue) ──► worker ──► GitHub API (diffs, files, checks)
                        │                              │  installation token: memory only
                        ▼                              ▼
                   pull_requests (snapshot) ──► risk_scores (deterministic)
                        │                              │
                        └──────► clusters ──► digests (digest/1, SHA-256 id)
                                                      │
                                    dashboard ◄───────┤
                                    email (SMTP) ◄────┘
                   human actions ──► decisions + audit_log (hash-chained)
```

### Components

- **GitHub App + webhook receiver** (`src/server/webhook.ts`, `routes.ts`). Events: `pull_request`, `pull_request_review`, `check_run`, `check_suite`, `push`. Every delivery is verified by HMAC SHA-256 against the webhook secret, deduplicated by delivery id, and enqueued as a job. Installation tokens are fetched per job, held in memory only, never logged, never stored.
- **Ingestion worker** (`src/server/worker.ts`). Consumes webhook jobs: fetches the PR snapshot (number, title, body, author + author type, bot identity, base/head SHAs, state, linked issues), the file list, and the check state. Upserts are idempotent on (installation, repo, PR number); a duplicate delivery produces no second snapshot. A backfill job reconciles open PRs against the API to repair missed deliveries.
- **Risk scorer** (`src/server/scorer.ts`). Pure deterministic function over a snapshot + repo context. Score 0–100 + band (low / medium / high / critical). Signals, each with a fixed weight, each recorded with points + evidence: size (log-scaled, capped), blast radius (sensitive paths — the only per-repo config), test status, author fleet (bot baseline, first PR, prior reverts), overlap (shared files/issues), churn, staleness (capped), duplication (near-identical diff), static (deterministic regex pattern checks: new subprocess/shell exec, new network calls, credential handling, dependency additions). Weights are fixed in v1. The signals always sum exactly to the total (a `clamp` signal carries any clamping difference). No LLM anywhere.
- **Clusterer** (`src/server/cluster.ts`). Graph over open PRs: Jaccard ≥ 0.5 on changed-file sets, same linked issue/ticket, same head-branch lineage (identical branch, or a shared prefix that is a known agent prefix — `devin/`, `cursor/`, `copilot/`, `codex/`, `agent/`, `sweep/` by default, overridable per repo in `repos.agent_branch_prefixes`; `feature/*` and `dependabot/*` never count), near-identical diff hash. Connected components are clusters; singletons are clusters of one. Deterministic regardless of ingestion order. Human split/merge corrections persist in `cluster_corrections` until the cluster membership changes underneath them.
- **Digest builder** (`src/server/digest.ts`, `digestBuild.ts`). Once a day per repo, builds one `digest/1` record: clusters ordered by max risk desc, then member count desc, then oldest first (escalated clusters pin to the top). Each cluster gets a one-line summary assembled from member PR titles (first title + "and N more" — no LLM). The digest id is the SHA-256 of the canonical content; rebuilding from stored snapshots reproduces the identical id. Immutable once issued. Every open agent PR appears in the digest or in an explicit `excluded` list with a reason.
- **Web UI** (`client/`). Today's digest (ordered clusters, risk bands, reasons, member PRs, CI state), the live queue, per-cluster actions, and the audit log view.
- **Human action surface** (`routes.ts`). Per cluster: reviewed, snooze, assign, escalate, split, merge. Per PR: remove from cluster, snooze, assign. Headgate-side state only — nothing posts to GitHub.
- **Audit log** (`src/server/audit.ts`, `store.ts`). Hash-chained JSONL (Vouchard/Successor pattern): every ingestion decision that changes queue state and every human action, each entry chained to the previous hash. Stored in Postgres and mirrored to `AUDIT_LOG_PATH`. The Postgres chain is the store of record; the JSONL mirror is best-effort and is never verified — a tampered or diverged mirror is undetectable, so do not rely on the file as the tamper-evidence source.
- **Email sender** (`src/server/email.ts`). Pluggable SMTP (nodemailer). HTML + plain text, metadata and links only — no code, no diffs, no secrets. Credential-shaped patterns in PR titles are redacted before rendering.

### Data model

- `tenants` — GitHub App installation id, account, install state. Every other row carries `tenant_id`.
- `repos` — (tenant, full_name), digest hour, sensitive-path list, agent-branch-prefix allowlist (clustering config).
- `pull_requests` — (tenant, repo, number): author, bot identity, title, body, SHAs, state, linked issues, snapshot JSON.
- `pr_files` — (pr, path): additions, deletions, status, patch.
- `pr_checks` — (pr, check name): status, conclusion.
- `risk_scores` — (pr, scored_at): score, band, signals JSON (each: name, points, evidence). History retained.
- `clusters` — (repo, cluster key): member PRs, edge reasons, human corrections.
- `cluster_corrections` — persistent split/merge corrections, keyed by cluster key.
- `digests` — (repo, date): `digest/1` record — id (SHA-256 of canonical content), ordered cluster list, state (issued/delivered).
- `decisions` — (cluster/pr/digest, actor, action, reason, expires_at).
- `audit_log` — hash-chained entries (seq, ts, kind, payload, prev_hash, entry_hash).
- `deliveries` — webhook delivery ids (dedup).
- `jobs` — DB-backed job queue: idempotency key, payload, attempts, state, next run at.

### Tenancy

App-layer scoping: every query filters by `tenant_id`. There is no row-level security in v1 (stated honestly). Cross-tenant reads return nothing because the tenant filter is on every query path. But the tenant filter is not the security boundary — `installation_id` is caller-supplied, so every `/api/*` route except `/api/health` also requires the operator `ADMIN_TOKEN` (`Authorization: Bearer …` or `X-Headgate-Admin`, compared in constant time). Without it, no tenant's data is readable or mutable at all. The service binds `127.0.0.1` by default; expose it beyond localhost only behind a reverse proxy.

## Honest limits

- **A risk score is a heuristic, not a verdict.** A 10-line diff can delete a database; a 5,000-line diff can be generated tests. The score orders attention; it never certifies safety. A low score is not permission to merge without reading, and a high score is not proof of a bug. The digest says this on every page.
- **Clustering can mis-group.** Two PRs touching the same files may be unrelated (a shared utility file); two PRs implementing the same ticket may touch disjoint files. The cluster view shows its edge reasons so a human can see *why* PRs were grouped — and can split them. A cluster is a suggestion, not a fact.
- **The digest is stale by construction.** A PR opened after the daily digest waits until tomorrow — or until someone opens the live queue in the web UI. Daily is the right default for a digest (more frequent would recreate the flood), but Headgate is not a real-time alerting tool and must not be sold as one.
- **GitHub-only in v1.** Teams on GitLab or Bitbucket cannot use it. The ingestion layer is behind an interface (`GitHubClient`) so a second forge is a new adapter, not a rewrite.
- **The score can be gamed by the fleet.** An agent that splits one change into ten small PRs lowers each PR's size signal. The overlap and duplication signals exist to catch exactly that — but a determined agent (or a fleet tuned to the score) can still shape its output to look low-risk. The score is triage, not a security boundary; treat any claim otherwise as a bug.
- **The digest is only as good as CI.** A repo with no CI gets a weaker score (no test signal) and the digest says so. Headgate does not run tests itself and never will in v1 — importing test execution would import the sandbox problem (executing untrusted PR code) for no benefit.
- **Agent PRs must be identifiable.** The fleet signals depend on bot-authored PRs being recognizable as such. A fleet that opens PRs under a human's account (or a human who pastes agent output) defeats the author signal. The score degrades gracefully (other signals still apply), but PRs whose authorship is ambiguous are flagged by the bot signal being absent.
- **Audit log is tamper-evident, not tamper-proof — the Postgres chain only.** A full-store rewrite is undetectable without an off-box checkpoint. The chain catches edits to individual entries, not a wholesale replacement of the store. The JSONL mirror is best-effort and is never verified, so it carries no tamper evidence: a tampered or diverged mirror still verifies `ok`.
- **No compliance claims.** No SOC 2 / HIPAA / GDPR claims in v1. The service stores PR metadata (titles, bodies, file lists) — understand that before installing it on a private repo. No telemetry in v1.

## Naming note

The product was first briefed as **Floodgate**. That name is taken three ways — floodgate.com belongs to a prominent seed VC in the exact tech ecosystem, a live same-name SaaS exists in fundraising, and the bare npm name is taken — so it was not built under that name. The architect's recommended replacement was **Sluicegate**; P picked **Headgate** (2026-11-19). headgate.com is registered (1995, easyDNS) but parked/dead — no product serves under it; for open source the repo name + npm scope are the identity. The repo is `TamTunnel/headgate`. The digest is triage, not review.

## Repo best practices

- `main` is the only long-lived branch; work lands via reviewed PRs.
- `npm test` runs the full suite (unit + integration against real Postgres) — it must be green before any merge. `npm run typecheck` and `npm run lint` likewise.
- Build output lives in `dist/` only. Never commit compiled `.js`/`.d.ts` next to `.ts` sources — `npm run lint` fails if any exist.
- `ASSESSMENT.md`, `REVIEW.md`, `JUDGE.md` are gate files: they are gitignored and never ship.
- Secrets go in `.env` (gitignored) or the deployment's secret store — never in code, never in git history.
- Never execute PR code: Headgate reads diffs through the GitHub API only.

## FAQs

**Does Headgate review my code?**
No. It triages: it clusters related PRs, scores them deterministically, and orders one daily digest. Review is a human's job (or a reviewer's — CodeRabbit, Copilot, and friends do that; Headgate does not compete with them).

**Does Headgate merge or approve PRs?**
No. It has no write permissions on GitHub at all. "Reviewed" in Headgate is a queue state, not a GitHub state.

**Why no LLM?**
The score's auditability is the point. An LLM's "risky" cannot be audited; a deterministic score with every point explained can. An LLM reviewer "for the hard cases" would collapse the differentiation to zero.

**What happens if a webhook delivery is lost?**
The nightly backfill job reconciles open PRs against the GitHub API and repairs missed deliveries. Duplicate deliveries are deduplicated by delivery id.

**What happens when GitHub's API rate limit is hit?**
Ingestion backs off: jobs retry with jittered backoff, rate-limit errors re-queue with a 15-minute delay, and the digest marks any PR whose snapshot is older than 24 hours as stale instead of failing.

**Can I use it for GitLab?**
Not in v1. The ingestion layer is behind the `GitHubClient` interface; a second forge is a new adapter, not a rewrite.

**How do I run it for multiple orgs?**
Install the GitHub App on each org. Each installation is a tenant; every query is scoped by tenant. Multi-tenant *hosting* (one operator serving many orgs as a service) is the open-core paid tier and is out of v1 — v1 is self-hosted, one operator.

## License

Apache 2.0. See [LICENSE](LICENSE).
