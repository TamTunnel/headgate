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
