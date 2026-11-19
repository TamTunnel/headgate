import { useCallback, useEffect, useState } from "react";

interface Tenant {
  id: string;
  installation_id: number;
  account_login: string;
}

interface Repo {
  id: string;
  full_name: string;
  digest_hour: number;
}

interface DigestPr {
  number: number;
  title: string;
  url: string;
  author: string;
  score: number;
  band: string;
  top_reasons: string[];
  ci: string;
}

interface DigestCluster {
  cluster_id: string;
  member_prs: DigestPr[];
  max_risk: number;
  max_band: string;
  member_count: number;
  summary: string;
  edge_reasons: string[];
}

interface DigestContent {
  format: string;
  repo: string;
  date: string;
  clusters: DigestCluster[];
  excluded: { pr_number: number; reason: string }[];
  stats: {
    open_prs: number;
    clusters: number;
    critical: number;
    high: number;
    medium: number;
    low: number;
  };
}

interface QueuePr {
  number: number;
  title: string;
  author: string;
  is_bot: boolean;
  url: string;
  score: number | null;
  band: string | null;
  signals: { name: string; points: number; evidence: string }[];
  ci: string;
}

interface QueueCluster {
  cluster_key: string;
  members: number[];
  edge_reasons: { kind: string; detail: string }[];
}

interface AuditEntry {
  seq: number;
  ts: string;
  kind: string;
  payload: Record<string, unknown>;
  prev_hash: string;
  hash: string;
}

async function api(
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: any }> {
  const res = await fetch(path, { ...init });
  let body: any = {};
  try {
    body = await res.json();
  } catch {
    body = {};
  }
  return { status: res.status, body };
}

