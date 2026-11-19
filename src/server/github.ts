// Copyright 2026 TamTunnel. Licensed under the Apache License, Version 2.0.
// SPDX-License-Identifier: Apache-2.0

/**
 * GitHub access behind an interface, so a second forge is a new adapter,
 * not a rewrite. The service fetches diffs through the GitHub API only —
 * it never checks out, builds, or runs PR code (S-5).
 *
 * Installation tokens are held in memory only, never logged, never
 * stored (S-2). The HTTP client signs an App JWT (RS256) with the
 * private key from env, exchanges it for a short-lived installation
 * token per call, and discards it.
 */

import { createHash, createSign } from "node:crypto";

export interface GhPr {
  number: number;
  title: string;
  body: string;
  author: string;
  authorType: string;
  isBot: boolean;
  baseSha: string;
  headSha: string;
  headBranch: string;
  baseBranch: string;
  state: "open" | "closed" | "merged";
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  linkedIssues: number[];
  forcePushes: number;
  commitsAfterTouch: number;
  url: string;
}

export interface GhFile {
  path: string;
  additions: number;
  deletions: number;
  status: string;
  patch: string;
}

export interface GhCheck {
  name: string;
  status: string;
  conclusion: string | null;
  completedAt: string | null;
}

export interface GitHubClient {
  fetchPr(
    installationId: number,
    repoFullName: string,
    prNumber: number,
  ): Promise<GhPr>;
  fetchPrFiles(
    installationId: number,
    repoFullName: string,
    prNumber: number,
  ): Promise<GhFile[]>;
  fetchPrChecks(
    installationId: number,
    repoFullName: string,
    pr: GhPr,
  ): Promise<GhCheck[]>;
  listOpenPrs(
    installationId: number,
    repoFullName: string,
  ): Promise<GhPr[]>;
}

/** Diff hash: SHA-256 over the sorted set of normalized added lines.
 *  Two PRs with the same added-line set are near-identical diffs.
 *  An empty added-line set (binary-only diffs, pure deletions) hashes
 *  to "" — no edge (F5): every empty diff would otherwise share one
 *  hash and cluster. */
export function diffHash(files: GhFile[]): string {
  const added: string[] = [];
  for (const f of files) {
    if (!f.patch) continue;
    for (const line of f.patch.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) {
        added.push(`${f.path}:${line.slice(1)}`);
      }
    }
  }
  if (added.length === 0) return "";
  added.sort();
  return createHash("sha256").update(added.join("\n")).digest("hex");
}

/** Extract linked issue numbers from a PR body (`#123`, `fixes #123`).
 *  A bare `#123` preceded by "PR" / "pull request" is a pull-request
 *  reference, not an issue, and is excluded (F11). */
export function linkedIssuesFromBody(body: string): number[] {
  const out = new Set<number>();
  // Strip PR references first: "See PR #123", "pull request #7" — and
  // the plural/list forms (B3): "PRs #123 and #124", "Depends on PRs
  // #123, #124", "pull requests #7 and #8". A bare #N that follows a
  // PR reference in the same comma/and list is part of that reference,
  // not a linked issue, so the whole list span is stripped at once.
  const withoutPrRefs = body
    .replace(/\bPRs?\s*#\d+(?:\s*(?:,|and)\s*#\d+)*/gi, "")
    .replace(/\bpull requests?\s*#\d+(?:\s*(?:,|and)\s*#\d+)*/gi, "");
  const re = /(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|#)\s*#?(\d+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(withoutPrRefs)) !== null) {
    const n = Number(m[1]);
    if (n > 0) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

/** App JWT for GitHub App auth: RS256, 10-minute expiry. */
export function createAppJwt(appId: string, privateKeyPem: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", typ: "JWT" }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ iat: now - 60, exp: now + 600, iss: appId }),
  ).toString("base64url");
  const signingInput = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  const signature = signer.sign(privateKeyPem).toString("base64url");
  return `${signingInput}.${signature}`;
}

const API_BASE = "https://api.github.com";

export class HttpGitHubClient implements GitHubClient {
  constructor(
    private readonly appId: string,
    private readonly privateKeyPem: string,
  ) {}

  /** Exchange the App JWT for a short-lived installation token.
   *  The token lives only in this call's memory; callers never see it
   *  in a return value and it is never logged. */
  private async installationToken(installationId: number): Promise<string> {
    const jwt = createAppJwt(this.appId, this.privateKeyPem);
    const res = await fetch(
      `${API_BASE}/app/installations/${installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "headgate",
        },
      },
    );
    if (!res.ok) {
      throw new Error(
        `installation token exchange failed: ${res.status}`,
      );
    }
    const body = (await res.json()) as { token: string };
    return body.token;
  }

  private async api<T>(
    installationId: number,
    path: string,
  ): Promise<T> {
    const token = await this.installationToken(installationId);
    const res = await fetch(`${API_BASE}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "headgate",
      },
    });
    if (res.status === 403) {
      const remaining = res.headers.get("x-ratelimit-remaining");
      if (remaining === "0") {
        const reset = res.headers.get("x-ratelimit-reset") ?? "";
        throw new RateLimitedError(`rate limited until ${reset}`);
      }
    }
    if (!res.ok) throw new Error(`GitHub API ${path} failed: ${res.status}`);
    return (await res.json()) as T;
  }

  async fetchPr(
    installationId: number,
    repoFullName: string,
    prNumber: number,
  ): Promise<GhPr> {
    const pr = await this.api<Record<string, unknown>>(
      installationId,
      `/repos/${repoFullName}/pulls/${prNumber}`,
    );
    return normalizePr(pr);
  }

  async fetchPrFiles(
    installationId: number,
    repoFullName: string,
    prNumber: number,
  ): Promise<GhFile[]> {
    const files = await this.api<Record<string, unknown>[]>(
      installationId,
      `/repos/${repoFullName}/pulls/${prNumber}/files?per_page=100`,
    );
    return files.map((f) => ({
      path: String(f.filename ?? ""),
      additions: Number(f.additions ?? 0),
      deletions: Number(f.deletions ?? 0),
      status: String(f.status ?? "modified"),
      patch: String(f.patch ?? ""),
    }));
  }

  async fetchPrChecks(
    installationId: number,
    repoFullName: string,
    pr: GhPr,
  ): Promise<GhCheck[]> {
    const runs = await this.api<{ check_runs: Record<string, unknown>[] }>(
      installationId,
      `/repos/${repoFullName}/commits/${pr.headSha}/check-runs?per_page=100`,
    );
    return (runs.check_runs ?? []).map((r) => ({
      name: String(r.name ?? ""),
      status: String(r.status ?? ""),
      conclusion: r.conclusion === null ? null : String(r.conclusion),
      completedAt:
        r.completed_at === null ? null : String(r.completed_at),
    }));
  }

  async listOpenPrs(
    installationId: number,
    repoFullName: string,
  ): Promise<GhPr[]> {
    const prs = await this.api<Record<string, unknown>[]>(
      installationId,
      `/repos/${repoFullName}/pulls?state=open&per_page=100`,
    );
    return prs.map(normalizePr);
  }
}

export class RateLimitedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitedError";
  }
}

