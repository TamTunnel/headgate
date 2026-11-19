// Copyright 2026 TamTunnel. Licensed under the Apache License, Version 2.0.
// SPDX-License-Identifier: Apache-2.0

/**
 * Deterministic clusterer (pure function). Builds a graph over the open
 * PRs of one repo; connected components are clusters. Singletons are
 * clusters of one.
 *
 * Edges (any one forms an edge):
 *   - Jaccard similarity >= 0.5 on changed-file sets
 *   - same linked issue / ticket
 *   - same head-branch lineage (same branch, or same prefix before '/')
 *   - near-identical diff hash
 *
 * Deterministic regardless of ingestion order (D-2): members are always
 * sorted by PR number, the cluster key is a hash of the sorted member
 * list, and output order is by key. Human corrections (split/merge) are
 * applied on top by the store layer, not here.
 */

import { createHash } from "node:crypto";

export interface ClusterPr {
  number: number;
  files: string[];
  linkedIssues: number[];
  headBranch: string;
  diffHash: string;
}

export interface ClusterEdge {
  kind: "files" | "issue" | "branch" | "diff";
  detail: string;
}

export interface Cluster {
  key: string;
  members: number[];
  edges: ClusterEdge[];
}

export const FILE_JACCARD_THRESHOLD = 0.5;

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** Branch lineage: same branch, or the same prefix before the first '/'
 *  (e.g. `devin/123-foo` and `devin/456-bar` share the `devin` agent
 *  session prefix). A bare branch with no '/' never matches another
 *  branch by prefix. */
export function sameBranchLineage(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const pa = a.split("/")[0];
  const pb = b.split("/")[0];
  return a.includes("/") && b.includes("/") && pa === pb && pa.length > 0;
}

export function clusterKey(members: number[]): string {
  const sorted = [...members].sort((x, y) => x - y);
  return createHash("sha256")
    .update(JSON.stringify(sorted))
    .digest("hex")
    .slice(0, 16);
}

export function clusterPrs(prs: ClusterPr[]): Cluster[] {
  const sorted = [...prs].sort((a, b) => a.number - b.number);
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let p = parent.get(x) ?? x;
    while (parent.get(p) !== undefined && parent.get(p) !== p) {
      p = parent.get(p) as number;
    }
    // Path compression.
    let cur = x;
    while (parent.get(cur) !== undefined && parent.get(cur) !== p) {
      const next = parent.get(cur) as number;
      parent.set(cur, p);
      cur = next;
    }
    return p;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(Math.max(ra, rb), Math.min(ra, rb));
  };
  for (const pr of sorted) parent.set(pr.number, pr.number);

  const allEdges: { a: number; b: number; edge: ClusterEdge }[] = [];
  const addEdge = (a: number, b: number, edge: ClusterEdge): void => {
    union(a, b);
    allEdges.push({ a, b, edge });
  };

  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i];
      const b = sorted[j];
      const fa = new Set(a.files);
      const fb = new Set(b.files);
      const jac = jaccard(fa, fb);
      if (jac >= FILE_JACCARD_THRESHOLD) {
        addEdge(a.number, b.number, {
          kind: "files",
          detail: `PR #${a.number} and PR #${b.number} share files (Jaccard ${jac.toFixed(2)})`,
        });
      }
      const sharedIssue = a.linkedIssues.find((n) => b.linkedIssues.includes(n));
      if (sharedIssue !== undefined) {
        addEdge(a.number, b.number, {
          kind: "issue",
          detail: `PR #${a.number} and PR #${b.number} both link issue #${sharedIssue}`,
        });
      }
      if (sameBranchLineage(a.headBranch, b.headBranch)) {
        addEdge(a.number, b.number, {
          kind: "branch",
          detail: `PR #${a.number} and PR #${b.number} share head-branch lineage (${a.headBranch} / ${b.headBranch})`,
        });
      }
      if (a.diffHash && a.diffHash === b.diffHash) {
        addEdge(a.number, b.number, {
          kind: "diff",
          detail: `PR #${a.number} and PR #${b.number} have near-identical diffs`,
        });
      }
    }
  }

  const groups = new Map<number, number[]>();
  for (const pr of sorted) {
    const root = find(pr.number);
    const list = groups.get(root) ?? [];
    list.push(pr.number);
    groups.set(root, list);
  }

  const clusters: Cluster[] = [];
  for (const [, members] of groups) {
    members.sort((x, y) => x - y);
    const memberSet = new Set(members);
    const edges = allEdges
      .filter((e) => memberSet.has(e.a) && memberSet.has(e.b))
      .map((e) => e.edge);
    clusters.push({ key: clusterKey(members), members, edges });
  }
  clusters.sort((a, b) => a.key.localeCompare(b.key));
  return clusters;
}
