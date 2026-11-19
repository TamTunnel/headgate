// Copyright 2026 TamTunnel. Licensed under the Apache License, Version 2.0.
// SPDX-License-Identifier: Apache-2.0

/**
 * Ops probes:
 *   S-4 tenant isolation (two installations, same repo name, zero
 *       cross-tenant rows at every endpoint)
 *   D-5 cluster corrections recorded and not silently re-applied
 *   A-5 a permanently failing job dead-letters after N attempts
 *   A-6 bounded retention (old merged snapshots pruned, digests kept)
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as store from "./store.js";
import { buildDigestForRepo } from "./digestBuild.js";
import {
  adminHeaders,
  fakeCheck,
  fakeFile,
  fakePr,
  makeTestApp,
  postWebhook,
  prPayload,
} from "./testapp.js";

test("S-4: two installations with the same repo name see zero of each other's rows", async () => {
  const t = await makeTestApp();
  try {
    for (const inst of [111, 222]) {
      t.github.addPr(
        inst,
        "acme/app",
        fakePr({ number: 1, title: `PR from installation ${inst}` }),
        [fakeFile("src/a.ts", 10, 0)],
        [fakeCheck("ci", "success")],
      );
      const res = await postWebhook(t.app, {
        deliveryId: `s4-${inst}`,
        payload: prPayload(inst, "acme/app", 1),
      });
      assert.equal(res.status, 202);
    }
    await t.worker.drain();

    // Tenant 111's queue has only its own PR.
    const q111 = await t.app.inject({
      method: "GET",
      url: `/api/queue?installation_id=111&repo=acme%2Fapp`,
      headers: adminHeaders(),
    });
    assert.equal(q111.statusCode, 200);
    const body111 = JSON.parse(q111.body) as { prs: { title: string }[] };
    assert.equal(body111.prs.length, 1);
    assert.match(body111.prs[0].title, /111/);

    const q222 = await t.app.inject({
      method: "GET",
      url: `/api/queue?installation_id=222&repo=acme%2Fapp`,
      headers: adminHeaders(),
    });
    assert.equal(q222.statusCode, 200);
    const body222 = JSON.parse(q222.body) as { prs: { title: string }[] };
    assert.equal(body222.prs.length, 1);
    assert.match(body222.prs[0].title, /222/);

    // A tenant id that does not exist sees nothing (400, not a leak).
    const q999 = await t.app.inject({
      method: "GET",
      url: `/api/queue?installation_id=999&repo=acme%2Fapp`,
      headers: adminHeaders(),
    });
    assert.equal(q999.statusCode, 400);
  } finally {
    await t.close();
  }
});

test("D-5: a human split is recorded and is not silently re-applied", async () => {
  const t = await makeTestApp();
  try {
    const INSTALLATION = 111;
    const REPO = "acme/app";
    t.github.addPr(
      INSTALLATION,
      REPO,
      fakePr({ number: 1, title: "Shared A" }),
      [fakeFile("src/shared.ts", 20, 0)],
      [fakeCheck("ci", "success")],
    );
    t.github.addPr(
      INSTALLATION,
      REPO,
      fakePr({ number: 2, title: "Shared B" }),
      [fakeFile("src/shared.ts", 20, 0)],
      [fakeCheck("ci", "success")],
    );
    for (const n of [1, 2]) {
      await postWebhook(t.app, {
        deliveryId: `d5-${n}`,
        payload: prPayload(INSTALLATION, REPO, n),
      });
    }
    await t.worker.drain();
    const tenant = await store.getTenantByInstallation(t.tdb.pool, INSTALLATION);
    assert.ok(tenant);
    const repo = await store.getRepo(t.tdb.pool, tenant.id, REPO);
    assert.ok(repo);
    let clusters = await store.listClusters(t.tdb.pool, tenant.id, repo.id);
    assert.equal(clusters.length, 1, "the two PRs start in one cluster");
    const key = clusters[0].cluster_key;

    // Split the cluster via the API.
    const split = await t.app.inject({
      method: "POST",
      url: "/api/cluster/action",
      headers: { "content-type": "application/json", ...adminHeaders() },
      payload: JSON.stringify({
        installation_id: INSTALLATION,
        repo: REPO,
        cluster_key: key,
        action: "split",
        actor: "tester",
        reason: "unrelated changes",
        groups: [[1], [2]],
      }),
    });
    assert.equal(split.statusCode, 200);

    // Re-run clustering (as the next ingestion/backfill would) and
    // confirm the split holds.
    await t.worker.drain();
    await store.enqueueJob(
      t.tdb.pool,
      "backfill",
      `backfill-d5-${Date.now()}`,
      { installation_id: INSTALLATION, repo_full_name: REPO },
    );
    await t.worker.drain();
    clusters = await store.listClusters(t.tdb.pool, tenant.id, repo.id);
    assert.equal(clusters.length, 2, "split survives the next clustering run");
    const members = clusters.map((c) => c.member_pr_ids.length).sort();
    assert.deepEqual(members, [1, 1]);

    // The decision is in the audit log.
    const audit = await store.listAuditEntries(t.tdb.pool);
    assert.ok(
      audit.some(
        (e) => e.kind === "cluster_action" && (e.payload as Record<string, unknown>).action === "split",
      ),
    );
  } finally {
    await t.close();
  }
});

test("A-5: a permanently failing job dead-letters after max attempts", async () => {
  const t = await makeTestApp();
  try {
    // A webhook for a PR the fake client does not know: fetchPr throws
    // on every attempt (e.g. a repo the app was uninstalled from).
    const res = await postWebhook(t.app, {
      deliveryId: "a5-1",
      payload: prPayload(111, "acme/app", 99),
    });
    assert.equal(res.status, 202);
    for (let attempt = 0; attempt < 5; attempt++) {
      await t.worker.drain();
      // Backoff pushes next_run_at into the future; the test moves it
      // back so the retry can be observed without waiting.
      await t.tdb.pool.query(
        `UPDATE jobs SET next_run_at = now() WHERE state = 'failed'`,
      );
    }
    await t.worker.drain();
    const dead = await store.listDeadJobs(t.tdb.pool);
    assert.equal(dead.length, 1);
    assert.equal(dead[0].type, "webhook");
    assert.equal(dead[0].attempts, 5);
  } finally {
    await t.close();
  }
});

test("A-6: old merged snapshots are pruned, digests are retained", async () => {
  const t = await makeTestApp();
  try {
    const INSTALLATION = 111;
    const REPO = "acme/app";
    t.github.addPr(
      INSTALLATION,
      REPO,
      fakePr({ number: 1, title: "Old merged PR", state: "merged", mergedAt: "2026-10-01T00:00:00Z" }),
      [fakeFile("src/a.ts", 10, 0)],
      [fakeCheck("ci", "success")],
    );
    await postWebhook(t.app, {
      deliveryId: "a6-1",
      payload: prPayload(INSTALLATION, REPO, 1),
    });
    await t.worker.drain();
    const tenant = await store.getTenantByInstallation(t.tdb.pool, INSTALLATION);
    assert.ok(tenant);
    const repo = await store.getRepo(t.tdb.pool, tenant.id, REPO);
    assert.ok(repo);

    // Build a digest so retention of the artifact can be checked.
    const { digestId } = await buildDigestForRepo(
      t.tdb.pool,
      tenant.id,
      repo.id,
      REPO,
      "2026-11-19",
    );
    const before = await t.tdb.pool.query(
      `SELECT COUNT(*)::int AS n FROM pr_files`,
    );
    assert.equal(before.rows[0].n, 1);

    const pruned = await store.pruneOldSnapshots(t.tdb.pool, 30);
    assert.equal(pruned.prs, 1);
    const after = await t.tdb.pool.query(
      `SELECT COUNT(*)::int AS n FROM pr_files`,
    );
    assert.equal(after.rows[0].n, 0);
    const digest = await store.getDigest(t.tdb.pool, tenant.id, repo.id, "2026-11-19");
    assert.ok(digest);
    assert.equal(digest.digest_id, digestId);
  } finally {
    await t.close();
  }
});

test("F7: concurrent digest builds report created exactly once", async () => {
  const t = await makeTestApp();
  try {
    for (const n of [7, 8]) {
      t.github.addPr(111, "acme/app", fakePr({ number: n }), [fakeFile(`src/f${n}.ts`)], [fakeCheck("ci")]);
      await postWebhook(t.app, { deliveryId: `f7-${n}`, payload: prPayload(111, "acme/app", n) });
    }
    await t.worker.drain();
    const [r1, r2] = await Promise.all([
      t.app.inject({ method: "POST", url: "/api/digest/build", headers: { "content-type": "application/json", ...adminHeaders() }, payload: JSON.stringify({ installation_id: 111, repo: "acme/app", date: "2026-11-19" }) }),
      t.app.inject({ method: "POST", url: "/api/digest/build", headers: { "content-type": "application/json", ...adminHeaders() }, payload: JSON.stringify({ installation_id: 111, repo: "acme/app", date: "2026-11-19" }) }),
    ]);
    const b1 = JSON.parse(r1.body) as { digest_id: string; created: boolean };
    const b2 = JSON.parse(r2.body) as { digest_id: string; created: boolean };
    assert.equal(b1.digest_id, b2.digest_id);
    assert.equal([b1.created, b2.created].filter(Boolean).length, 1, "exactly one build reports created=true");
    const issued = await t.tdb.pool.query(`SELECT COUNT(*)::int AS n FROM audit_log WHERE kind = 'digest_issued'`);
    assert.equal(issued.rows[0].n, 1);
  } finally {
    await t.close();
  }
});

test("B1: 10 concurrent digest builds return one digest id, no 500s", async () => {
  const t = await makeTestApp();
  try {
    for (const n of [7, 8]) {
      t.github.addPr(111, "acme/app", fakePr({ number: n }), [fakeFile(`src/f${n}.ts`)], [fakeCheck("ci")]);
      await postWebhook(t.app, { deliveryId: `b1-${n}`, payload: prPayload(111, "acme/app", n) });
    }
    await t.worker.drain();
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        t.app.inject({ method: "POST", url: "/api/digest/build", headers: { "content-type": "application/json", ...adminHeaders() }, payload: JSON.stringify({ installation_id: 111, repo: "acme/app", date: "2026-11-19" }) }),
      ),
    );
    for (const r of results) assert.equal(r.statusCode, 200, r.body.slice(0, 200));
    const bodies = results.map((r) => JSON.parse(r.body) as { digest_id: string; created: boolean });
    assert.equal(new Set(bodies.map((b) => b.digest_id)).size, 1, "all 10 builds return the same digest id");
    assert.equal(bodies.filter((b) => b.created).length, 1, "exactly one build reports created=true");
    const tenant = await store.getTenantByInstallation(t.tdb.pool, 111);
    assert.ok(tenant);
    const repo = await store.getRepo(t.tdb.pool, tenant.id, "acme/app");
    assert.ok(repo);
    const stored = await store.getDigest(t.tdb.pool, tenant.id, repo.id, "2026-11-19");
    assert.ok(stored);
    assert.equal(bodies[0].digest_id, stored.digest_id, "returned id is the stored id, not a phantom");
    assert.equal(stored.content.clusters.length, 1, "stored digest has the deterministic single cluster");
    const issued = await t.tdb.pool.query(`SELECT COUNT(*)::int AS n FROM audit_log WHERE kind = 'digest_issued'`);
    assert.equal(issued.rows[0].n, 1);
  } finally {
    await t.close();
  }
});

test("F8: a split that omits a member keeps it in the queue as a singleton", async () => {
  const t = await makeTestApp();
  try {
    const INSTALLATION = 111;
    const REPO = "acme/app";
    for (const n of [7, 8, 9]) {
      t.github.addPr(INSTALLATION, REPO, fakePr({ number: n }), [fakeFile("src/shared.ts"), fakeFile(`src/f${n}.ts`)], [fakeCheck("ci")]);
      await postWebhook(t.app, { deliveryId: `f8-${n}`, payload: prPayload(INSTALLATION, REPO, n) });
    }
    await t.worker.drain();
    const tenant = await store.getTenantByInstallation(t.tdb.pool, INSTALLATION);
    assert.ok(tenant);
    const repo = await store.getRepo(t.tdb.pool, tenant.id, REPO);
    assert.ok(repo);
    let clusters = await store.listClusters(t.tdb.pool, tenant.id, repo.id);
    assert.equal(clusters.length, 1);
    const key = clusters[0].cluster_key;
    // Split {7,8,9} into [[7],[8]] via the API — PR 9 is in neither group.
    const split = await t.app.inject({
      method: "POST",
      url: "/api/cluster/action",
      headers: { "content-type": "application/json", ...adminHeaders() },
      payload: JSON.stringify({ installation_id: INSTALLATION, repo: REPO, cluster_key: key, action: "split", actor: "tester", reason: "test split", groups: [[7], [8]] }),
    });
    assert.equal(split.statusCode, 200);
    // The stored correction itself was normalized to cover PR 9.
    const stored = await t.tdb.pool.query(`SELECT correction FROM cluster_corrections WHERE cluster_key = $1`, [key]);
    const groups = (stored.rows[0].correction as { split: { groups: number[][] } }).split.groups;
    assert.deepEqual(groups, [[7], [8], [9]]);
    await store.enqueueJob(
      t.tdb.pool,
      "backfill",
      `backfill-f8-${Date.now()}`,
      { installation_id: INSTALLATION, repo_full_name: REPO },
    );
    await t.worker.drain();
    clusters = await store.listClusters(t.tdb.pool, tenant.id, repo.id);
    const queued = new Set<number>();
    for (const c of clusters) {
      const rows = await t.tdb.pool.query(`SELECT number FROM pull_requests WHERE id = ANY($1::uuid[])`, [c.member_pr_ids]);
      for (const r of rows.rows as { number: number }[]) queued.add(r.number);
    }
    assert.deepEqual([...queued].sort(), [7, 8, 9]);
  } finally {
    await t.close();
  }
});

test("B2: an overlapping split correction cannot poison the repo", async () => {
  const t = await makeTestApp();
  try {
    const INSTALLATION = 111;
    const REPO = "acme/app";
    for (const n of [7, 8, 9]) {
      t.github.addPr(INSTALLATION, REPO, fakePr({ number: n }), [fakeFile("src/shared.ts"), fakeFile(`src/f${n}.ts`)], [fakeCheck("ci")]);
      await postWebhook(t.app, { deliveryId: `b2-${n}`, payload: prPayload(INSTALLATION, REPO, n) });
    }
    await t.worker.drain();
    const tenant = await store.getTenantByInstallation(t.tdb.pool, INSTALLATION);
    assert.ok(tenant);
    const repo = await store.getRepo(t.tdb.pool, tenant.id, REPO);
    assert.ok(repo);
    let clusters = await store.listClusters(t.tdb.pool, tenant.id, repo.id);
    assert.equal(clusters.length, 1);
    const key = clusters[0].cluster_key;
    // Overlapping groups: PR 7 in two groups — an easy dashboard slip.
    const split = await t.app.inject({
      method: "POST",
      url: "/api/cluster/action",
      headers: { "content-type": "application/json", ...adminHeaders() },
      payload: JSON.stringify({ installation_id: INSTALLATION, repo: REPO, cluster_key: key, action: "split", actor: "tester", reason: "overlapping split", groups: [[7], [7]] }),
    });
    assert.equal(split.statusCode, 200);
    // The stored correction was collapsed to a partition of the members.
    const stored = await t.tdb.pool.query(`SELECT correction FROM cluster_corrections WHERE cluster_key = $1`, [key]);
    const groups = (stored.rows[0].correction as { split: { groups: number[][] } }).split.groups;
    assert.deepEqual(groups, [[7], [8], [9]]);
    // Ingest a PR that does not join the cluster: the recluster must
    // not fail, and no PR may drop out of the live queue.
    t.github.addPr(INSTALLATION, REPO, fakePr({ number: 10 }), [fakeFile("src/other.ts")], [fakeCheck("ci")]);
    const w = await postWebhook(t.app, { deliveryId: "b2-10", payload: prPayload(INSTALLATION, REPO, 10) });
    assert.equal(w.status, 202);
    await t.worker.drain();
    const dead = await t.tdb.pool.query(`SELECT COUNT(*)::int AS n FROM jobs WHERE state = 'dead'`);
    assert.equal(dead.rows[0].n, 0);
    clusters = await store.listClusters(t.tdb.pool, tenant.id, repo.id);
    const queued = new Set<number>();
    for (const c of clusters) {
      const rows = await t.tdb.pool.query(`SELECT number FROM pull_requests WHERE id = ANY($1::uuid[])`, [c.member_pr_ids]);
      for (const r of rows.rows as { number: number }[]) queued.add(r.number);
    }
    assert.deepEqual([...queued].sort((a, b) => a - b), [7, 8, 9, 10]);
    const d = await t.app.inject({
      method: "POST",
      url: "/api/digest/build",
      headers: { "content-type": "application/json", ...adminHeaders() },
      payload: JSON.stringify({ installation_id: INSTALLATION, repo: REPO, date: "2026-11-19" }),
    });
    assert.equal(d.statusCode, 200);
  } finally {
    await t.close();
  }
});
