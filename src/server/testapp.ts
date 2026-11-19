// Copyright 2026 TamTunnel. Licensed under the Apache License, Version 2.0.
// SPDX-License-Identifier: Apache-2.0

/** Test harness: a real Postgres test DB + a Fastify app wired to the
 *  FakeGitHubClient + a worker. No network, no real GitHub credentials. */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { signPayload } from "./webhook.js";
import { buildApp } from "./server.js";
import { FakeGitHubClient, type GhCheck, type GhFile, type GhPr } from "./github.js";
import { setupTestDb, teardownTestDb, type TestDb } from "./testutil.js";
import { Worker } from "./worker.js";
import type { HeadgateConfig } from "./config.js";

export const TEST_WEBHOOK_SECRET = "test-webhook-secret";
export const TEST_ADMIN_TOKEN = "test-admin-token";

/** Authorization header for the operator token (F1). */
export function adminHeaders(): Record<string, string> {
  return { authorization: `Bearer ${TEST_ADMIN_TOKEN}` };
}

export function testConfig(auditLogPath: string): HeadgateConfig {
  return {
    port: 0,
    host: "127.0.0.1",
    databaseUrl: "",
    baseUrl: "http://localhost:3000",
    adminToken: TEST_ADMIN_TOKEN,
    webhookSecret: TEST_WEBHOOK_SECRET,
    githubAppId: "",
    githubAppPrivateKey: "",
    githubAppSlug: "headgate",
    digestHour: 9,
    retentionDays: 30,
    auditLogPath,
    smtpHost: "",
    smtpPort: 587,
    smtpUser: "",
    smtpPass: "",
    smtpFrom: "",
    digestRecipients: "",
    isProduction: false,
  };
}

export interface TestApp {
  app: FastifyInstance;
  worker: Worker;
  github: FakeGitHubClient;
  config: HeadgateConfig;
  tdb: TestDb;
  auditLogPath: string;
  close(): Promise<void>;
}

export async function makeTestApp(): Promise<TestApp> {
  const tdb = await setupTestDb();
  const dir = await mkdtemp(join(tmpdir(), "headgate-audit-"));
  const auditLogPath = join(dir, "audit.jsonl");
  const config = testConfig(auditLogPath);
  const github = new FakeGitHubClient();
  const worker = new Worker({ pool: tdb.pool, config, github });
  const app = buildApp({ pool: tdb.pool, config, github, worker });
  await app.ready();
  return {
    app,
    worker,
    github,
    config,
    tdb,
    auditLogPath,
    close: async () => {
      await app.close();
      await teardownTestDb(tdb);
    },
  };
}

/** POST a signed webhook delivery to the app. Returns the response. */
export async function postWebhook(
  app: FastifyInstance,
  opts: {
    deliveryId: string;
    event?: string;
    payload: Record<string, unknown>;
    secret?: string;
    sign?: boolean;
  },
): Promise<{ status: number; body: Record<string, unknown> }> {
  const body = JSON.stringify(opts.payload);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-github-delivery": opts.deliveryId,
    "x-github-event": opts.event ?? "pull_request",
  };
  if (opts.sign !== false) {
    headers["x-hub-signature-256"] = signPayload(
      opts.secret ?? TEST_WEBHOOK_SECRET,
      Buffer.from(body, "utf8"),
    );
  }
  const res = await app.inject({
    method: "POST",
    url: "/webhooks/github",
    headers,
    payload: body,
  });
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(res.body) as Record<string, unknown>;
  } catch {
    parsed = {};
  }
  return { status: res.statusCode, body: parsed };
}

export function fakePr(
  overrides: Partial<GhPr> & { number: number },
): GhPr {
  return {
    title: `Fake PR #${overrides.number}`,
    body: "",
    author: "devin-bot",
    authorType: "Bot",
    isBot: true,
    baseSha: "base000",
    headSha: `head${overrides.number}00`,
    headBranch: `devin/${overrides.number}-feature`,
    baseBranch: "main",
    state: "open",
    createdAt: "2026-11-19T08:00:00Z",
    updatedAt: "2026-11-19T08:00:00Z",
    mergedAt: null,
    linkedIssues: [],
    forcePushes: 0,
    commitsAfterTouch: 0,
    url: `https://github.com/acme/app/pull/${overrides.number}`,
    ...overrides,
  };
}

export function fakeFile(
  path: string,
  additions = 10,
  deletions = 2,
  patch = "",
): GhFile {
  return { path, additions, deletions, status: "modified", patch };
}

export function fakeCheck(
  name: string,
  conclusion: string | null = "success",
): GhCheck {
  return { name, status: "completed", conclusion, completedAt: "2026-11-19T09:00:00Z" };
}

export function prPayload(
  installationId: number,
  repoFullName: string,
  prNumber: number,
): Record<string, unknown> {
  return {
    action: "opened",
    installation: { id: installationId, account: { login: "acme" } },
    repository: { full_name: repoFullName },
    pull_request: { number: prNumber },
  };
}
