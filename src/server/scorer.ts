// Copyright 2026 TamTunnel. Licensed under the Apache License, Version 2.0.
// SPDX-License-Identifier: Apache-2.0

/**
 * Deterministic risk scorer (pure function — no I/O, no LLM, no clock
 * except the snapshot's own timestamps).
 *
 * Score 0-100 + band (low/medium/high/critical). Every point is recorded
 * as a signal with points + evidence, and the signals always sum exactly
 * to the total: when clamping would break that, a `clamp` signal carries
 * the difference (D-3). Weights are FIXED in v1 — no per-repo weight
 * config. The only config is the sensitive-path list (repo config).
 *
 * Signals (max points):
 *   size        25  log-scaled lines changed + files touched, capped
 *   blast       24  +12 per sensitive path matched, capped
 *   tests       10  red +10, no CI +8, pending +2, green 0
 *   author      23  bot baseline +5, first PR in repo +8, prior reverts +5 each (cap 10)
 *   overlap     20  +5 per overlapping open PR sharing files (cap 15), +5 shared linked issue
 *   churn       10  force-pushes +3 each, commits after first human touch +2 each
 *   staleness   10  1 per day without human touch, capped
 *   duplicate   20  near-identical diff to another open PR
 *   static      20  +5 per pattern finding (cap 20)
 */

export interface ScoreSignal {
  name: string;
  points: number;
  evidence: string;
}

export interface RiskScore {
  score: number;
  band: "low" | "medium" | "high" | "critical";
  signals: ScoreSignal[];
}

export interface ScorerFile {
  path: string;
  additions: number;
  deletions: number;
  patch: string;
}

export interface ScorerCheck {
  name: string;
  status: string;
  conclusion: string | null;
}

export interface AuthorContext {
  /** Bot-authored PRs carry a baseline; human PRs do not. */
  isBot: boolean;
  /** True when the author has no earlier PR in this repo. */
  firstPrInRepo: boolean;
  /** Number of prior reverts by this author in this repo (capped). */
  priorReverts: number;
}

export interface OverlapContext {
  /** Number of other open PRs sharing at least one changed file. */
  overlappingPrs: number;
  /** True when another open PR links the same issue/ticket. */
  sharesLinkedIssue: boolean;
}

export interface ScorerInput {
  files: ScorerFile[];
  checks: ScorerCheck[];
  author: AuthorContext;
  overlap: OverlapContext;
  /** Force-pushes on this PR. */
  forcePushes: number;
  /** New commits after the first human touch. */
  commitsAfterTouch: number;
  /** Whole days since the last human touch (0 = touched today). */
  daysStale: number;
  /** Diff hash (of the normalized added-line set) of another open PR. */
  duplicateOfPr: number | null;
  /** Sensitive paths for this repo (config, not code). */
  sensitivePaths: string[];
  /** ISO timestamp of the PR's last update; used only for evidence text. */
  updatedAt?: string;
}

export function bandFor(score: number): RiskScore["band"] {
  if (score >= 75) return "critical";
  if (score >= 50) return "high";
  if (score >= 25) return "medium";
  return "low";
}

const DEFAULT_SENSITIVE_PATHS = [
  "src/auth",
  "auth/",
  "src/payments",
  "payments/",
  "migrations/",
  "db/migrate",
  ".github/workflows",
  "ci/",
  "secrets",
  "credentials",
  "src/security",
  "security/",
];

export function defaultSensitivePaths(): string[] {
  return [...DEFAULT_SENSITIVE_PATHS];
}

function isSensitivePath(path: string, sensitivePaths: string[]): string | null {
  const lower = path.toLowerCase();
  for (const pattern of sensitivePaths) {
    const p = pattern.toLowerCase();
    if (lower.includes(p)) return pattern;
  }
  return null;
}

/** Deterministic pattern checks over added lines (regex; TS/JS focused).
 *  The REA adapter is out of the MVP build — these regex checks are the
 *  v1 static signal. Findings are signals, never verdicts. */
export interface StaticFinding {
  kind: string;
  evidence: string;
}

