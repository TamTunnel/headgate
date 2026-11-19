// Copyright 2026 TamTunnel. Licensed under the Apache License, Version 2.0.
// SPDX-License-Identifier: Apache-2.0

/**
 * GitHub helper probes:
 *   F5  empty added-line sets hash to "" (no shared empty-diff edge)
 *   F11 "See PR #123" is a PR reference, not a linked issue
 */

import test from "node:test";
import assert from "node:assert/strict";
import { diffHash, linkedIssuesFromBody } from "./github.js";

test("F5: diffHash is empty for an empty added-line set", () => {
  assert.equal(
    diffHash([{ path: "assets/a.png", additions: 0, deletions: 0, status: "added", patch: "" }]),
    "",
  );
  assert.equal(diffHash([]), "");
  // A non-empty added-line set still hashes deterministically.
  const h1 = diffHash([
    { path: "a.ts", additions: 1, deletions: 0, status: "modified", patch: "+const x = 1;\n" },
  ]);
  const h2 = diffHash([
    { path: "a.ts", additions: 1, deletions: 0, status: "modified", patch: "+const x = 1;\n" },
  ]);
  assert.ok(h1.length > 0);
  assert.equal(h1, h2);
});

test("F11: PR references are not linked issues", () => {
  assert.deepEqual(linkedIssuesFromBody("Fixes #42 and closes #7"), [7, 42]);
  assert.deepEqual(linkedIssuesFromBody("See PR #123 for the earlier attempt"), []);
  assert.deepEqual(linkedIssuesFromBody("See pull request #123"), []);
  assert.deepEqual(linkedIssuesFromBody("Version 2.0, see #99"), [99]);
  assert.deepEqual(linkedIssuesFromBody("Fixes #42, see PR #123"), [42]);
  // B3: plural/list forms are PR references too, not linked issues.
  assert.deepEqual(linkedIssuesFromBody("See PRs #123 and #124 for context"), []);
  assert.deepEqual(linkedIssuesFromBody("Blocked by PRs #123 and #124"), []);
  assert.deepEqual(linkedIssuesFromBody("See pull requests #7 and #8"), []);
  assert.deepEqual(linkedIssuesFromBody("Depends on PRs #123, #124"), []);
  assert.deepEqual(linkedIssuesFromBody("See PR #123 and #124"), []);
  // A PR reference followed by a real issue still yields the issue.
  assert.deepEqual(linkedIssuesFromBody("See PR #123, fixes #42"), [42]);
});

test("B5: non-comma/and separators in PR lists are not linked issues", () => {
  // Every phrasing from the round-3 judge probes (r3-b4, r3-b5-char).
  const cases: [string, number[]][] = [
    ["PRs #1; #2; #3", []],
    ["PRs #1 as well as #2", []],
    ["PRs #1 along with #2", []],
    ["PRs #1 + #2", []],
    ["PRs #1/#2", []],
    ["PRs #1 & #2", []],
    ["PRs #1 or #2", []],
    ["PRs #1 with #2", []],
    ["PRs #1 and also #2", []],
    ["PRs #1 plus #2", []],
    ["PRs #1 through #3", []],
    ["PRs #1 to #3", []],
    ["pull requests #7; #8", []],
    ["PRs #1, #2; and #3", []],
    ["PRs #1; #2, #3", []],
    ["PRs #1, #2 & #3", []],
    ["PRs #1; #2; and #3", []],
    ["PRs #1; #2 and fixes #9", [9]],
    ["fixes #9; PRs #1; #2", [9]],
    ["PR #1; #2", []],
    ["pull requests #7 as well as #8", []],
    ["pull requests #7 along with #8", []],
    ["PRs #1, #2, etc.", []],
    ["PRs #1 and #2, #3", []],
    ["PRs #1,\n#2,\nand #3", []],
    // Keyword lists must keep working, whatever the separator.
    ["fixes #9, #10", [9, 10]],
    ["fixes #9; #10", [9, 10]],
    ["closes #7 and #8", [7, 8]],
  ];
  for (const [body, want] of cases) {
    assert.deepEqual(linkedIssuesFromBody(body), want, body);
  }
});

