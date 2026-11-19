// Copyright 2026 TamTunnel. Licensed under the Apache License, Version 2.0.
// SPDX-License-Identifier: Apache-2.0

/**
 * Scorer probes:
 *   D-1 score determinism (same snapshot -> byte-identical JSON)
 *   D-3 score explainability (signals sum exactly to the total)
 *   bands, size cap, static pattern findings, author/overlap signals
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  scorePr,
  staticFindings,
  topReasons,
  type ScorerInput,
} from "./scorer.js";

function baseInput(overrides: Partial<ScorerInput> = {}): ScorerInput {
  return {
    files: [{ path: "src/app.ts", additions: 120, deletions: 30, patch: "" }],
    checks: [{ name: "ci", status: "completed", conclusion: "success" }],
    author: { isBot: true, firstPrInRepo: false, priorReverts: 0 },
    overlap: { overlappingPrs: 0, sharesLinkedIssue: false },
    forcePushes: 0,
    commitsAfterTouch: 0,
    daysStale: 0,
    duplicateOfPr: null,
    sensitivePaths: ["src/auth", "payments/", "migrations/"],
    ...overrides,
  };
}

test("D-1: the same snapshot scores byte-identically every time", () => {
  const input = baseInput({
    files: [
      { path: "src/auth/login.ts", additions: 400, deletions: 50, patch: "+const x = require('child_process');\n" },
      { path: "src/app.ts", additions: 120, deletions: 30, patch: "" },
    ],
    overlap: { overlappingPrs: 2, sharesLinkedIssue: true },
    daysStale: 4,
  });
  const a = scorePr(input);
  const b = scorePr(input);
  const c = scorePr(structuredClone(input));
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.equal(JSON.stringify(a), JSON.stringify(c));
});

test("D-3: signals always sum exactly to the total (no unexplained points)", () => {
  const cases: ScorerInput[] = [
    baseInput(),
    baseInput({ files: [{ path: "src/auth/x.ts", additions: 5000, deletions: 2000, patch: "" }] }),
    baseInput({ checks: [], author: { isBot: true, firstPrInRepo: true, priorReverts: 3 } }),
    baseInput({
      files: [{ path: "a.ts", additions: 9000, deletions: 9000, patch: "+exec('rm -rf /')\n+fetch('https://evil.example')\n" }],
      overlap: { overlappingPrs: 10, sharesLinkedIssue: true },
      forcePushes: 5,
      commitsAfterTouch: 5,
      daysStale: 30,
      duplicateOfPr: 42,
      author: { isBot: true, firstPrInRepo: true, priorReverts: 5 },
    }),
    baseInput({ checks: [{ name: "ci", status: "completed", conclusion: "success" }], files: [] }),
  ];
  for (const input of cases) {
    const s = scorePr(input);
    const sum = s.signals.reduce((n, sig) => n + sig.points, 0);
    assert.equal(sum, s.score, `signals sum ${sum} != total ${s.score}: ${JSON.stringify(s)}`);
    assert.ok(s.score >= 0 && s.score <= 100);
  }
});

test("bands: thresholds are low <25, medium <50, high <75, critical >=75", () => {
  const low = scorePr(baseInput({ files: [], checks: [{ name: "ci", status: "completed", conclusion: "success" }], author: { isBot: false, firstPrInRepo: false, priorReverts: 0 } }));
  assert.equal(low.band, "low");
  const critical = scorePr(
    baseInput({
      files: [{ path: "src/auth/x.ts", additions: 9000, deletions: 1000, patch: "" }],
      checks: [{ name: "ci", status: "completed", conclusion: "failure" }],
      author: { isBot: true, firstPrInRepo: true, priorReverts: 2 },
      duplicateOfPr: 7,
      daysStale: 10,
    }),
  );
  assert.equal(critical.band, "critical");
  assert.ok(critical.score >= 75);
});

test("size is log-scaled and capped: a 5000-line PR is not 10x a 500-line one", () => {
  const small = scorePr(baseInput({ files: [{ path: "a.ts", additions: 400, deletions: 100, patch: "" }] }));
  const huge = scorePr(baseInput({ files: [{ path: "a.ts", additions: 4000, deletions: 1000, patch: "" }] }));
  const smallSize = small.signals.find((s) => s.name === "size")?.points ?? 0;
  const hugeSize = huge.signals.find((s) => s.name === "size")?.points ?? 0;
  assert.ok(hugeSize <= 25, `size capped at 25, got ${hugeSize}`);
  assert.ok(hugeSize < smallSize * 3, `huge ${hugeSize} vs small ${smallSize}`);
});

test("blast radius: sensitive paths raise the score with evidence", () => {
  const s = scorePr(
    baseInput({
      files: [
        { path: "src/auth/login.ts", additions: 10, deletions: 0, patch: "" },
        { path: "db/migrations/001.sql", additions: 5, deletions: 0, patch: "" },
      ],
      sensitivePaths: ["src/auth", "migrations/"],
    }),
  );
  const blast = s.signals.find((x) => x.name === "blast");
  assert.ok(blast);
  assert.equal(blast.points, 24);
  assert.match(blast.evidence, /src\/auth/);
});

test("test status: red raises, no CI raises, green is the baseline", () => {
  const green = scorePr(baseInput());
  const red = scorePr(baseInput({ checks: [{ name: "ci", status: "completed", conclusion: "failure" }] }));
  const none = scorePr(baseInput({ checks: [] }));
  // A zero-point signal is omitted from the list (nothing to explain).
  const greenTests = green.signals.find((s) => s.name === "tests");
  const redTests = red.signals.find((s) => s.name === "tests")?.points ?? 0;
  const noneTests = none.signals.find((s) => s.name === "tests")?.points ?? 0;
  assert.equal(greenTests, undefined);
  assert.equal(redTests, 10);
  assert.equal(noneTests, 8);
});

test("static findings: subprocess, network, credentials, dependency additions", () => {
  const findings = staticFindings([
    {
      path: "src/worker.ts",
      additions: 5,
      deletions: 0,
      patch: "+import { exec } from 'child_process';\n+exec('ls');\n+fetch('https://api.example.com');\n",
    },
    {
      path: "package.json",
      additions: 3,
      deletions: 0,
      patch: "+\t\"left-pad\": \"^1.3.0\",\n",
    },
  ]);
  const kinds = findings.map((f) => f.kind).sort();
  assert.deepEqual(kinds, ["dependency", "network", "subprocess"]);
  const cred = staticFindings([
    {
      path: "src/config.ts",
      additions: 1,
      deletions: 0,
      patch: "+const api_key = 'sk-live-1234567890abcdef';\n",
    },
  ]);
  assert.equal(cred[0]?.kind, "credentials");
});

test("topReasons lists the three largest positive signals", () => {
  const s = scorePr(
    baseInput({
      files: [{ path: "src/auth/x.ts", additions: 5000, deletions: 1000, patch: "" }],
      checks: [{ name: "ci", status: "completed", conclusion: "failure" }],
      duplicateOfPr: 3,
    }),
  );
  const reasons = topReasons(s);
  assert.ok(reasons.length <= 3);
  assert.ok(reasons.length >= 1);
  assert.match(reasons[0], /\+/);
});

test("F6: negative inputs clamp to finite scores with non-negative signals", () => {
  const neg = scorePr(
    baseInput({
      files: [{ path: "a.ts", additions: -200, deletions: -50, patch: "" }],
      forcePushes: -3,
      commitsAfterTouch: -2,
      daysStale: -5,
      author: { isBot: false, firstPrInRepo: false, priorReverts: -4 },
      overlap: { overlappingPrs: -2, sharesLinkedIssue: false },
    }),
  );
  assert.ok(Number.isFinite(neg.score));
  assert.ok(neg.score >= 0 && neg.score <= 100);
  assert.ok(neg.signals.every((s) => s.points >= 0 || s.name === "clamp"));
  const sum = neg.signals.reduce((n, s) => n + s.points, 0);
  assert.equal(sum, neg.score);
  // A non-finite input never produces a NaN score either.
  const nan = scorePr(
    baseInput({
      files: [{ path: "a.ts", additions: Number.NaN, deletions: 0, patch: "" }],
    }),
  );
  assert.ok(Number.isFinite(nan.score));
});

test("F10: a call split across lines still yields the static finding", () => {
  const findings = staticFindings([
    { path: "a.ts", additions: 2, deletions: 0, patch: "+spawn\n+('ls')" },
  ]);
  assert.deepEqual(findings.map((f) => f.kind), ["subprocess"]);
  // Single-line calls still match, and the '+' marker never leaks
  // into evidence.
  const single = staticFindings([
    { path: "a.ts", additions: 1, deletions: 0, patch: "+exec('ls')" },
  ]);
  assert.deepEqual(single.map((f) => f.kind), ["subprocess"]);
});
