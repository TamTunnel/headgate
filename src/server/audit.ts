// Copyright 2026 TamTunnel. Licensed under the Apache License, Version 2.0.
// SPDX-License-Identifier: Apache-2.0

/**
 * Hash-chained audit log (Vouchard/Successor pattern, pure functions).
 * Each entry's hash covers the previous entry's hash, so changing one
 * entry breaks verification of every subsequent entry (S-7).
 *
 * Tamper-evidence, NOT tamper-proofing: a full-store rewrite is
 * undetectable without an off-box checkpoint, and the README says so.
 * The store layer appends to Postgres (audit_log table) and mirrors
 * each entry as one JSONL line to AUDIT_LOG_PATH.
 */

import { createHash } from "node:crypto";
import { canonicalize } from "./canonical";

export interface AuditEntry {
  seq: number;
  ts: string;
  kind: string;
  payload: Record<string, unknown>;
  prev_hash: string;
  hash: string;
}

const GENESIS_PREV = "0".repeat(64);

export function hashAuditEntry(
  entry: Omit<AuditEntry, "hash">,
): string {
  return createHash("sha256")
    .update(
      canonicalize({
        seq: entry.seq,
        ts: entry.ts,
        kind: entry.kind,
        payload: entry.payload,
        prev_hash: entry.prev_hash,
      }),
    )
    .digest("hex");
}

export function appendAuditEntry(
  prev: AuditEntry | null,
  seq: number,
  ts: string,
  kind: string,
  payload: Record<string, unknown>,
): AuditEntry {
  const entry: Omit<AuditEntry, "hash"> = {
    seq,
    ts,
    kind,
    payload,
    prev_hash: prev ? prev.hash : GENESIS_PREV,
  };
  return { ...entry, hash: hashAuditEntry(entry) };
}

/** Verify a whole chain: seqs strictly increasing from 1, prev_hash
 *  links, hashes recompute. Returns the first problem found, or ok. */
export function verifyAuditChain(
  entries: AuditEntry[],
): { ok: boolean; reason?: string } {
  let prev: AuditEntry | null = null;
  for (const e of entries) {
    if (prev === null) {
      if (e.seq !== 1) return { ok: false, reason: `first entry seq is ${e.seq}, want 1` };
      if (e.prev_hash !== GENESIS_PREV) {
        return { ok: false, reason: "genesis prev_hash mismatch" };
      }
    } else {
      if (e.seq !== prev.seq + 1) {
        return { ok: false, reason: `seq gap at ${e.seq}` };
      }
      if (e.prev_hash !== prev.hash) {
        return { ok: false, reason: `prev_hash mismatch at seq ${e.seq}` };
      }
    }
    if (hashAuditEntry(e) !== e.hash) {
      return { ok: false, reason: `hash mismatch at seq ${e.seq}` };
    }
    prev = e;
  }
  return { ok: true };
}