const STATIC_PATTERNS: { kind: string; re: RegExp }[] = [
  {
    kind: "subprocess",
    re: /\b(child_process|exec\s*\(|execSync|spawn\s*\(|execFile|shelljs|zx\b)/,
  },
  { kind: "network", re: /\b(fetch\s*\(|axios\.|http\.request|https\.request|net\.connect|WebSocket\s*\()/ },
  {
    kind: "credentials",
    re: /\b(password|api[_-]?key|access[_-]?token|secret|private[_-]?key)\s*[:=]\s*['"][^'"]+['"]/,
  },
  { kind: "eval", re: /\b(eval\s*\(|new\s+Function\s*\()/ },
];

export function staticFindings(files: ScorerFile[]): StaticFinding[] {
  const findings: StaticFinding[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    if (!file.patch) continue;
    // Strip the leading '+' from each added line before joining (F10):
    // a call split across lines (`spawn` on one line, `('ls')` on the
    // next) must still match `spawn\s*\(`, and the '+' between the
    // lines defeated every multi-line pattern.
    const added = file.patch
      .split("\n")
      .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
      .map((l) => l.slice(1))
      .join("\n");
    for (const { kind, re } of STATIC_PATTERNS) {
      const m = re.exec(added);
      if (m && !seen.has(`${kind}:${file.path}`)) {
        seen.add(`${kind}:${file.path}`);
        // Never carry a credential literal into score evidence: the
        // evidence is displayed in the dashboard and the digest email.
        const snippet = m[0]
          .trim()
          .slice(0, 80)
          .replace(/['"][^'"]{8,}['"]/g, "'[redacted]'");
        findings.push({ kind, evidence: `${file.path}: ${snippet}` });
      }
    }
    // Dependency additions: package.json gains a dependency.
    if (file.path.endsWith("package.json")) {
      const addedDeps = added.match(/"[^"]+"\s*:\s*"[^"]*"/g) ?? [];
      if (addedDeps.length > 0) {
        findings.push({
          kind: "dependency",
          evidence: `${file.path}: ${addedDeps.length} new dependency entr${addedDeps.length === 1 ? "y" : "ies"}`,
        });
      }
    }
  }
  return findings;
}

export function scorePr(input: ScorerInput): RiskScore {
  // F6: every numeric input is clamped to >= 0 (non-finite -> 0) before
  // it can reach a signal. GitHub should never return negative counts,
  // but the scorer is fed by stored snapshots — one corrupt snapshot
  // used to persist a NaN score (log10 of a negative) into the DB.
  const nonNeg = (n: number): number =>
    Number.isFinite(n) ? Math.max(0, n) : 0;
  const files = input.files.map((f) => ({
    ...f,
    additions: nonNeg(f.additions),
    deletions: nonNeg(f.deletions),
  }));
  const forcePushes = nonNeg(input.forcePushes);
  const commitsAfterTouch = nonNeg(input.commitsAfterTouch);
  const daysStale = nonNeg(input.daysStale);
  const priorReverts = nonNeg(input.author.priorReverts);
  const overlappingPrs = nonNeg(input.overlap.overlappingPrs);

  const signals: ScoreSignal[] = [];
  const add = (name: string, points: number, evidence: string): void => {
    // Each computed signal is clamped to >= 0 as well; the `clamp`
    // signal below is the only one allowed to go negative (D-3).
    if (points !== 0) signals.push({ name, points: Math.max(0, points), evidence });
  };

  // Size: log-scaled lines changed + files touched, capped at 25.
  const lines = files.reduce((n, f) => n + f.additions + f.deletions, 0);
  const fileCount = files.length;
  const sizePoints = Math.min(
    25,
    Math.round(10 * Math.log10(1 + lines / 100)) +
      Math.min(5, Math.floor(fileCount / 10)),
  );
  add("size", sizePoints, `${lines} lines changed across ${fileCount} files`);

  // Blast radius: sensitive paths.
  const matched: string[] = [];
  for (const f of files) {
    const hit = isSensitivePath(f.path, input.sensitivePaths);
    if (hit && !matched.includes(hit)) matched.push(hit);
  }
  add(
    "blast",
    Math.min(24, matched.length * 12),
    matched.length > 0
      ? `touches sensitive paths: ${matched.join(", ")}`
      : "no sensitive paths touched",
  );

  // Test status: green lowers relative to the alternatives; red and
  // no-CI raise. Pending is near-neutral.
  const conclusions = input.checks.map((c) => c.conclusion ?? c.status);
  let testPoints = 0;
  let testEvidence = "no CI configured";
  if (input.checks.length === 0) {
    testPoints = 8;
  } else if (conclusions.some((c) => c === "failure" || c === "cancelled" || c === "timed_out")) {
    testPoints = 10;
    testEvidence = "CI failing";
  } else if (conclusions.some((c) => c === "success")) {
    testPoints = 0;
    testEvidence = "CI green";
  } else {
    testPoints = 2;
    testEvidence = "CI pending";
  }
  add("tests", testPoints, testEvidence);

  // Author fleet.
  let authorPoints = 0;
  const authorEvidence: string[] = [];
  if (input.author.isBot) {
    authorPoints += 5;
    authorEvidence.push("bot-authored baseline");
  }
  if (input.author.firstPrInRepo) {
    authorPoints += 8;
    authorEvidence.push("author's first PR in this repo");
  }
  if (priorReverts > 0) {
    const p = Math.min(10, priorReverts * 5);
    authorPoints += p;
    authorEvidence.push(`${priorReverts} prior revert(s) by this author`);
  }
  add("author", authorPoints, authorEvidence.join("; ") || "human author, no fleet signals");

  // Overlap.
  let overlapPoints = 0;
  const overlapEvidence: string[] = [];
  if (overlappingPrs > 0) {
    overlapPoints += Math.min(15, overlappingPrs * 5);
    overlapEvidence.push(
      `shares files with ${overlappingPrs} other open PR(s)`,
    );
  }
  if (input.overlap.sharesLinkedIssue) {
    overlapPoints += 5;
    overlapEvidence.push("shares a linked issue with another open PR");
  }
  add("overlap", overlapPoints, overlapEvidence.join("; ") || "no overlap with other open PRs");

  // Churn.
  const churnPoints = Math.min(
    10,
    forcePushes * 3 + commitsAfterTouch * 2,
  );
  add(
    "churn",
    churnPoints,
    `${forcePushes} force-push(es), ${commitsAfterTouch} commit(s) after first human touch`,
  );

  // Staleness, capped at 10.
  const stalePoints = Math.min(10, Math.max(0, daysStale));
  add("staleness", stalePoints, `${daysStale} day(s) without human touch`);

  // Duplication.
  add(
    "duplicate",
    input.duplicateOfPr !== null ? 20 : 0,
    input.duplicateOfPr !== null
      ? `near-identical diff to open PR #${input.duplicateOfPr}`
      : "no near-identical diff among open PRs",
  );

  // Static pattern findings.
  const findings = staticFindings(files);
  const staticPoints = Math.min(20, findings.length * 5);
  add(
    "static",
    staticPoints,
    findings.length > 0
      ? findings.map((f) => `${f.kind} (${f.evidence})`).join("; ")
      : "no static pattern findings",
  );

  // Total: clamp to 0-100, and keep signals summing exactly to the total
  // by recording the clamp as its own signal (D-3). A non-finite total
  // is a bug, not a score: throw rather than store NaN (F6).
  const raw = signals.reduce((n, s) => n + s.points, 0);
  const total = Math.min(100, Math.max(0, raw));
  if (!Number.isFinite(total)) {
    throw new Error(`scorer produced a non-finite total (raw=${raw})`);
  }
  if (total !== raw) {
    signals.push({
      name: "clamp",
      points: total - raw,
      evidence: `total clamped from ${raw} to ${total}`,
    });
  }
  return { score: total, band: bandFor(total), signals };
}

/** Top reasons for display: the three largest positive signals. */
export function topReasons(score: RiskScore, n = 3): string[] {
  return score.signals
    .filter((s) => s.points > 0 && s.name !== "clamp")
    .sort((a, b) => b.points - a.points || a.name.localeCompare(b.name))
    .slice(0, n)
    .map((s) => `${s.name} +${s.points}: ${s.evidence}`);
}
