/**
 * Privacy Panel — Mission Control component.
 *
 * Shows the customer:
 *   - Their hired Expert Agents (status + data_scope)
 *   - Recent reads from digest_access_log (per agent, grouped by day)
 *   - One-click Revoke button per hired agent
 *
 * Reads are RLS-scoped via Supabase — this component only ever sees the
 * customer's own rows. The hand-rolled view; no extra deps.
 *
 * If the operator has no subscription, the panel renders the "no data
 * leaves your machine" notice instead.
 */
import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { getSupabase } from "../lib/supabase";

interface HireWithCatalog {
  hire_id: string;
  catalog_id: string;
  display_name: string;
  purpose: string;
  data_scope: string[];
  status: string;
  hired_at: string;
  required_tier: string;
  daily_token_cap: number;
}

interface AccessLogRow {
  id: string;
  hired_agent_id: string;
  fields_accessed: string[];
  purpose: string;
  accessed_at: string;
}

export interface PrivacyPanelProps {
  session: Session | null;
}

export function PrivacyPanel({ session }: PrivacyPanelProps): JSX.Element {
  const supabase = getSupabase();
  const [hires, setHires] = useState<HireWithCatalog[] | null>(null);
  const [logs, setLogs] = useState<AccessLogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);

  useEffect(() => {
    if (!supabase || !session) {
      setHires(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const { data: hireData, error: hireErr } = await supabase.rpc("wavex_os_list_my_hires");
        if (hireErr) throw hireErr;
        if (!cancelled) setHires((hireData ?? []) as HireWithCatalog[]);

        if (hireData && hireData.length > 0) {
          const hireIds = (hireData as HireWithCatalog[]).map((h) => h.hire_id);
          const { data: logData } = await supabase
            .schema("wavex_os")
            .from("digest_access_log")
            .select("id,hired_agent_id,fields_accessed,purpose,accessed_at")
            .in("hired_agent_id", hireIds)
            .order("accessed_at", { ascending: false })
            .limit(100);
          if (!cancelled) setLogs((logData ?? []) as AccessLogRow[]);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [supabase, session]);

  async function revokeHire(hireId: string): Promise<void> {
    if (!supabase) return;
    setRevoking(hireId);
    const { error: revokeErr } = await supabase
      .schema("wavex_os")
      .from("hired_expert_agents")
      .update({ status: "revoked", revoked_at: new Date().toISOString() })
      .eq("id", hireId);
    setRevoking(null);
    if (revokeErr) {
      setError(`Revoke failed: ${revokeErr.message}`);
      return;
    }
    // refresh
    setHires((prev) => prev?.map((h) => h.hire_id === hireId ? { ...h, status: "revoked" } : h) ?? null);
  }

  if (!session) {
    return (
      <div style={card}>
        <h3 style={heading}>Privacy</h3>
        <p style={text}>You are not signed in. WaveX OS runs entirely on your machine — no fleet data is sent to WaveX.</p>
        <a href="/pricing" style={{ display: "inline-block", marginTop: 12, padding: "13px 20px", background: "var(--accent)", color: "#08221d", borderRadius: "var(--radius)", fontWeight: 600, fontSize: 13, textDecoration: "none" }}>Sign in on pricing page →</a>
      </div>
    );
  }

  if (loading) return <div style={card}><h3 style={heading}>Privacy</h3><p style={text}>Loading…</p></div>;

  if (error) return (
    <div style={{ ...card, borderColor: "#5a2c2c" }}>
      <h3 style={heading}>Privacy</h3>
      <p style={{ ...text, color: "#e09999" }}>{error}</p>
    </div>
  );

  const activeHires = (hires ?? []).filter((h) => h.status === "active");
  if (activeHires.length === 0) {
    return (
      <div style={card}>
        <h3 style={heading}>Privacy</h3>
        <p style={text}>
          You have no active WaveX Expert Agents. Your fleet data stays entirely on this machine.
        </p>
        <a href="/pricing" style={{ display: "inline-block", marginTop: 12, padding: "13px 20px", background: "var(--accent)", color: "#08221d", borderRadius: "var(--radius)", fontWeight: 600, fontSize: 13, textDecoration: "none" }}>Hire an Expert Agent →</a>
      </div>
    );
  }

  // Group log rows by hired_agent_id
  const logsByHire = new Map<string, AccessLogRow[]>();
  for (const log of logs) {
    const existing = logsByHire.get(log.hired_agent_id) ?? [];
    existing.push(log);
    logsByHire.set(log.hired_agent_id, existing);
  }

  return (
    <div style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
        <h3 style={heading}>Privacy — active Expert Agents</h3>
        <a href="https://github.com/aimerdoux/wavex-os/blob/main/docs/legal/EXPERT_AGENT_PROCESSING_AGREEMENT.md" target="_blank" rel="noopener noreferrer" style={{ ...link, fontSize: 12 }}>Processing Agreement →</a>
      </div>
      <p style={{ ...text, marginBottom: 16 }}>
        Each Expert Agent below has been hired by you and reads ONLY the listed fields of your fleet. Every read is logged below.
      </p>

      {activeHires.map((hire) => {
        const hireLogs = logsByHire.get(hire.hire_id) ?? [];
        return (
          <div key={hire.hire_id} style={hireCard}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, marginBottom: 6 }}>
              <strong style={{ fontSize: 14 }}>{hire.display_name}</strong>
              <button
                type="button"
                onClick={() => { if (confirm(`Revoke ${hire.display_name}? Pending fleet_digests are deleted within 1h.`)) revokeHire(hire.hire_id); }}
                disabled={revoking === hire.hire_id}
                style={revokeButton}
              >
                {revoking === hire.hire_id ? "Revoking…" : "Revoke"}
              </button>
            </div>
            <p style={{ ...text, fontSize: 12, marginBottom: 8 }}>{hire.purpose}</p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 10 }}>
              {hire.data_scope.map((field) => <span key={field} style={chip}>{field}</span>)}
            </div>
            <details style={{ fontSize: 12, color: "#8a8a92" }}>
              <summary style={{ cursor: "pointer", userSelect: "none" }}>
                {hireLogs.length === 0 ? "No reads yet" : `${hireLogs.length} read${hireLogs.length === 1 ? "" : "s"} (last 100)`}
              </summary>
              {hireLogs.length > 0 && (
                <table style={{ width: "100%", marginTop: 8, fontSize: 11, fontFamily: "ui-monospace, monospace", borderCollapse: "collapse" }}>
                  <thead>
                    <tr>
                      <th style={th}>When</th>
                      <th style={th}>Purpose</th>
                      <th style={th}>Fields</th>
                    </tr>
                  </thead>
                  <tbody>
                    {hireLogs.slice(0, 20).map((log) => (
                      <tr key={log.id}>
                        <td style={td}>{new Date(log.accessed_at).toLocaleString()}</td>
                        <td style={td}>{log.purpose}</td>
                        <td style={td}>{log.fields_accessed.join(", ")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </details>
          </div>
        );
      })}
    </div>
  );
}

const card: React.CSSProperties = {
  background: "#0e0e10",
  border: "1px solid #1f1f23",
  borderRadius: 8,
  padding: 16,
};
const heading: React.CSSProperties = { margin: 0, marginBottom: 8, fontSize: 15, color: "#e6e6e6" };
const text: React.CSSProperties = { color: "#8a8a92", fontSize: 13, margin: 0, lineHeight: 1.5 };
const link: React.CSSProperties = { color: "#4ec9b0", textDecoration: "underline", display: "inline-block", padding: "14px 4px" };
const hireCard: React.CSSProperties = {
  background: "#0a0a0a",
  border: "1px solid #1f1f23",
  borderRadius: 6,
  padding: 12,
  marginBottom: 10,
};
const chip: React.CSSProperties = {
  background: "#0e1f1a",
  color: "#4ec9b0",
  border: "1px solid #2a6b5e",
  borderRadius: 3,
  padding: "2px 6px",
  fontSize: 10,
  fontFamily: "ui-monospace, monospace",
};
const revokeButton: React.CSSProperties = {
  background: "transparent",
  color: "#e09999",
  border: "1px solid #5a2c2c",
  borderRadius: 4,
  padding: "3px 9px",
  fontSize: 11,
  fontFamily: "ui-monospace, monospace",
  cursor: "pointer",
};
const th: React.CSSProperties = { textAlign: "left", padding: "3px 6px 3px 0", color: "#8a8a92", borderBottom: "1px solid #1f1f23", fontWeight: 400 };
const td: React.CSSProperties = { padding: "3px 6px 3px 0", color: "#e6e6e6", borderBottom: "1px solid #15151a" };
