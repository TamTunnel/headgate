// Copyright 2026 TamTunnel. Licensed under the Apache License, Version 2.0.
// SPDX-License-Identifier: Apache-2.0

/** Shared test setup: a fresh Postgres database per test file. */

import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { createPool, migrate, truncateAll } from "./db.js";

export interface TestDb {
  pool: ReturnType<typeof createPool>;
  dbName: string;
}

function testDbName(): string {
  const base = process.env.HEADGATE_TEST_DB ?? "headgate_test";
  return `${base}_${randomBytes(4).toString("hex")}`;
}

export async function setupTestDb(): Promise<TestDb> {
  const dbName = testDbName();
  const adminUrl =
    process.env.DATABASE_URL ??
    "postgres://headgate:headgate-dev@127.0.0.1:5432/headgate";
  // Connect to the maintenance db to (re)create the test database.
  const admin = new Client({
    connectionString: adminUrl.replace(/\/[^/]*$/, "/postgres"),
  });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
  await admin.query(`CREATE DATABASE "${dbName}"`);
  await admin.end();
  const url = adminUrl.replace(/\/[^/]*$/, `/${dbName}`);
  const pool = createPool(url);
  await migrate(pool);
  return { pool, dbName };
}

export async function teardownTestDb(t: TestDb): Promise<void> {
  await t.pool.end();
  const adminUrl =
    process.env.DATABASE_URL ??
    "postgres://headgate:headgate-dev@127.0.0.1:5432/headgate";
  const admin = new Client({
    connectionString: adminUrl.replace(/\/[^/]*$/, "/postgres"),
  });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${t.dbName}"`);
  await admin.end();
}

export async function resetTestDb(pool: ReturnType<typeof createPool>): Promise<void> {
  await truncateAll(pool);
}