function normalizePr(pr: Record<string, unknown>): GhPr {
  const user = (pr.user ?? {}) as Record<string, unknown>;
  const head = (pr.head ?? {}) as Record<string, unknown>;
  const base = (pr.base ?? {}) as Record<string, unknown>;
  const merged = Boolean(pr.merged);
  const stateRaw = String(pr.state ?? "open");
  const state: GhPr["state"] =
    merged || stateRaw === "closed"
      ? merged
        ? "merged"
        : "closed"
      : "open";
  const body = String(pr.body ?? "");
  return {
    number: Number(pr.number),
    title: String(pr.title ?? ""),
    body,
    author: String(user.login ?? ""),
    authorType: String(user.type ?? "User"),
    isBot: String(user.type ?? "") === "Bot",
    baseSha: String(base.sha ?? ""),
    headSha: String(head.sha ?? ""),
    headBranch: String(head.ref ?? ""),
    baseBranch: String(base.ref ?? ""),
    state,
    createdAt: String(pr.created_at ?? ""),
    updatedAt: String(pr.updated_at ?? ""),
    mergedAt: pr.merged_at === null ? null : String(pr.merged_at ?? ""),
    linkedIssues: linkedIssuesFromBody(body),
    forcePushes: 0,
    commitsAfterTouch: 0,
    url: String(pr.html_url ?? ""),
  };
}

/** In-memory fake for tests and the smoke script: no network, no
 *  credentials. Payloads are injected by the test. */
export class FakeGitHubClient implements GitHubClient {
  private prs = new Map<string, GhPr>();
  private files = new Map<string, GhFile[]>();
  private checks = new Map<string, GhCheck[]>();

  key(installationId: number, repo: string, pr: number): string {
    return `${installationId}:${repo}:${pr}`;
  }

  addPr(
    installationId: number,
    repo: string,
    pr: GhPr,
    files: GhFile[] = [],
    checks: GhCheck[] = [],
  ): void {
    const k = this.key(installationId, repo, pr.number);
    this.prs.set(k, pr);
    this.files.set(k, files);
    this.checks.set(k, checks);
  }

  async fetchPr(
    installationId: number,
    repoFullName: string,
    prNumber: number,
  ): Promise<GhPr> {
    const pr = this.prs.get(this.key(installationId, repoFullName, prNumber));
    if (!pr) throw new Error(`fake: PR #${prNumber} not found`);
    return { ...pr };
  }

  async fetchPrFiles(
    installationId: number,
    repoFullName: string,
    prNumber: number,
  ): Promise<GhFile[]> {
    return [
      ...(this.files.get(this.key(installationId, repoFullName, prNumber)) ??
        []),
    ];
  }

  async fetchPrChecks(
    installationId: number,
    repoFullName: string,
    pr: GhPr,
  ): Promise<GhCheck[]> {
    return [
      ...(this.checks.get(this.key(installationId, repoFullName, pr.number)) ??
        []),
    ];
  }

  async listOpenPrs(
    installationId: number,
    repoFullName: string,
  ): Promise<GhPr[]> {
    const out: GhPr[] = [];
    for (const [k, pr] of this.prs) {
      if (k.startsWith(`${installationId}:${repoFullName}:`) && pr.state === "open") {
        out.push({ ...pr });
      }
    }
    return out.sort((a, b) => a.number - b.number);
  }
}

/** A client that always fails: used when no GitHub App is configured. */
export class UnconfiguredGitHubClient implements GitHubClient {
  private fail(): never {
    throw new Error(
      "GitHub App not configured (set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY)",
    );
  }
  fetchPr(): Promise<GhPr> {
    this.fail();
  }
  fetchPrFiles(): Promise<GhFile[]> {
    this.fail();
  }
  fetchPrChecks(): Promise<GhCheck[]> {
    this.fail();
  }
  listOpenPrs(): Promise<GhPr[]> {
    this.fail();
  }
}
