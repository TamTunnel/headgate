// Copyright 2026 TamTunnel. Licensed under the Apache License, Version 2.0.
// SPDX-License-Identifier: Apache-2.0

export interface HeadgateConfig {
  port: number;
  host: string;
  databaseUrl: string;
  baseUrl: string;
  webhookSecret: string;
  githubAppId: string;
  githubAppPrivateKey: string;
  githubAppSlug: string;
  digestHour: number;
  retentionDays: number;
  auditLogPath: string;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
  smtpFrom: string;
  digestRecipients: string;
  isProduction: boolean;
}

function env(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

function devOnlySecret(kind: string): string {
  if (process.env.NODE_ENV === "development") {
    return `headgate-dev-${kind}`;
  }
  throw new Error(
    `${kind} is required (set ${kind} or run with NODE_ENV=development for the dev fallback)`,
  );
}

export function loadConfig(): HeadgateConfig {
  return {
    port: Number(env("PORT", "3000")),
    host: env("HOST", "0.0.0.0"),
    databaseUrl: env(
      "DATABASE_URL",
      "postgres://headgate:headgate-dev@127.0.0.1:5432/headgate",
    ),
    baseUrl: env("BASE_URL", "http://localhost:3000"),
    webhookSecret:
      env("GITHUB_WEBHOOK_SECRET", "") || devOnlySecret("GITHUB_WEBHOOK_SECRET"),
    githubAppId: env("GITHUB_APP_ID", ""),
    githubAppPrivateKey: env("GITHUB_APP_PRIVATE_KEY", ""),
    githubAppSlug: env("GITHUB_APP_SLUG", "headgate"),
    digestHour: Number(env("DIGEST_HOUR", "9")),
    retentionDays: Number(env("RETENTION_DAYS", "30")),
    auditLogPath: env("AUDIT_LOG_PATH", "data/audit.jsonl"),
    smtpHost: env("SMTP_HOST", ""),
    smtpPort: Number(env("SMTP_PORT", "587")),
    smtpUser: env("SMTP_USER", ""),
    smtpPass: env("SMTP_PASS", ""),
    smtpFrom: env("SMTP_FROM", ""),
    digestRecipients: env("DIGEST_RECIPIENTS", ""),
    isProduction: process.env.NODE_ENV === "production",
  };
}