test("B5: PR lists with arbitrary separators are not linked issues (fuzz)", () => {
  // N12: the rule is "any separator token", so fuzz separator × list
  // length instead of enumerating one more separator family. Seeded
  // PRNG (mulberry32) so the test is stable run to run.
  const separators = [
    ";", "&", "or", "with", "and also", "plus", "through", "to", "+",
    "/", "as well as", "along with", ",", ", and", "and",
  ];
  let seed = 0x5eed;
  const rand = (): number => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
  const leads = ["PRs", "PR", "pull requests", "pull request"];
  for (let i = 0; i < 200; i++) {
    const n = 2 + Math.floor(rand() * 4); // list length 2–5
    const nums = Array.from({ length: n }, (_, k) => 100 + i * 10 + k);
    const lead = pick(leads);
    const body =
      `${lead} ` +
      nums
        .map((num, k) => (k === 0 ? `#${num}` : `${pick(separators)} #${num}`))
        .join(" ");
    assert.deepEqual(linkedIssuesFromBody(body), [], body);
  }
  // Keyword-led lists still yield their numbers, whatever separates them.
  for (const sep of separators) {
    assert.deepEqual(
      linkedIssuesFromBody(`fixes #9${sep} #10`),
      [9, 10],
      `fixes #9${sep} #10`,
    );
    assert.deepEqual(
      linkedIssuesFromBody(`closes #7${sep} #8`),
      [7, 8],
      `closes #7${sep} #8`,
    );
  }
});

test("B4: Oxford-comma PR lists are not linked issues", () => {
  // The Oxford form has two separators (", and"); the whole list is
  // one PR reference, not a linked issue.
  assert.deepEqual(linkedIssuesFromBody("PRs #1, #2, and #3"), []);
  assert.deepEqual(linkedIssuesFromBody("pull requests #7, #8, and #9"), []);
  assert.deepEqual(linkedIssuesFromBody("PR #1, #2, and #3"), []);
  assert.deepEqual(linkedIssuesFromBody("PRs #1 and #2, and #3"), []);
  // Non-Oxford forms and the real-issue cases still hold (P12a/P12c).
  assert.deepEqual(linkedIssuesFromBody("PRs #1, #2 and #3"), []);
  assert.deepEqual(linkedIssuesFromBody("Fixes #42 and closes #7"), [7, 42]);
  assert.deepEqual(linkedIssuesFromBody("Version 2.0, see #99"), [99]);
  assert.deepEqual(linkedIssuesFromBody("PRs #1, #2 and fixes #9"), [9]);
});

test("B7: punctuation between the PR keyword and the first #N is not a linked issue", () => {
  // Every phrasing from the round-4 judge probe (r4-colon.mts): the
  // lead takes the same general separator class as the continuation.
  const cases: [string, number[]][] = [
    ["PRs: #1, #2, #3", []],
    ["PR: #1, #2", []],
    ["pull requests: #7, #8", []],
    ["pull request: #7", []],
    ["PRs - #1, #2", []],
    ["PRs — #1, #2", []],
    ["PRs (#1, #2)", []],
    ["PRs[#1, #2]", []],
    ["PRs = #1, #2", []],
    ["PRs: #1; #2", []],
    ["Related PRs: #1, #2", []],
    ["Depends on PRs: #123, #124", []],
    ["PRs : #1, #2", []],
    // A word between the keyword and #N is not a separator: the
    // keyword-led reference after it is a real issue.
    ["PRs fixes #9", [9]],
    ["PRs: #1, #2 and fixes #9", [9]],
    ["Related PRs: #1, #2; fixes #9", [9]],
    ["pull-request #1, closes #8", [8]],
    // Hyphenated keyword forms are PR references too.
    ["pull-request #1", []],
    ["pull-requests #1, #2", []],
    ["pull request-#1", []],
    ["PR-#1", []],
    ["pull-request: #1, #2", []],
  ];
  for (const [body, want] of cases) {
    assert.deepEqual(linkedIssuesFromBody(body), want, body);
  }
});

test("B7: punctuated PR leads are not linked issues (fuzz)", () => {
  // The lead generalizes the same way the continuation did (B5/N12):
  // fuzz lead punctuation × separator × list length × lead form.
  // Seeded PRNG (mulberry32) so the test is stable run to run.
  const leadPuncts = [":", "-", "—", "(", "[", "=", " :", " ", ""];
  const separators = [
    ";", "&", "or", "with", "and also", "plus", "through", "to", "+",
    "/", "as well as", "along with", ",", ", and", "and",
  ];
  const leads = [
    "PRs", "PR", "pull requests", "pull request",
    "pull-requests", "pull-request",
  ];
  let seed = 0xb7f007;
  const rand = (): number => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];
  for (let i = 0; i < 250; i++) {
    const n = 1 + Math.floor(rand() * 5); // list length 1–5
    const nums = Array.from({ length: n }, (_, k) => 200 + i * 10 + k);
    const body =
      `${pick(leads)}${pick(leadPuncts)}` +
      nums
        .map((num, k) => (k === 0 ? `#${num}` : `${pick(separators)} #${num}`))
        .join(" ");
    assert.deepEqual(linkedIssuesFromBody(body), [], body);
  }
  // Keyword-led lists still yield their numbers after a punctuated lead.
  for (const punct of leadPuncts) {
    assert.deepEqual(
      linkedIssuesFromBody(`PRs${punct} #1, #2 and fixes #9`),
      [9],
      `PRs${punct} #1, #2 and fixes #9`,
    );
  }
});
