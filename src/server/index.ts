// Copyright 2026 TamTunnel. Licensed under the Apache License, Version 2.0.
// SPDX-License-Identifier: Apache-2.0

import { loadConfig } from "./config";
import { createPool, migrate } from "./db";
import {
  HttpGitHubClient,
  UnconfiguredGitHubClient,
  type GitHubClient,
} from "./github";
import { buildApp } from "./server";
import * as store from "./store";
import { Worker } from "./worker";

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.databaseUrl);
  await migrate(pool);

  let github: GitHubClient;
  if (process.env.GITHUB_CLIENT === "fake") {
    const { FakeGitHubClient } = await import("./github");
    console.warn("GITHUB_CLIENT=fake: using the in-memory GitHub client (dev only)");
    github = new FakeGitHubClient();
  } else if (config.githubAppId && config.githubAppPrivateKey) {
    github = new HttpGitHubClient(config.githubAppId, config.githubAppPrivateKey);
  } else {
    console.warn(
      "No GitHub App credentials configured: GitHub operations will fail until configured",
    );
    github = new UnconfiguredGitHubClient();
  }

  const worker = new Worker({ pool, config, github });
  const app = buildApp({ pool, config, github, worker });

  // Enqueue the daily digest + prune jobs on boot (idempotent keys keep
  // them from duplicating across restarts on the same day).
  const today = new Date().toISOString().slice(0, 10);
  const tenants = await store.listTenants(pool);
  for (const tenant of tenants) {
    const repos = await store.listRepos(pool, tenant.id);
    for (const repo of repos) {
      await store.enqueueJob(
        pool,
        "digest",
        `digest:${tenant.installation_id}:${repo.full_name}:${today}`,
        {
          installation_id: tenant.installation_id,
          repo_full_name: repo.full_name,
          date: today,
        },
      );
    }
  }
  await store.enqueueJob(pool, "prune", `prune:${today}`, {
    days: config.retentionDays,
  });

  worker.start();
  await app.listen({ port: config.port, host: config.host });
  console.log(`Headgate listening on http://${config.host}:${config.port}`);

  const shutdown = async (): Promise<void> => {
    worker.stop();
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

// Only boot the server when this file is the entry point. Importing it
// (e.g. from tests) must never start listening: node --test on a directory
// executes the directory's index.js as a test file, and an unguarded boot
// would hang the runner on a never-exiting server.
if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