function useHashRoute(): string {
  const [hash, setHash] = useState(window.location.hash.slice(1) || "/");
  useEffect(() => {
    const onChange = () => setHash(window.location.hash.slice(1) || "/");
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return hash;
}

const BAND_COLORS: Record<string, string> = {
  critical: "#b91c1c",
  high: "#c2410c",
  medium: "#a16207",
  low: "#15803d",
};

export default function App() {
  const route = useHashRoute();
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [installationId, setInstallationId] = useState<number | null>(null);
  const [repos, setRepos] = useState<Repo[]>([]);
  const [repo, setRepo] = useState("");
  const [digest, setDigest] = useState<DigestContent | null>(null);
  const [digestId, setDigestId] = useState("");
  const [queue, setQueue] = useState<QueuePr[]>([]);
  const [queueClusters, setQueueClusters] = useState<QueueCluster[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [auditOk, setAuditOk] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    api("/api/tenants").then(({ status, body }) => {
      if (status === 200 && body.tenants?.length > 0) {
        setTenants(body.tenants);
        setInstallationId(body.tenants[0].installation_id);
      }
    });
  }, []);

  useEffect(() => {
    if (installationId === null) return;
    api(`/api/repos?installation_id=${installationId}`).then(
      ({ status, body }) => {
        if (status === 200) {
          setRepos(body.repos ?? []);
          if (body.repos?.length > 0) setRepo(body.repos[0].full_name);
        }
      },
    );
  }, [installationId]);

  const loadDigest = useCallback(async () => {
    if (installationId === null || !repo) return;
    const { status, body } = await api(
      `/api/digest?installation_id=${installationId}&repo=${encodeURIComponent(repo)}`,
    );
    if (status === 200) {
      setDigest(body.content);
      setDigestId(body.digest_id);
      setError("");
    } else {
      setDigest(null);
      setError(body.error ?? "no digest yet for today");
    }
  }, [installationId, repo]);

  const loadQueue = useCallback(async () => {
    if (installationId === null || !repo) return;
    const { status, body } = await api(
      `/api/queue?installation_id=${installationId}&repo=${encodeURIComponent(repo)}`,
    );
    if (status === 200) {
      setQueue(body.prs ?? []);
      setQueueClusters(body.clusters ?? []);
    }
  }, [installationId, repo]);

  const loadAudit = useCallback(async () => {
    if (installationId === null) return;
    const { status, body } = await api(
      `/api/audit?installation_id=${installationId}&limit=100`,
    );
    if (status === 200) setAudit(body.entries ?? []);
    const v = await api("/api/audit/verify");
    setAuditOk(v.status === 200 && v.body.ok === true);
  }, [installationId]);

  useEffect(() => {
    loadDigest();
    loadQueue();
    loadAudit();
  }, [loadDigest, loadQueue, loadAudit]);

  async function clusterAction(
    clusterKey: string,
    action: string,
    extra: Record<string, unknown> = {},
  ) {
    setNotice("");
    const { status, body } = await api("/api/cluster/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        installation_id: installationId,
        repo,
        cluster_key: clusterKey,
        action,
        actor: "operator",
        ...extra,
      }),
    });
    if (status === 200) {
      setNotice(`Cluster ${action} recorded.`);
      loadDigest();
      loadQueue();
      loadAudit();
    } else {
      setError(body.error ?? `cluster action failed (${status})`);
    }
  }

  async function prAction(number: number, action: string) {
    setNotice("");
    const { status, body } = await api("/api/pr/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        installation_id: installationId,
        repo,
        number,
        action,
        actor: "operator",
      }),
    });
    if (status === 200) {
      setNotice(`PR #${number} ${action} recorded.`);
      loadDigest();
      loadQueue();
      loadAudit();
    } else {
      setError(body.error ?? `PR action failed (${status})`);
    }
  }

  async function buildDigest() {
    setNotice("");
    const { status, body } = await api("/api/digest/build", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ installation_id: installationId, repo }),
    });
    if (status === 200) {
      setNotice(
        body.created
          ? `Digest ${body.digest_id.slice(0, 12)}… issued.`
          : "Digest already issued for today.",
      );
      loadDigest();
      loadAudit();
    } else {
      setError(body.error ?? `digest build failed (${status})`);
    }
  }

  const view = route === "/audit" ? "audit" : route === "/queue" ? "queue" : "digest";

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", maxWidth: 960, margin: "0 auto", padding: 16 }}>
      <header>
        <h1>Headgate</h1>
        <p>
          PR triage for agent fleets. Clusters agent PRs, scores them
          deterministically, and issues one daily digest. Headgate never
          approves, merges, or comments on GitHub — it only decides what a
          human looks at first.
        </p>
        <nav style={{ display: "flex", gap: 12, marginBottom: 16 }}>
          <a href="#/">Today&apos;s digest</a>
          <a href="#/queue">Live queue</a>
          <a href="#/audit">Audit log</a>
        </nav>
        <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
          <select
            value={installationId ?? ""}
            onChange={(e) => setInstallationId(Number(e.target.value))}
          >
            {tenants.map((t) => (
              <option key={t.id} value={t.installation_id}>
                {t.account_login || `installation ${t.installation_id}`}
              </option>
            ))}
          </select>
          <select value={repo} onChange={(e) => setRepo(e.target.value)}>
            {repos.map((r) => (
              <option key={r.id} value={r.full_name}>
                {r.full_name}
              </option>
            ))}
          </select>
          <button onClick={buildDigest}>Build today&apos;s digest</button>
        </div>
        {error && <p style={{ color: "#b91c1c" }}>{error}</p>}
        {notice && <p style={{ color: "#15803d" }}>{notice}</p>}
      </header>

      {view === "digest" && (
        <section>
          <h2>
            Today&apos;s digest{digest ? ` — ${digest.repo} — ${digest.date}` : ""}
          </h2>
          {digest && (
            <p>
              Digest id <code>{digestId}</code> · {digest.stats.open_prs} open
              PRs in {digest.stats.clusters} cluster(s):{" "}
              {digest.stats.critical} critical, {digest.stats.high} high,{" "}
              {digest.stats.medium} medium, {digest.stats.low} low.
            </p>
          )}
          <p>
            <em>
              A risk score is triage, not review: a low score is not permission
              to merge without reading, and a high score is not proof of a bug.
            </em>
          </p>
          {digest?.clusters.map((c) => (
            <article
              key={c.cluster_id}
              style={{ border: "1px solid #ccc", borderRadius: 8, padding: 12, marginBottom: 12 }}
            >
              <h3>
                {c.summary} —{" "}
                <span style={{ color: BAND_COLORS[c.max_band] ?? "#000" }}>
                  {c.max_risk} ({c.max_band})
                </span>
              </h3>
              <p>{c.member_count} PR(s). {c.edge_reasons.join("; ")}</p>
              <ul>
                {c.member_prs.map((m) => (
                  <li key={m.number}>
                    <a href={m.url} target="_blank" rel="noreferrer">
                      PR #{m.number}
                    </a>{" "}
                    — {m.title} ({m.author}, risk {m.score} {m.band}, CI{" "}
                    {m.ci})
                    <br />
                    <small>{m.top_reasons.join(" | ")}</small>
                  </li>
                ))}
              </ul>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button onClick={() => clusterAction(c.cluster_id, "reviewed")}>
                  Mark reviewed
                </button>
                <button onClick={() => clusterAction(c.cluster_id, "snooze", { snooze_days: 3 })}>
                  Snooze 3d
                </button>
                <button onClick={() => clusterAction(c.cluster_id, "escalate")}>
                  Escalate
                </button>
              </div>
            </article>
          ))}
          {digest && digest.excluded.length > 0 && (
            <section>
              <h3>Excluded from this digest</h3>
              <ul>
                {digest.excluded.map((e) => (
                  <li key={e.pr_number}>
                    PR #{e.pr_number} — {e.reason}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {!digest && <p>No digest issued for today yet.</p>}
        </section>
      )}

      {view === "queue" && (
        <section>
          <h2>Live queue — {repo}</h2>
          <p>
            Open PRs and their current clusters and scores, for the hours
            between digests.
          </p>
          {queueClusters.map((c) => (
            <article
              key={c.cluster_key}
              style={{ border: "1px solid #ccc", borderRadius: 8, padding: 12, marginBottom: 12 }}
            >
              <h3>Cluster {c.cluster_key}</h3>
              <p>{c.edge_reasons.map((e) => e.detail).join("; ") || "Singleton"}</p>
              <ul>
                {c.members.map((n) => {
                  const pr = queue.find((p) => p.number === n);
                  if (!pr) return <li key={n}>PR #{n}</li>;
                  return (
                    <li key={n}>
                      <a href={pr.url} target="_blank" rel="noreferrer">
                        PR #{pr.number}
                      </a>{" "}
                      — {pr.title} ({pr.author}
                      {pr.is_bot ? ", bot" : ""}, risk {pr.score ?? "—"}{" "}
                      {pr.band ?? ""}, CI {pr.ci})
                      <br />
                      <small>
                        {pr.signals.map((s) => `${s.name} +${s.points}`).join(", ")}
                      </small>{" "}
                      <button onClick={() => prAction(pr.number, "remove")}>
                        Remove from cluster
                      </button>{" "}
                      <button onClick={() => prAction(pr.number, "snooze")}>
                        Snooze
                      </button>
                    </li>
                  );
                })}
              </ul>
            </article>
          ))}
          {queueClusters.length === 0 && <p>No open PRs.</p>}
        </section>
      )}

      {view === "audit" && (
        <section>
          <h2>Audit log</h2>
          <p>
            Hash-chained record of every ingestion decision and human action.{" "}
            {auditOk === null
              ? "Verifying…"
              : auditOk
                ? "Chain verifies."
                : "CHAIN BROKEN — verification failed."}
          </p>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left" }}>Seq</th>
                <th style={{ textAlign: "left" }}>Time</th>
                <th style={{ textAlign: "left" }}>Kind</th>
                <th style={{ textAlign: "left" }}>Payload</th>
              </tr>
            </thead>
            <tbody>
              {audit.map((e) => (
                <tr key={e.seq}>
                  <td>{e.seq}</td>
                  <td>{new Date(e.ts).toLocaleString()}</td>
                  <td>{e.kind}</td>
                  <td>
                    <code>{JSON.stringify(e.payload)}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
