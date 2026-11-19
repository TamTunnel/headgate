// Copyright 2026 TamTunnel. Licensed under the Apache License, Version 2.0.
// SPDX-License-Identifier: Apache-2.0

/**
 * Email probes:
 *   S-8 the digest email contains metadata and links only — no code,
 *   no diffs, no tokens; a fake secret pasted into a PR title must not
 *   survive into the email.
 *   Titles render HTML-escaped (S-6, email surface).
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  escapeHtml,
  redactSecrets,
  renderDigestEmail,
} from "./email.js";
import type { DigestContent } from "./digest.js";

function digestWithTitle(title: string): DigestContent {
  return {
    format: "digest/1",
    repo: "acme/app",
    date: "2026-11-19",
    clusters: [
      {
        cluster_id: "abc",
        member_prs: [
          {
            number: 1,
            title,
            url: "https://github.com/acme/app/pull/1",
            author: "devin-bot",
            score: 80,
            band: "critical",
            top_reasons: ["size +20: 5000 lines changed"],
            ci: "green",
            stale: false,
            snapshot_at: "2026-11-19T08:00:00Z",
          },
        ],
        max_risk: 80,
        max_band: "critical",
        member_count: 1,
        summary: title,
        edge_reasons: [],
        oldest_first_pr: 1,
      },
    ],
    excluded: [],
    stats: { open_prs: 1, clusters: 1, critical: 1, high: 0, medium: 0, low: 0 },
  };
}

test("S-8: a fake secret in a PR title does not survive into the email", () => {
  const fakeToken = "ghp_abcdefghij1234567890ABCD";
  const content = digestWithTitle(`Rotate token ${fakeToken} now`);
  const { html, text } = renderDigestEmail(content, "http://localhost:3000");
  assert.ok(!html.includes(fakeToken), "HTML email contains the planted token");
  assert.ok(!text.includes(fakeToken), "plain-text email contains the planted token");
  assert.ok(html.includes("[redacted]"));
  assert.ok(text.includes("[redacted]"));
});

test("S-8: sk- keys and AWS-style keys are redacted too", () => {
  const content = digestWithTitle("Use sk-abcdefghij1234567890abcdef in prod");
  const { html } = renderDigestEmail(content, "http://localhost:3000");
  assert.ok(!html.includes("sk-abcdefghij1234567890abcdef"));
});

test("email renders titles HTML-escaped (inert, S-6 surface)", () => {
  const content = digestWithTitle("<script>alert(1)</script> drop table prs; --");
  const { html } = renderDigestEmail(content, "http://localhost:3000");
  assert.ok(!html.includes("<script>alert(1)</script>"));
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  // Links survive: the digest is metadata + links.
  assert.ok(html.includes("https://github.com/acme/app/pull/1"));
});

test("escapeHtml escapes the five dangerous characters", () => {
  assert.equal(
    escapeHtml(`<a href="x">&'y'</a>`),
    "&lt;a href=&quot;x&quot;&gt;&amp;&#39;y&#39;&lt;/a&gt;",
  );
});

test("redactSecrets leaves ordinary titles untouched", () => {
  assert.equal(redactSecrets("Add login flow"), "Add login flow");
  assert.equal(redactSecrets("Fix #123: bump timeout"), "Fix #123: bump timeout");
});

test("email contains no diff hunks or code", () => {
  const content = digestWithTitle("Add feature");
  const { html, text } = renderDigestEmail(content, "http://localhost:3000");
  assert.ok(!html.includes("@@"));
  assert.ok(!text.includes("@@"));
  assert.match(text, /Headgate daily digest/);
  assert.match(text, /triage, not review/);
});

test("F2: PEM blocks, JWTs, and bare high-entropy secrets do not survive into the email", () => {
  const pem = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----";
  const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsRRk";
  const bare = "wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY";
  for (const secret of [pem, jwt, bare]) {
    const { html, text } = renderDigestEmail(
      digestWithTitle(`leaked ${secret}`),
      "http://localhost:3000",
    );
    assert.ok(!html.includes(secret), `HTML email contains ${secret.slice(0, 20)}…`);
    assert.ok(!text.includes(secret), `text email contains ${secret.slice(0, 20)}…`);
  }
  assert.equal(redactSecrets("hello world"), "hello world");
  // URLs are exempt from the bare-token pattern: the digest link survives.
  assert.ok(
    redactSecrets("see https://github.com/acme/app/pull/7 for details").includes(
      "https://github.com/acme/app/pull/7",
    ),
  );
});

test("F2: edge_reasons and excluded reasons are redacted in both renders", () => {
  const akia = "AKIAIOSFODNN7EXAMPLE";
  const content = digestWithTitle("normal title");
  content.clusters[0].edge_reasons = [
    `PR #1 and PR #2 share head-branch lineage (${akia} / devin/2-x)`,
  ];
  content.excluded = [{ pr_number: 9, reason: `snoozed: ${akia}` }];
  const { html, text } = renderDigestEmail(content, "http://localhost:3000");
  assert.ok(!html.includes(akia), "HTML email contains AKIA from edge_reasons/excluded");
  assert.ok(!text.includes(akia), "text email contains AKIA from edge_reasons/excluded");
  assert.ok(html.includes("[redacted]"));
  assert.ok(text.includes("[redacted]"));
});

test("F13: a stale member is marked in both renders", () => {
  const content = digestWithTitle("Old PR");
  content.clusters[0].member_prs[0].stale = true;
  const { html, text } = renderDigestEmail(content, "http://localhost:3000");
  assert.ok(html.includes("stale snapshot"));
  assert.ok(text.includes("stale snapshot"));
});
