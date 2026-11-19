// Copyright 2026 TamTunnel. Licensed under the Apache License, Version 2.0.
// SPDX-License-Identifier: Apache-2.0

/**
 * Clusterer probes:
 *   D-2 clustering determinism (shuffle ingestion order -> same clusters)
 *   edge rules: Jaccard >= 0.5, shared issue, branch lineage, diff hash
 *   singletons are clusters of one
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  clusterPrs,
  jaccard,
  sameBranchLineage,
  type ClusterPr,
} from "./cluster.js";

function pr(number: number, overrides: Partial<ClusterPr> = {}): ClusterPr {
  return {
    number,
    files: [`src/file${number}.ts`],
    linkedIssues: [],
    headBranch: `agent/${number}-work`,
    diffHash: `hash-${number}`,
    ...overrides,
  };
}

test("jaccard: identical sets are 1, disjoint sets are 0", () => {
  assert.equal(jaccard(new Set(["a", "b"]), new Set(["a", "b"])), 1);
  assert.equal(jaccard(new Set(["a"]), new Set(["b"])), 0);
  assert.equal(jaccard(new Set(["a", "b", "c"]), new Set(["b", "c", "d"])), 0.5);
});

test("edges: Jaccard >= 0.5 on changed files clusters PRs", () => {
  const clusters = clusterPrs([
    pr(1, { files: ["a.ts", "b.ts", "c.ts"], headBranch: "x/1", diffHash: "h1" }),
    pr(2, { files: ["b.ts", "c.ts", "d.ts"], headBranch: "y/2", diffHash: "h2" }),
    pr(3, { files: ["z.ts"], headBranch: "w/3", diffHash: "h3" }),
  ]);
  assert.equal(clusters.length, 2);
  const multi = clusters.find((c) => c.members.length === 2);
  assert.deepEqual(multi?.members, [1, 2]);
  assert.ok(multi?.edges.some((e) => e.kind === "files"));
  const single = clusters.find((c) => c.members.length === 1);
  assert.deepEqual(single?.members, [3]);
});

test("edges: same linked issue clusters PRs with disjoint files", () => {
  const clusters = clusterPrs([
    pr(1, { files: ["a.ts"], linkedIssues: [42], headBranch: "x/1", diffHash: "h1" }),
    pr(2, { files: ["b.ts"], linkedIssues: [42], headBranch: "y/2", diffHash: "h2" }),
  ]);
  assert.equal(clusters.length, 1);
  assert.deepEqual(clusters[0].members, [1, 2]);
  assert.ok(clusters[0].edges.some((e) => e.kind === "issue"));
});

test("edges: same head-branch lineage clusters PRs", () => {
  assert.equal(sameBranchLineage("devin/123-a", "devin/456-b"), true);
  assert.equal(sameBranchLineage("devin/123-a", "codex/123-a"), false);
  assert.equal(sameBranchLineage("main", "main"), true);
  assert.equal(sameBranchLineage("main", "feature"), false);
  const clusters = clusterPrs([
    pr(1, { files: ["a.ts"], headBranch: "devin/1-x", diffHash: "h1" }),
    pr(2, { files: ["b.ts"], headBranch: "devin/2-y", diffHash: "h2" }),
  ]);
  assert.equal(clusters.length, 1);
  assert.ok(clusters[0].edges.some((e) => e.kind === "branch"));
});

test("edges: near-identical diff hash clusters PRs", () => {
  const clusters = clusterPrs([
    pr(1, { files: ["a.ts"], headBranch: "x/1", diffHash: "same-diff" }),
    pr(2, { files: ["b.ts"], headBranch: "y/2", diffHash: "same-diff" }),
  ]);
  assert.equal(clusters.length, 1);
  assert.ok(clusters[0].edges.some((e) => e.kind === "diff"));
});

test("singletons are clusters of one", () => {
  const clusters = clusterPrs([
    pr(1, { headBranch: "solo-a/1" }),
    pr(2, { headBranch: "solo-b/2" }),
    pr(3, { headBranch: "solo-c/3" }),
  ]);
  assert.equal(clusters.length, 3);
  for (const c of clusters) assert.equal(c.members.length, 1);
});

test("F4: feature/* and dependabot/* prefixes do not imply related work", () => {
  const feature = clusterPrs([
    pr(1, { headBranch: "feature/login", files: ["src/login.ts"], diffHash: "h1" }),
    pr(2, { headBranch: "feature/payments", files: ["src/pay.ts"], diffHash: "h2" }),
  ]);
  assert.equal(feature.length, 2);
  const dependabot = clusterPrs([
    pr(1, { headBranch: "dependabot/npm_and_yarn/lodash-4.17.21", files: ["package.json"], diffHash: "h1" }),
    pr(2, { headBranch: "dependabot/npm_and_yarn/react-19.0.0", files: ["package-lock.json"], diffHash: "h2" }),
    pr(3, { headBranch: "dependabot/npm_and_yarn/axios-1.7.0", files: ["yarn.lock"], diffHash: "h3" }),
  ]);
  assert.equal(dependabot.length, 3);
  // The allowlist is config, not code: a custom list can admit a prefix.
  const custom = clusterPrs(
    [
      pr(1, { headBranch: "feature/login", files: ["src/login.ts"], diffHash: "h1" }),
      pr(2, { headBranch: "feature/payments", files: ["src/pay.ts"], diffHash: "h2" }),
    ],
    ["feature"],
  );
  assert.equal(custom.length, 1);
});

test("F5: two file-less PRs share nothing (Jaccard 0, no cluster)", () => {
  assert.equal(jaccard(new Set(), new Set()), 0);
  // Non-agent branches, so the branch edge must not fire either: the
  // only candidate edge is file similarity, and empty sets share nothing.
  // (The pr() default branch is agent/N-work, which IS an agent prefix
  // and would cluster them by the branch edge — that is legitimate.)
  const clusters = clusterPrs([
    pr(1, { files: [], diffHash: "", headBranch: "feature/1-x" }),
    pr(2, { files: [], diffHash: "", headBranch: "feature/2-y" }),
  ]);
  assert.equal(clusters.length, 2);
  // Two file-less PRs on the SAME agent prefix still cluster — by the
  // branch edge, not by file similarity.
  const agentClusters = clusterPrs([
    pr(1, { files: [], diffHash: "" }),
    pr(2, { files: [], diffHash: "" }),
  ]);
  assert.equal(agentClusters.length, 1);
  assert.equal(agentClusters[0].edges[0].kind, "branch");
});

test("D-2: shuffle ingestion order -> identical clusters (property test)", () => {
  const base: ClusterPr[] = [
    pr(1, { files: ["a.ts", "b.ts"], linkedIssues: [10], headBranch: "devin/1-a", diffHash: "d1" }),
    pr(2, { files: ["b.ts", "c.ts"], linkedIssues: [], headBranch: "codex/2-b", diffHash: "d2" }),
    pr(3, { files: ["x.ts"], linkedIssues: [10], headBranch: "devin/3-c", diffHash: "d3" }),
    pr(4, { files: ["y.ts"], linkedIssues: [], headBranch: "other/4-d", diffHash: "d1" }),
    pr(5, { files: ["z.ts"], linkedIssues: [99], headBranch: "solo/5-e", diffHash: "d5" }),
    pr(6, { files: ["a.ts", "b.ts", "c.ts", "d.ts"], linkedIssues: [], headBranch: "devin/6-f", diffHash: "d6" }),
  ];
  const canonical = clusterPrs(base);
  // Deterministic shuffle with a fixed seed (mulberry32).
  const shuffle = (arr: ClusterPr[], seed: number): ClusterPr[] => {
    const out = [...arr];
    let s = seed;
    const rand = (): number => {
      s |= 0;
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };
  for (let seed = 1; seed <= 20; seed++) {
    const shuffled = clusterPrs(shuffle(base, seed));
    assert.equal(
      JSON.stringify(shuffled),
      JSON.stringify(canonical),
      `seed ${seed}: shuffled clusters differ`,
    );
  }
  // And the grouping itself: 1-2-3-4-6 connect, 5 is a singleton.
  assert.equal(canonical.length, 2);
  const big = canonical.find((c) => c.members.length > 1);
  assert.deepEqual(big?.members, [1, 2, 3, 4, 6]);
});
