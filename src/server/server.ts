// Copyright 2026 TamTunnel. Licensed under the Apache License, Version 2.0.
// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import type { Pool } from "pg";
import type { HeadgateConfig } from "./config";
import { FakeGitHubClient, type GitHubClient } from "./github";
import { registerRoutes, type RouteDeps } from "./routes";
import type { Worker } from "./worker";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

export function buildApp(deps: RouteDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  // Keep the raw body for HMAC verification on the webhook route.
  // Fastify's JSON parser would otherwise consume the exact bytes.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (req, body, done) => {
      (req as unknown as { rawBody: Buffer }).rawBody = Buffer.from(
        body as string,
        "utf8",
      );
      try {
        done(null, JSON.parse(body as string));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  registerRoutes(app, deps);

  // Dev-only seed endpoint, registered ONLY when the fake GitHub client
  // is in use (GITHUB_CLIENT=fake). Lets the smoke script and local dev
  // inject fake PR payloads into the in-memory client. It is never
  // registered with the real HTTP client, so it cannot exist in
  // production. It writes nothing to GitHub.
  if (deps.github instanceof FakeGitHubClient) {
    const fakeGithub = deps.github;
    app.post("/api/dev/seed-pr", async (req, reply) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const pr = b.pr as Record<string, unknown>;
      const files = (b.files ?? []) as Record<string, unknown>[];
      const checks = (b.checks ?? []) as Record<string, unknown>[];
      if (!pr || typeof pr.number !== "number") {
        return reply.code(400).send({ error: "pr.number is required" });
      }
      fakeGithub.addPr(
        Number(b.installation_id ?? 0),
        String(b.repo ?? ""),
        {
          number: pr.number,
          title: String(pr.title ?? ""),
          body: String(pr.body ?? ""),
          author: String(pr.author ?? "devin-bot"),
          authorType: String(pr.authorType ?? "Bot"),
          isBot: Boolean(pr.isBot ?? true),
          baseSha: String(pr.baseSha ?? ""),
          headSha: String(pr.headSha ?? ""),
          headBranch: String(pr.headBranch ?? ""),
          baseBranch: String(pr.baseBranch ?? "main"),
          state: (pr.state as "open" | "closed" | "merged") ?? "open",
          createdAt: String(pr.createdAt ?? new Date().toISOString()),
          updatedAt: String(pr.updatedAt ?? new Date().toISOString()),
          mergedAt: pr.mergedAt ? String(pr.mergedAt) : null,
          linkedIssues: (pr.linkedIssues as number[]) ?? [],
          forcePushes: Number(pr.forcePushes ?? 0),
          commitsAfterTouch: Number(pr.commitsAfterTouch ?? 0),
          url: String(pr.url ?? ""),
        },
        files.map((f) => ({
          path: String(f.path ?? ""),
          additions: Number(f.additions ?? 0),
          deletions: Number(f.deletions ?? 0),
          status: String(f.status ?? "modified"),
          patch: String(f.patch ?? ""),
        })),
        checks.map((c) => ({
          name: String(c.name ?? ""),
          status: String(c.status ?? ""),
          conclusion: c.conclusion === null ? null : String(c.conclusion ?? ""),
          completedAt: c.completedAt ? String(c.completedAt) : null,
        })),
      );
      return { ok: true };
    });
  }

  // Serve the built dashboard (client/dist) from the same process.
  app.get("/*", async (req, reply) => {
    const url = req.url.split("?")[0];
    if (url.startsWith("/api/") || url.startsWith("/webhooks/")) {
      return reply.code(404).send({ error: "not found" });
    }
    const distDir = join(__dirname, "..", "..", "client", "dist");
    const rel = url === "/" ? "index.html" : url.replace(/^\//, "");
    const file = join(distDir, rel);
    // No path traversal: the joined path must stay under distDir.
    if (!file.startsWith(distDir)) {
      return reply.code(400).send({ error: "bad path" });
    }
    try {
      const data = await readFile(file);
      const ext = file.slice(file.lastIndexOf("."));
      reply.type(CONTENT_TYPES[ext] ?? "application/octet-stream");
      return reply.send(data);
    } catch {
      // SPA fallback: unknown paths serve the dashboard shell.
      try {
        const index = await readFile(join(distDir, "index.html"));
        reply.type("text/html");
        return reply.send(index);
      } catch {
        return reply.code(404).send({ error: "dashboard not built" });
      }
    }
  });

  return app;
}

export interface AppDeps {
  pool: Pool;
  config: HeadgateConfig;
  github: GitHubClient;
  worker: Worker;
}

export { type RouteDeps };
