// Smoke: start the server with the fake GitHub client, seed fake PRs,
// POST signed webhook deliveries for them, and verify snapshot + score
// + cluster + digest + audit log through the API. No real GitHub
// credentials are used anywhere.
//
// Usage: npm run build:server && npm run smoke
//   (uses DATABASE_URL or the headgate dev default; NODE_ENV=development)

import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";

const PORT = Number(process.env.SMOKE_PORT ?? "3456");
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = "smoke-webhook-secret";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? "smoke-admin-token";
const INSTALLATION = 4242;
const RUN_ID = Date.now().toString(36);
const REPO = `acme/smoke-${RUN_ID}`;
const DATE = new Date().toISOString().slice(0, 10);

function sign(body) {
  return `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
}

async function req(path, init = {}) {
  // F1: every /api/* route except /api/health needs the operator token.
  const headers = { ...(init.headers ?? {}) };
  if (path.startsWith("/api/") && path !== "/api/health") {
    headers.authorization = `Bearer ${ADMIN_TOKEN}`;
  }
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  const text = await res.text();
  let body = {};
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body };
}

function check(cond, msg) {
  if (!cond) throw new Error(`SMOKE FAIL: ${msg}`);
  console.log(`  ok: ${msg}`);
}

async function main() {
  const env = {
    ...process.env,
    PORT: String(PORT),
    HOST: "127.0.0.1",
    NODE_ENV: "development",
    GITHUB_CLIENT: "fake",
    GITHUB_WEBHOOK_SECRET: SECRET,
    ADMIN_TOKEN,
    DATABASE_URL:
      process.env.DATABASE_URL ??
      "postgres://headgate:headgate-dev@127.0.0.1:5432/headgate",
    AUDIT_LOG_PATH: "data/smoke-audit.jsonl",
  };
  const child = spawn("node", ["dist/server/index.js"], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d.toString()));
  child.stderr.on("data", (d) => (out += d.toString()));
  const stop = async () => {
    child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 500));
  };

  try {
    let up = false;
    for (let i = 0; i < 40; i++) {
      try {
        const h = await req("/api/health");
        if (h.status === 200 && h.body.ok) {
          up = true;
          break;
        }
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    check(up, `server up on ${PORT}`);

    // Seed two fake PRs that share a file (one cluster) via the
    // dev-only seed endpoint (fake client only).
    for (const n of [7, 8]) {
      const seed = await req("/api/dev/seed-pr", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          installation_id: INSTALLATION,
          repo: REPO,
          pr: {
            number: n,
            title: n === 7 ? "Add login flow" : "Add login flow (retry)",
            body: "Fixes #42",
            author: "devin-bot",
            authorType: "Bot",
            isBot: true,
            headBranch: `devin/${n}-login`,
            baseBranch: "main",
            state: "open",
            createdAt: "2026-11-19T08:00:00Z",
            updatedAt: "2026-11-19T08:00:00Z",
            linkedIssues: [42],
            url: `https://github.com/${REPO}/pull/${n}`,
          },
          files: [
            { path: "src/auth/login.ts", additions: 120, deletions: 10, patch: "+const x = 1;\n" },
            { path: "src/shared.ts", additions: 20, deletions: 0, patch: "" },
          ],
          checks: [{ name: "ci", status: "completed", conclusion: "success" }],
        }),
      });
      check(seed.status === 200, `seed PR #${n}`);
    }

    // Webhook surface: bad signature -> 401; valid -> 202; replay -> deduped.
    const payloadFor = (n) =>
      JSON.stringify({
        action: "opened",
        installation: { id: INSTALLATION, account: { login: "acme" } },
        repository: { full_name: REPO },
        pull_request: { number: n },
      });
    const bad = await fetch(`${BASE}/webhooks/github`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "smoke-bad",
        "x-github-event": "pull_request",
        "x-hub-signature-256": "sha256=deadbeef",
      },
      body: payloadFor(7),
    });
    check(bad.status === 401, "wrong HMAC -> 401");

    for (const n of [7, 8]) {
      const body = payloadFor(n);
      const first = await fetch(`${BASE}/webhooks/github`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-delivery": `smoke-${RUN_ID}-${n}`,
          "x-github-event": "pull_request",
          "x-hub-signature-256": sign(body),
        },
        body,
      });
      check(first.status === 202, `signed delivery for PR #${n} -> 202`);
      const replay = await fetch(`${BASE}/webhooks/github`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-delivery": `smoke-${RUN_ID}-${n}`,
          "x-github-event": "pull_request",
          "x-hub-signature-256": sign(body),
        },
        body,
      });
      const replayBody = await replay.json();
      check(replay.status === 200 && replayBody.deduped === true, `replay of PR #${n} deduped`);
    }

    // Wait for the worker to ingest both PRs (snapshot + score +
    // cluster). N11: poll until cluster membership settles, not just
    // scores — the cluster job runs after scoring, so reading the
    // queue as soon as both PRs are scored can catch PR 8 scored but
    // not yet clustered in.
    let queue = null;
    for (let i = 0; i < 80; i++) {
      const q = await req(`/api/queue?installation_id=${INSTALLATION}&repo=${encodeURIComponent(REPO)}`);
      if (
        q.status === 200 &&
        q.body.prs?.length === 2 &&
        q.body.prs.every((p) => p.score !== null) &&
        q.body.clusters?.length === 1 &&
        q.body.clusters[0].members.length === 2
      ) {
        queue = q.body;
        break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    check(queue !== null, "worker ingested both PRs with scores");
    check(queue.clusters.length === 1, `one cluster formed (got ${queue.clusters.length})`);
    check(
      queue.clusters[0].members.length === 2,
      `cluster holds both PRs (got ${queue.clusters[0].members.join(",")})`,
    );

    // Build + fetch the digest.
    const build = await req("/api/digest/build", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ installation_id: INSTALLATION, repo: REPO, date: DATE }),
    });
    check(build.status === 200 && build.body.created === true, "digest issued");
    const get = await req(
      `/api/digest?installation_id=${INSTALLATION}&repo=${encodeURIComponent(REPO)}&date=${DATE}`,
    );
    check(get.status === 200, "digest fetchable via API");
    check(get.body.digest_id === build.body.digest_id, "digest id matches build");
    check(get.body.content.clusters.length === 1, "digest has one cluster");
    check(
      get.body.content.clusters[0].member_prs.length === 2,
      "digest cluster has both PRs",
    );
    check(
      get.body.content.stats.open_prs === 2,
      `digest stats count 2 open PRs (got ${get.body.content.stats.open_prs})`,
    );

    // Audit log verifies.
    const verify = await req("/api/audit/verify");
    check(verify.status === 200 && verify.body.ok === true, "audit chain verifies");
    const audit = await req(`/api/audit?installation_id=${INSTALLATION}&limit=50`);
    check(audit.status === 200 && audit.body.entries.length >= 3, "audit log has entries");

    console.log("Smoke OK: webhook, ingestion, scoring, clustering, digest, audit.");
  } finally {
    await stop();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
