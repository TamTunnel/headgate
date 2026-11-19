// Copyright 2026 TamTunnel. Licensed under the Apache License, Version 2.0.
// SPDX-License-Identifier: Apache-2.0

/**
 * Audit probes:
 *   S-7 tamper-evidence: changing one entry breaks verification of
 *   every subsequent entry.
 *   Chain append + verify round-trip, including through the DB store.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  appendAuditEntry,
  verifyAuditChain,
  type AuditEntry,
} from "./audit.js";
import * as store from "./store.js";
import { makeTestApp } from "./testapp.js";

function buildChain(n: number): AuditEntry[] {
  const entries: AuditEntry[] = [];
  let prev: AuditEntry | null = null;
  for (let i = 1; i <= n; i++) {
    const e = appendAuditEntry(prev, i, `2026-11-19T0${i}:00:00Z`, "test", {
      i,
    });
    entries.push(e);
    prev = e;
  }
  return entries;
}

test("audit chain verifies when intact", () => {
  const entries = buildChain(5);
  assert.deepEqual(verifyAuditChain(entries), { ok: true });
});

test("S-7: mutating one entry breaks verification of every subsequent entry", () => {
  const entries = buildChain(5);
  // Mutate entry 3's payload (what an attacker rewriting history does).
  const tampered = entries.map((e) => ({ ...e }));
  tampered[2] = { ...tampered[2], payload: { i: 999 } };
  const result = verifyAuditChain(tampered);
  assert.equal(result.ok, false);
  assert.match(result.reason ?? "", /seq 3/);
  // The entries after the tampered one also fail: entry 4's prev_hash
  // no longer matches entry 3's (recomputed) hash, and entry 3's own
  // hash no longer matches its stored hash.
  assert.equal(verifyAuditChain(tampered.slice(0, 3)).ok, false);
  assert.equal(verifyAuditChain(tampered.slice(3)).ok, false);
});

test("S-7 (live): mutating a stored DB entry breaks the verifier", async () => {
  const t = await makeTestApp();
  try {
    const { pool, config } = { pool: t.tdb.pool, config: t.config };
    await store.appendAudit(pool, config.auditLogPath, "pr_ingested", { pr_number: 1 });
    await store.appendAudit(pool, config.auditLogPath, "digest_issued", { digest_id: "abc" });
    await store.appendAudit(pool, config.auditLogPath, "cluster_action", { action: "reviewed" });
    const before = await store.verifyAudit(pool);
    assert.equal(before.ok, true);

    // Tamper with the middle entry in the DB.
    await pool.query(
      `UPDATE audit_log SET payload = '{"tampered":true}'::jsonb WHERE seq = 2`,
    );
    const after = await store.verifyAudit(pool);
    assert.equal(after.ok, false);
    assert.match(after.reason ?? "", /seq 2/);
  } finally {
    await t.close();
  }
});

test("audit append assigns strictly increasing seqs from 1", async () => {
  const t = await makeTestApp();
  try {
    const { pool, config } = { pool: t.tdb.pool, config: t.config };
    const a = await store.appendAudit(pool, config.auditLogPath, "a", {});
    const b = await store.appendAudit(pool, config.auditLogPath, "b", {});
    assert.equal(a.seq, 1);
    assert.equal(b.seq, 2);
    assert.equal(b.prev_hash, a.hash);
    const entries = await store.listAuditEntries(pool);
    assert.equal(entries.length, 2);
    assert.deepEqual(await store.verifyAudit(pool), { ok: true });
  } finally {
    await t.close();
  }
});

test("F12: an audit append with a hanging mirror path returns instead of hanging", async () => {
  const t = await makeTestApp();
  try {
    const pool = t.tdb.pool;
    const before = await store.listAuditEntries(pool, 100);
    const start = Date.now();
    // /proc/1/nope: Node's recursive mkdir spins forever here (the
    // shell mkdir fails instantly). The mirror never calls it, so this
    // must return fast with the DB entry written.
    const entry = await store.appendAudit(pool, "/proc/1/nope/audit.jsonl", "probe", { tenant_id: 1 });
    const ms = Date.now() - start;
    assert.ok(ms < 2000, `appendAudit took ${ms}ms (must not hang on the mirror)`);
    assert.ok(entry.seq > 0);
    const after = await store.listAuditEntries(pool, 100);
    assert.equal(after.length, before.length + 1);
    assert.deepEqual(await store.verifyAudit(pool), { ok: true });
  } finally {
    await t.close();
  }
});
