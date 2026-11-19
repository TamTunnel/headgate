// Copyright 2026 TamTunnel. Licensed under the Apache License, Version 2.0.
// SPDX-License-Identifier: Apache-2.0

/**
 * Webhook receiver helpers: HMAC SHA-256 verification (S-1) and
 * delivery-ID dedup (S-9, A-3). A delivery with a wrong or missing
 * signature is rejected (401) and never enqueued; a replayed delivery
 * id is acknowledged but not re-processed.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { Db } from "./db";

export function signPayload(secret: string, body: Buffer): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

export function verifySignature(
  secret: string,
  body: Buffer,
  signatureHeader: string | undefined,
): boolean {
  if (!signatureHeader) return false;
  const expected = signPayload(secret, body);
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** Record a delivery id. Returns true when this is the first time the
 *  id was seen; false on a replay (unique-key conflict). Takes a Db so
 *  the caller can run it inside a transaction (F3). */
export async function recordDelivery(
  db: Db,
  deliveryId: string,
  event: string,
): Promise<boolean> {
  const res = await db.query(
    `INSERT INTO deliveries (delivery_id, event) VALUES ($1, $2)
     ON CONFLICT (delivery_id) DO NOTHING`,
    [deliveryId, event],
  );
  return (res.rowCount ?? 0) > 0;
}
