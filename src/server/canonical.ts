// Copyright 2026 TamTunnel. Licensed under the Apache License, Version 2.0.
// SPDX-License-Identifier: Apache-2.0

/** Minimal JSON canonicalization (JCS-style): object keys sorted
 *  recursively, no whitespace. Used for digest ids and audit hashes so
 *  the same content always hashes identically. */

export function canonicalize(value: unknown): string {
  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalize(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map(
    (k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`,
  );
  return `{${parts.join(",")}}`;
}
