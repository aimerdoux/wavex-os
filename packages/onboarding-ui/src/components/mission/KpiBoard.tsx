/** KPI scoreboard. Reads /api/instance/<companyId>/{manifest,kpis} via
 *  React Query. Shows "complete onboarding" placeholder when no manifest. */

import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { useCompany } from "../../wavex-os/lib/CompanyContext";

interface ManifestPayload {
  ok: boolean;
  manifest?: {
    company?: { id?: string; name?: string };
    goal?: { kpiId?: string; current?: number; target?: number; days?: number };
    state?: string;
  };
}

interface KpisPayload {
  ok: boolean;
  companyId: string;
  kpis: Array<{
    kpiId: string;
    label: string;
    direction: "higher_is_better" | "lower_is_better";
    ownerRole?: string;
    currentValue?: number;
    targetMicros?: number;
    windowDays?: number;
  }>;
}

export function KpiBoard() {
  const { companyId } = useCompany();

  const manifestQ = useQuery<ManifestPayload>({
    enabled: !!companyId,
    queryKey: ["instance-manifest", companyId],
    queryFn: async () => {
      const r = await fetch(`/api/instance/${encodeURIComponent(companyId!)}/manifest`);
      if (r.status === 404) return { ok: false };
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    refetchInterval: 30_000,
  });

  const kpisQ = useQuery<KpisPayload>({
    enabled: !!companyId && manifestQ.data?.ok === true,
    queryKey: ["instance-kpis", companyId],
    queryFn: async () => {
      const r = await fetch(`/api/instance/${encodeURIComponent(companyId!)}/kpis`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    },
    refetchInterval: 30_000,
  });

  if (!companyId) {
    return (
      <div className="card">
        <h3 style={{ marginTop: 0 }}>KPI scoreboard</h3>
        <p className="text-dim" style={{ margin: "0 0 12px" }}>
          No company selected. Select a company above to populate this scoreboard.
        </p>
        <Link to="/onboarding-chat" style={{ display: "inline-block", padding: "12px 20px", background: "var(--accent)", color: "#08221d", borderRadius: "var(--radius)", fontWeight: 600, fontSize: 14, textDecoration: "none" }}>Complete onboarding →</Link>
      </div>
    );
  }

  if (manifestQ.isLoading) {
    return <div className="card"><h3 style={{ marginTop: 0 }}>KPI scoreboard</h3><p className="text-dim">Loading…</p></div>;
  }

  if (!manifestQ.data?.ok) {
    return (
      <div className="card">
        <h3 style={{ marginTop: 0 }}>KPI scoreboard</h3>
        <p className="text-dim" style={{ margin: 0 }}>
          No manifest yet for <code>{companyId}</code>. <Link to="/onboarding-chat">Run onboarding to finalize</Link>.
        </p>
      </div>
    );
  }

  const goal = manifestQ.data.manifest?.goal;
  const kpis = kpisQ.data?.kpis ?? [];
  const headline = kpis[0];

  return (
    <div className="card">
      <h3 style={{ marginTop: 0 }}>KPI scoreboard — {manifestQ.data.manifest?.company?.name ?? companyId}</h3>
      {headline && (
        <div style={{ marginBottom: "1rem", padding: "0.75rem", border: "1px solid var(--border)", borderRadius: 6 }}>
          <div style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-dim)" }}>
            HEADLINE GOAL
          </div>
          <div style={{ fontSize: 18, fontWeight: 600, marginTop: 4 }}>{headline.label}</div>
          <div className="text-dim" style={{ fontSize: 13, marginTop: 2 }}>
            {goal?.current != null && goal?.target != null
              ? `${goal.current.toLocaleString()} → ${goal.target.toLocaleString()} (${goal.days}d window)`
              : "No baseline captured yet"}
          </div>
        </div>
      )}
      {kpis.length > 1 && (
        <div>
          <div style={{ fontSize: 12, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-dim)", marginBottom: 6 }}>
            SUPPORTING KPIs
          </div>
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {kpis.slice(1).map((k) => (
              <li key={k.kpiId} style={{ padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
                <span style={{ fontWeight: 500 }}>{k.label}</span>
                <span className="text-dim" style={{ fontSize: 12, marginLeft: 8 }}>
                  · owned by {k.ownerRole}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {kpis.length === 0 && <p className="text-dim" style={{ margin: 0 }}>No KPIs in registry.</p>}
    </div>
  );
}
