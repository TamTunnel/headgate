// Copyright 2026 TamTunnel. Licensed under the Apache License, Version 2.0.
// SPDX-License-Identifier: Apache-2.0

/**
 * Digest builder (pure function over stored snapshots/scores/clusters).
 * Produces a `digest/1` record: one ordered cluster list per repo per
 * day, with a canonical SHA-256 id. Rebuilding from the same stored
 * snapshots reproduces the identical id (D-4) — `generatedAt` is NOT
 * part of the hashed content.
 *
 * Ordering: max risk desc, then member count desc, then oldest first.
 * One-line summary per cluster is assembled from member titles
 * (first title + "and N more") — no LLM summarization.
 * Every open agent PR appears in the digest or in an explicit `excluded`
 * list with a reason (D-6).
 */

import { createHash } from "node:crypto";
import { canonicalize } from "./canonical";
import type { ClusterEdge } from "./cluster";
import { topReasons, type RiskScore } from "./scorer";

export interface DigestPr {
  number: number;
  title: string;
  url: string;
  author: string;
  isBot: boolean;
  score: RiskScore;
  createdAt: string;
  /** CI rollup: 'green' | 'red' | 'pending' | 'none'. */
  ci: string;
}

export interface DigestClusterInput {
  key: string;
  members: DigestPr[];
  edges: ClusterEdge[];
}

export interface DigestCluster {
  cluster_id: string;
  member_prs: {
    number: number;
    title: string;
    url: string;
    author: string;
    score: number;
    band: string;
    top_reasons: string[];
    ci: string;
  }[];
  max_risk: number;
  max_band: string;
  member_count: number;
  summary: string;
  edge_reasons: string[];
  oldest_first_pr: number;
}

export interface DigestExcluded {
  pr_number: number;
  reason: string;
}

export interface DigestContent {
  format: "digest/1";
  repo: string;
  date: string;
  clusters: DigestCluster[];
  excluded: DigestExcluded[];
  stats: {
    open_prs: number;
    clusters: number;
    critical: number;
    high: number;
    medium: number;
    low: number;
  };
}

export interface BuiltDigest {
  digestId: string;
  content: DigestContent;
}

function bandRank(band: string): number {
  return { critical: 4, high: 3, medium: 2, low: 1 }[band] ?? 0;
}

export function clusterSummary(members: DigestPr[]): string {
  const ordered = [...members].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.number - b.number,
  );
  const first = ordered[0];
  if (ordered.length === 1) return first.title;
  return `${first.title} (and ${ordered.length - 1} more)`;
}

export function buildDigest(
  repo: string,
  date: string,
  clusters: DigestClusterInput[],
  excluded: DigestExcluded[],
  escalatedKeys: Set<string> = new Set(),
): BuiltDigest {
  const built: (DigestCluster & { oldest_created_at: string })[] = clusters.map((c) => {
    const members = [...c.members].sort((a, b) => a.number - b.number);
    const maxRisk = Math.max(...members.map((m) => m.score.score));
    const maxBand = members
      .map((m) => m.score.band)
      .sort((a, b) => bandRank(b) - bandRank(a))[0];
    const oldest = [...members].sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.number - b.number,
    )[0];
    return {
      cluster_id: c.key,
      member_prs: members.map((m) => ({
        number: m.number,
        title: m.title,
        url: m.url,
        author: m.author,
        score: m.score.score,
        band: m.score.band,
        top_reasons: topReasons(m.score),
        ci: m.ci,
      })),
      max_risk: maxRisk,
      max_band: maxBand,
      member_count: members.length,
      summary: clusterSummary(members),
      edge_reasons: c.edges.map((e) => e.detail),
      oldest_first_pr: oldest.number,
      oldest_created_at: oldest.createdAt,
    };
  });

  // Order: escalated clusters first, then max risk desc, member count
  // desc, oldest first.
  built.sort((a, b) => {
    const ae = escalatedKeys.has(a.cluster_id) ? 1 : 0;
    const be = escalatedKeys.has(b.cluster_id) ? 1 : 0;
    if (be !== ae) return be - ae;
    if (b.max_risk !== a.max_risk) return b.max_risk - a.max_risk;
    if (b.member_count !== a.member_count) return b.member_count - a.member_count;
    return a.oldest_created_at.localeCompare(b.oldest_created_at);
  });
  // The tiebreak timestamp is internal; strip it before hashing.
  const contentClusters: DigestCluster[] = built.map(
    ({ oldest_created_at: _oldest, ...rest }) => rest,
  );

  const openPrs =
    contentClusters.reduce((n, c) => n + c.member_count, 0) + excluded.length;
  const content: DigestContent = {
    format: "digest/1",
    repo,
    date,
    clusters: contentClusters,
    excluded: [...excluded].sort((a, b) => a.pr_number - b.pr_number),
    stats: {
      open_prs: openPrs,
      clusters: contentClusters.length,
      critical: contentClusters.filter((c) => c.max_band === "critical").length,
      high: contentClusters.filter((c) => c.max_band === "high").length,
      medium: contentClusters.filter((c) => c.max_band === "medium").length,
      low: contentClusters.filter((c) => c.max_band === "low").length,
    },
  };
  const digestId = createHash("sha256")
    .update(canonicalize(content))
    .digest("hex");
  return { digestId, content };
}
