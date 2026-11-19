// Copyright 2026 TamTunnel. Licensed under the Apache License, Version 2.0.
// SPDX-License-Identifier: Apache-2.0

/**
 * Digest email sender (pluggable SMTP via nodemailer). The email
 * contains metadata and links only — no code, no diff hunks, no tokens,
 * no internal paths (S-8). Titles are HTML-escaped, and credential-
 * shaped patterns are redacted before rendering: the service never had
 * a credential to leak, and a fake secret pasted into a PR title must
 * not survive into the email.
 */

import nodemailer, { type Transporter } from "nodemailer";
import type { DigestContent } from "./digest";

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Redact credential-shaped material. Applied to every string rendered
 *  into email (and to log lines that carry PR titles). */
const SECRET_PATTERNS: RegExp[] = [
  /\bghp_[A-Za-z0-9]{20,}\b/g,
  /\bgho_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bsk-[A-Za-z0-9]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  /\b[A-Za-z0-9._-]*?(?:token|secret|password|api[_-]?key)\s*[:=]\s*['"]?[A-Za-z0-9+/=_-]{8,}['"]?/gi,
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[redacted]");
  return out;
}

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
}

export function smtpConfigured(cfg: SmtpConfig): boolean {
  return Boolean(cfg.host && cfg.from);
}

export function createTransporter(cfg: SmtpConfig): Transporter {
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.port === 465,
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
  });
}

export interface RenderedDigestEmail {
  subject: string;
  html: string;
  text: string;
}

export function renderDigestEmail(
  content: DigestContent,
  baseUrl: string,
): RenderedDigestEmail {
  const subject = `Headgate digest: ${content.repo} — ${content.date} (${content.stats.critical} critical, ${content.stats.high} high)`;
  const digestUrl = `${baseUrl}/#/digest/${encodeURIComponent(content.repo)}/${content.date}`;

  const clusterHtml = content.clusters
    .map((c) => {
      const members = c.member_prs
        .map(
          (m) =>
            `<li><a href="${escapeHtml(m.url)}">PR #${m.number}</a> — ${escapeHtml(redactSecrets(m.title))} ` +
            `(${escapeHtml(m.author)}, risk ${m.score} ${escapeHtml(m.band)}, CI ${escapeHtml(m.ci)})` +
            `<br><small>${escapeHtml(redactSecrets(m.top_reasons.join(" | ")))}</small></li>`,
        )
        .join("");
      return (
        `<h3>${escapeHtml(redactSecrets(c.summary))} — ${c.max_risk} (${escapeHtml(c.max_band)})</h3>` +
        `<p>${c.member_count} PR(s). ${escapeHtml(c.edge_reasons.join("; "))}</p>` +
        `<ul>${members}</ul>`
      );
    })
    .join("");

  const excludedHtml =
    content.excluded.length > 0
      ? `<h3>Excluded from this digest</h3><ul>${content.excluded
          .map(
            (e) =>
              `<li>PR #${e.pr_number} — ${escapeHtml(e.reason)}</li>`,
          )
          .join("")}</ul>`
      : "";

  const html =
    `<html><body><h2>Headgate daily digest — ${escapeHtml(content.repo)} — ${escapeHtml(content.date)}</h2>` +
    `<p>${content.stats.open_prs} open PRs in ${content.stats.clusters} cluster(s): ` +
    `${content.stats.critical} critical, ${content.stats.high} high, ${content.stats.medium} medium, ${content.stats.low} low.</p>` +
    `<p><a href="${escapeHtml(digestUrl)}">Open the digest in Headgate</a></p>` +
    `<p><em>Headgate scores are triage, not review: a low score is not permission to merge without reading, and a high score is not proof of a bug.</em></p>` +
    clusterHtml +
    excludedHtml +
    `</body></html>`;

  const clusterText = content.clusters
    .map((c) => {
      const members = c.member_prs
        .map(
          (m) =>
            `  - PR #${m.number}: ${redactSecrets(m.title)} (${m.author}, risk ${m.score} ${m.band}, CI ${m.ci})\n    ${redactSecrets(m.top_reasons.join(" | "))}\n    ${m.url}`,
        )
        .join("\n");
      return `${redactSecrets(c.summary)} — ${c.max_risk} (${c.max_band})\n${members}`;
    })
    .join("\n\n");

  const text =
    `Headgate daily digest — ${content.repo} — ${content.date}\n` +
    `${content.stats.open_prs} open PRs in ${content.stats.clusters} cluster(s): ` +
    `${content.stats.critical} critical, ${content.stats.high} high, ${content.stats.medium} medium, ${content.stats.low} low.\n` +
    `Open the digest: ${digestUrl}\n\n` +
    `Headgate scores are triage, not review: a low score is not permission to merge without reading, and a high score is not proof of a bug.\n\n` +
    clusterText +
    (content.excluded.length > 0
      ? `\n\nExcluded from this digest:\n${content.excluded.map((e) => `  - PR #${e.pr_number} — ${e.reason}`).join("\n")}`
      : "") +
    `\n`;

  return { subject, html, text };
}

export async function sendDigestEmail(
  transporter: Transporter,
  cfg: SmtpConfig,
  recipients: string[],
  content: DigestContent,
  baseUrl: string,
): Promise<void> {
  const rendered = renderDigestEmail(content, baseUrl);
  await transporter.sendMail({
    from: cfg.from,
    to: recipients.join(", "),
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
  });
}
