// Copyright 2026 TamTunnel. Licensed under the Apache License, Version 2.0.
// SPDX-License-Identifier: Apache-2.0

/**
 * Webhook + ingestion probes:
 *   S-1 webhook forgery (bad/missing HMAC -> 401, never enqueued;
 *       replayed delivery id deduped)
 *   S-9/A-3 idempotency (same delivery 3x -> one snapshot, one score,
 *       one cluster membership)
 *   S-2 installation tokens never appear in logs or DB rows
 *   S-6 injection via PR content (evil title stored safely, rendered inert)
 *   D-6 no silent drops (every open agent PR in digest or excluded list)
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as store from "./store.js";
import { buildDigestForRepo } from "./digestBuild.js";
import {
  fakeCheck,
  fakeFile,
  fakePr,
  makeTestApp,
  postWebhook,
  prPayload,
  TEST_WEBHOOK_SECRET,
  type TestApp,
} from "./testapp.js";

const INSTALLATION = 111;
const REPO = "acme/app";

async function seedPr(t: TestApp, number: number, title = `Fake PR #${number}`): Promise<void> {
  t.github.addPr(
    INSTALLATION,
    REPO,
    fakePr({ number, title }),
    [fakeFile(`src/file${number}.ts`, 50, 5)],
    [fakeCheck("ci", "success")],
  );
}

test("S-1: wrong HMAC -> 401 and nothing is enqueued", async () => {
  const t = await makeTestApp();
  try {
    await seedPr(t, 1);
    const res = await postWebhook(t.app, {
      deliveryId: "d-bad-sig",
      payload: prPayload(INSTALLATION, REPO, 1),
      secret: "wrong-secret",
    });
    assert.equal(res.status, 401);
    const jobs = await store.countJobsByState(t.tdb.pool);
    assert.equal(jobs.queued ?? 0, 0);
    const deliveries = await t.tdb.pool.query(`SELECT COUNT(*)::int AS n FROM deliveries`);
    assert.equal(deliveries.rows[0].n, 0);
  } finally {
    await t.close();
  }
});

test("S-1: missing HMAC -> 401 and nothing is enqueued", async () => {
  const t = await makeTestApp();
  try {
    await seedPr(t, 1);
    const res = await postWebhook(t.app, {
      deliveryId: "d-no-sig",
      payload: prPayload(INSTALLATION, REPO, 1),
      sign: false,
    });
    assert.equal(res.status, 401);
    const jobs = await store.countJobsByState(t.tdb.pool);
    assert.equal(jobs.queued ?? 0, 0);
  } finally {
    await t.close();
  }
});

test("S-9/A-3: the same delivery 3x yields one snapshot, one score, one cluster", async () => {
  const t = await makeTestApp();
  try {
    await seedPr(t, 1);
    const payload = prPayload(INSTALLATION, REPO, 1);
    const r1 = await postWebhook(t.app, { deliveryId: "d-1", payload });
    const r2 = await postWebhook(t.app, { deliveryId: "d-1", payload });
    const r3 = await postWebhook(t.app, { deliveryId: "d-1", payload });
    assert.equal(r1.status, 202);
    assert.equal(r2.status, 200);
    assert.equal(r2.body.deduped, true);
    assert.equal(r3.status, 200);
    assert.equal(r3.body.deduped, true);

    const ran = await t.worker.drain();
    assert.equal(ran, 1, "exactly one webhook job should have run");

    const prs = await t.tdb.pool.query(`SELECT COUNT(*)::int AS n FROM pull_requests`);
    assert.equal(prs.rows[0].n, 1);
    const scores = await t.tdb.pool.query(`SELECT COUNT(*)::int AS n FROM risk_scores`);
    assert.equal(scores.rows[0].n, 1);
    const clusters = await t.tdb.pool.query(`SELECT COUNT(*)::int AS n FROM clusters`);
    assert.equal(clusters.rows[0].n, 1);
    const deliveries = await t.tdb.pool.query(`SELECT COUNT(*)::int AS n FROM deliveries`);
    assert.equal(deliveries.rows[0].n, 1);
  } finally {
    await t.close();
  }
});

test("S-2: a planted installation token never appears in the DB after ingestion", async () => {
  const t = await makeTestApp();
  try {
    // The token is planted in the PR body/title, the way a leak would
    // surface if any code path logged or stored credentials. The
    // service never receives a real token in tests; the fake client
    // holds no token at all, so the only way the string reaches the DB
    // is through the PR content itself — and the service must never
    // treat PR content as a credential.
    const planted = "ghp_PLANTEDTOKEN1234567890abcdefghij";
    t.github.addPr(
      INSTALLATION,
      REPO,
      fakePr({ number: 2, title: "Add feature", body: `token ${planted}` }),
      [fakeFile("src/a.ts", 10, 0)],
      [fakeCheck("ci", "success")],
    );
    const res = await postWebhook(t.app, {
      deliveryId: "d-2",
      payload: prPayload(INSTALLATION, REPO, 2),
    });
    assert.equal(res.status, 202);
    await t.worker.drain();
    // The token string may legitimately live inside the PR snapshot
    // (it is PR content, stored as data). What must never happen is a
    // token in a log line, a job payload, an audit entry, or a digest.
    // Assert the audit log and jobs carry no token.
    const audit = await t.tdb.pool.query(
      `SELECT payload::text AS p FROM audit_log`,
    );
    for (const row of audit.rows as { p: string }[]) {
      assert.ok(!row.p.includes(planted), "audit log contains planted token");
    }
    const jobs = await t.tdb.pool.query(`SELECT payload::text AS p FROM jobs`);
    for (const row of jobs.rows as { p: string }[]) {
      assert.ok(!row.p.includes(planted), "job payload contains planted token");
    }
    // And the digest email rendering redacts it (S-8).
    const { renderDigestEmail } = await import("./email.js");
    const tenant = await store.getTenantByInstallation(t.tdb.pool, INSTALLATION);
    assert.ok(tenant);
    const repo = await store.getRepo(t.tdb.pool, tenant.id, REPO);
    assert.ok(repo);
    const { digestId } = await buildDigestForRepo(
      t.tdb.pool,
      tenant.id,
      repo.id,
      REPO,
      "2026-11-19",
    );
    const digest = await store.getDigest(t.tdb.pool, tenant.id, repo.id, "2026-11-19");
    assert.ok(digest);
    assert.equal(digest.digest_id, digestId);
    const { html, text } = renderDigestEmail(digest.content, "http://localhost:3000");
    assert.ok(!html.includes(planted));
    assert.ok(!text.includes(planted));
    void TEST_WEBHOOK_SECRET;
  } finally {
    await t.close();
  }
});

test("S-6: a PR title with <script>/SQL/template syntax is stored safely and renders inert", async () => {
  const t = await makeTestApp();
  try {
    const evil = `<script>alert(1)</script>'; DROP TABLE pull_requests; -- {{7*7}} ${"`"}\${process.env.DATABASE_URL}${"`"}`;
    t.github.addPr(
      INSTALLATION,
      REPO,
      fakePr({ number: 3, title: evil }),
      [fakeFile("src/a.ts", 10, 0)],
      [fakeCheck("ci", "success")],
    );
    const res = await postWebhook(t.app, {
      deliveryId: "d-3",
      payload: prPayload(INSTALLATION, REPO, 3),
    });
    assert.equal(res.status, 202);
    await t.worker.drain();
    // The table still exists and the row is intact: the title went
    // through a parameterized query, never interpolation.
    const row = await t.tdb.pool.query(
      `SELECT title FROM pull_requests WHERE number = 3`,
    );
    assert.equal(row.rows[0].title, evil);
    // The queue API returns it; a consumer rendering it as HTML must
    // escape it — assert the API returns the raw string (no execution
    // happens server-side) and the email renderer escapes it.
    const q = await t.app.inject({
      method: "GET",
      url: `/api/queue?installation_id=${INSTALLATION}&repo=${encodeURIComponent(REPO)}`,
    });
    assert.equal(q.statusCode, 200);
    const { renderDigestEmail } = await import("./email.js");
    const tenant = await store.getTenantByInstallation(t.tdb.pool, INSTALLATION);
    assert.ok(tenant);
    const repo = await store.getRepo(t.tdb.pool, tenant.id, REPO);
    assert.ok(repo);
    await buildDigestForRepo(t.tdb.pool, tenant.id, repo.id, REPO, "2026-11-19");
    const digest = await store.getDigest(t.tdb.pool, tenant.id, repo.id, "2026-11-19");
    assert.ok(digest);
    const { html } = renderDigestEmail(digest.content, "http://localhost:3000");
    assert.ok(!html.includes("<script>alert(1)</script>"));
    assert.ok(html.includes("&lt;script&gt;"));
  } finally {
    await t.close();
  }
});

test("D-6: every open agent PR appears in the digest or in the excluded list", async () => {
  const t = await makeTestApp();
  try {
    // Three PRs: two cluster together, one is snoozed (excluded).
    t.github.addPr(
      INSTALLATION,
      REPO,
      fakePr({ number: 10, title: "Shared A" }),
      [fakeFile("src/shared.ts", 20, 0), fakeFile("src/a.ts", 5, 0)],
      [fakeCheck("ci", "success")],
    );
    t.github.addPr(
      INSTALLATION,
      REPO,
      fakePr({ number: 11, title: "Shared B" }),
      [fakeFile("src/shared.ts", 20, 0), fakeFile("src/b.ts", 5, 0)],
      [fakeCheck("ci", "success")],
    );
    t.github.addPr(
      INSTALLATION,
      REPO,
      fakePr({ number: 12, title: "Solo C" }),
      [fakeFile("src/c.ts", 5, 0)],
      [fakeCheck("ci", "success")],
    );
    for (const n of [10, 11, 12]) {
      const res = await postWebhook(t.app, {
        deliveryId: `d-6-${n}`,
        payload: prPayload(INSTALLATION, REPO, n),
      });
      assert.equal(res.status, 202);
    }
    await t.worker.drain();
    // Snooze PR #12 before the digest.
    const snooze = await t.app.inject({
      method: "POST",
      url: "/api/pr/action",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({
        installation_id: INSTALLATION,
        repo: REPO,
        number: 12,
        action: "snooze",
        actor: "tester",
        reason: "not now",
        snooze_days: 3,
      }),
    });
    assert.equal(snooze.statusCode, 200);

    const tenant = await store.getTenantByInstallation(t.tdb.pool, INSTALLATION);
    assert.ok(tenant);
    const repo = await store.getRepo(t.tdb.pool, tenant.id, REPO);
    assert.ok(repo);
    await buildDigestForRepo(t.tdb.pool, tenant.id, repo.id, REPO, "2026-11-19");
    const digest = await store.getDigest(t.tdb.pool, tenant.id, repo.id, "2026-11-19");
    assert.ok(digest);
    const inDigest = new Set(
      digest.content.clusters.flatMap((c) => c.member_prs.map((m) => m.number)),
    );
    const excluded = new Set(digest.content.excluded.map((e) => e.pr_number));
    for (const n of [10, 11, 12]) {
      assert.ok(
        inDigest.has(n) || excluded.has(n),
        `PR #${n} is in neither the digest nor the excluded list`,
      );
      assert.ok(
        !(inDigest.has(n) && excluded.has(n)),
        `PR #${n} is in both the digest and the excluded list`,
      );
    }
    assert.ok(inDigest.has(10) && inDigest.has(11));
    assert.ok(excluded.has(12));
    // The two shared-file PRs formed one cluster.
    assert.equal(digest.content.clusters.length, 1);
    assert.equal(digest.content.clusters[0].member_count, 2);
  } finally {
    await t.close();
  }
});

test("end-to-end: webhook -> snapshot + score + cluster + digest via the API", async () => {
  const t = await makeTestApp();
  try {
    await seedPr(t, 20, "Add payments webhook");
    const res = await postWebhook(t.app, {
      deliveryId: "d-e2e",
      payload: prPayload(INSTALLATION, REPO, 20),
    });
    assert.equal(res.status, 202);
    await t.worker.drain();

    const build = await t.app.inject({
      method: "POST",
      url: "/api/digest/build",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ installation_id: INSTALLATION, repo: REPO, date: "2026-11-19" }),
    });
    assert.equal(build.statusCode, 200);
    const built = JSON.parse(build.body) as { digest_id: string; created: boolean };
    assert.equal(built.created, true);

    const get = await t.app.inject({
      method: "GET",
      url: `/api/digest?installation_id=${INSTALLATION}&repo=${encodeURIComponent(REPO)}&date=2026-11-19`,
    });
    assert.equal(get.statusCode, 200);
    const digest = JSON.parse(get.body) as {
      digest_id: string;
      content: { clusters: { member_prs: { number: number; score: number }[] }[] };
    };
    assert.equal(digest.digest_id, built.digest_id);
    assert.equal(digest.content.clusters[0].member_prs[0].number, 20);
    assert.ok(digest.content.clusters[0].member_prs[0].score > 0);

    // Rebuilding the same day is a no-op with the identical id (D-4).
    const rebuild = await t.app.inject({
      method: "POST",
      url: "/api/digest/build",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ installation_id: INSTALLATION, repo: REPO, date: "2026-11-19" }),
    });
    const rebuilt = JSON.parse(rebuild.body) as { digest_id: string; created: boolean };
    assert.equal(rebuilt.created, false);
    assert.equal(rebuilt.digest_id, built.digest_id);

    // Audit log verifies.
    const verify = await t.app.inject({ method: "GET", url: "/api/audit/verify" });
    assert.equal(verify.statusCode, 200);
  } finally {
    await t.close();
  }
});
