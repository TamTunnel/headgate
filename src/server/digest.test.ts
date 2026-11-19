// Copyright 2026 TamTunnel. Licensed under the Apache License, Version 2.0.
// SPDX-License-Identifier: Apache-2.0

/**
 * Digest probes:
 *   D-4 digest reproducibility (same snapshots -> identical digest id)
 *   ordering: max risk desc, member count desc, oldest first
 *   summary assembly from member titles (no LLM)
 *   D-6 shape: excluded list carries a reason per PR
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildDigest,
  clusterSummary,
  type DigestClusterInput,
  type DigestPr,
} from "./digest.js";
import type { RiskScore } from "./scorer.js";

function score(n: number, band: RiskScore["band"]): RiskScore {
  return { score: n, band, signals: [{ name: "size", points: n, evidence: "test" }] };
}

function digestPr(
  number: number,
  title: string,
  risk: number,
  band: RiskScore["band"],
  createdAt: string,
): DigestPr {
  return {
    number,
    title,
    url: `https://github.com/acme/app/pull/${number}`,
    author: "devin-bot",
    isBot: true,
    score: score(risk, band),
    createdAt,
    ci: "green",
  };
}

test("D-4: rebuilding from the same inputs reproduces the identical digest id", () => {
  const clusters: DigestClusterInput[] = [
    {
      key: "aaa",
      members: [
        digestPr(1, "Add login flow", 80, "critical", "2026-11-19T08:00:00Z"),
        digestPr(2, "Add login flow (retry)", 70, "high", "2026-11-19T08:30:00Z"),
      ],
      edges: [{ kind: "files", detail: "share files" }],
    },
    {
      key: "bbb",
      members: [digestPr(3, "Fix typo", 10, "low", "2026-11-19T07:00:00Z")],
      edges: [],
    },
  ];
  const a = buildDigest("acme/app", "2026-11-19", clusters, []);
  const b = buildDigest("acme/app", "2026-11-19", structuredClone(clusters), []);
  assert.equal(a.digestId, b.digestId);
  assert.equal(JSON.stringify(a.content), JSON.stringify(b.content));
  // Cluster input order does not change the id either.
  const c = buildDigest("acme/app", "2026-11-19", [...clusters].reverse(), []);
  assert.equal(a.digestId, c.digestId);
});

test("ordering: max risk desc, then member count desc, then oldest first", () => {
  const clusters: DigestClusterInput[] = [
    {
      key: "small-high",
      members: [digestPr(5, "Risky one", 60, "high", "2026-11-19T06:00:00Z")],
      edges: [],
    },
    {
      key: "big-mid",
      members: [
        digestPr(6, "Mid A", 40, "medium", "2026-11-19T05:00:00Z"),
        digestPr(7, "Mid B", 40, "medium", "2026-11-19T05:30:00Z"),
        digestPr(8, "Mid C", 40, "medium", "2026-11-19T06:00:00Z"),
      ],
      edges: [],
    },
    {
      key: "big-mid-2",
      members: [
        digestPr(9, "Mid D", 40, "medium", "2026-11-19T04:00:00Z"),
        digestPr(10, "Mid E", 40, "medium", "2026-11-19T04:30:00Z"),
      ],
      edges: [],
    },
    {
      key: "critical",
      members: [digestPr(11, "Critical one", 90, "critical", "2026-11-19T09:00:00Z")],
      edges: [],
    },
  ];
  const { content } = buildDigest("acme/app", "2026-11-19", clusters, []);
  const order = content.clusters.map((c) => c.cluster_id);
  // critical (90) first, then high (60), then the two medium clusters:
  // bigger member count first, then oldest first.
  assert.deepEqual(order, ["critical", "small-high", "big-mid", "big-mid-2"]);
});

test("escalated clusters pin to the top of the digest", () => {
  const clusters: DigestClusterInput[] = [
    {
      key: "low",
      members: [digestPr(1, "Low one", 5, "low", "2026-11-19T06:00:00Z")],
      edges: [],
    },
    {
      key: "high",
      members: [digestPr(2, "High one", 80, "critical", "2026-11-19T07:00:00Z")],
      edges: [],
    },
  ];
  const { content } = buildDigest("acme/app", "2026-11-19", clusters, [], new Set(["low"]));
  assert.equal(content.clusters[0].cluster_id, "low");
});

test("summary: first (oldest) title + 'and N more'; singleton is just its title", () => {
  const members = [
    digestPr(2, "Second title", 10, "low", "2026-11-19T08:30:00Z"),
    digestPr(1, "First title", 10, "low", "2026-11-19T08:00:00Z"),
  ];
  assert.equal(clusterSummary(members), "First title (and 1 more)");
  assert.equal(clusterSummary([members[1]]), "First title");
});

test("stats count open PRs, clusters, and bands", () => {
  const { content } = buildDigest(
    "acme/app",
    "2026-11-19",
    [
      {
        key: "a",
        members: [digestPr(1, "A", 80, "critical", "2026-11-19T08:00:00Z")],
        edges: [],
      },
      {
        key: "b",
        members: [digestPr(2, "B", 10, "low", "2026-11-19T08:00:00Z")],
        edges: [],
      },
    ],
    [{ pr_number: 3, reason: "snoozed" }],
  );
  assert.equal(content.stats.open_prs, 3);
  assert.equal(content.stats.clusters, 2);
  assert.equal(content.stats.critical, 1);
  assert.equal(content.stats.low, 1);
  assert.deepEqual(content.excluded, [{ pr_number: 3, reason: "snoozed" }]);
});
