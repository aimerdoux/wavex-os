/**
 * The hire-an-Expert-Agent flow on /pricing.
 *
 * 3 steps:
 *   1. Browse — operator sees a card per Expert Agent in the catalog. Tier
 *      gates are visible. Already-hired agents show "Manage" instead of
 *      "Hire". Clicking "Hire" enters Step 2.
 *   2. Scope + Agreement — operator sees the agent's data_scope as a list
 *      of fields, the Processing Agreement link, and a consent checkbox.
 *      Checkbox MUST be ticked before "Continue to checkout" enables.
 *   3. Checkout — operator is redirected to Stripe for the underlying tier
 *      subscription (handled by Pricing.tsx).
 *
 * If operator already has an active subscription at the required tier, the
 * agent is hired directly (POST /api/billing/hire-agent) and Stripe is
 * skipped.
 */
import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { getSupabase } from "../lib/supabase";

const AGREEMENT_VERSION = "1.0";
const AGREEMENT_URL = "https://github.com/aimerdoux/wavex-os/blob/main/docs/legal/EXPERT_AGENT_PROCESSING_AGREEMENT.md";

interface CatalogEntry {
  id: string;
  display_name: string;
  purpose: string;
  data_scope: string[];
  output_types: string[];
  required_tier: "founder" | "growth" | "custom";
  daily_token_cap: number;
}

interface HireRow {
  hire_id: string;
  catalog_id: string;
  status: string;
  hired_at: string;
}

export interface HireAgentFlowProps {
  session: Session | null;
  currentTier: "founder" | "growth" | "custom" | null;
  onHireRequest: (catalogId: string, requiredTier: "founder" | "growth" | "custom") => void;
}

export function HireAgentFlow({ session, currentTier, onHireRequest }: HireAgentFlowProps): JSX.Element {
  const supabase = getSupabase();
  const [catalog, setCatalog] = useState<CatalogEntry[] | null>(null);
  const [hires, setHires] = useState<HireRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scopeFor, setScopeFor] = useState<CatalogEntry | null>(null);
  const [consentChecked, setConsentChecked] = useState(false);

  useEffect(() => {
    if (!supabase) return;
    let cancelled = false;
    void (async () => {
      try {
        // Route through the SECURITY DEFINER RPC instead of direct
        // PostgREST. The wavex_os schema is intentionally NOT exposed
        // (would force every table to be anon-safe). RPC keeps the
        // boundary inside the function body. Same shape as a direct
        // select on expert_agent_catalog.
        const { data: cat, error: catErr } = await supabase
          .rpc("wavex_os_list_active_catalog");
        if (catErr) throw catErr;
        if (!cancelled) setCatalog((cat ?? []) as CatalogEntry[]);

        if (session) {
          const { data: myHires } = await supabase.rpc("wavex_os_list_my_hires");
          if (!cancelled) setHires((myHires ?? []) as HireRow[]);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [supabase, session]);

  if (!supabase) return <></>;
  if (loading) return <div style={{ color: "#8a8a92", padding: 16, fontSize: 14 }}>Loading Expert Agent catalog…</div>;
  if (error) return <div style={errorCard}>Failed to load catalog: {error}</div>;
  if (!catalog) return <></>;

  // ── Step 2: scope + agreement ──────────────────────────────────────
  if (scopeFor) {
    const tierOk = currentTier === scopeFor.required_tier ||
      (scopeFor.required_tier === "founder" && (currentTier === "growth" || currentTier === "custom")) ||
      (scopeFor.required_tier === "growth" && currentTier === "custom");

    return (
      <div style={panel}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 16, flexWrap: "wrap", gap: 12 }}>
          <h2 style={{ margin: 0, fontSize: 22 }}>Hire {scopeFor.display_name}</h2>
          <button type="button" onClick={() => { setScopeFor(null); setConsentChecked(false); }} style={ghostButton}>← Back</button>
        </div>

        <p style={{ color: "#8a8a92", fontSize: 14, lineHeight: 1.5 }}>{scopeFor.purpose}</p>

        <div style={{ marginTop: 24 }}>
          <strong style={{ color: "#e6e6e6", fontSize: 14, fontFamily: "ui-monospace, monospace" }}>data_scope</strong>
          <p style={{ color: "#8a8a92", fontSize: 13, margin: "4px 0 8px" }}>
            By hiring this agent, you consent to it reading these fields of your fleet — and no others.
          </p>
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexWrap: "wrap", gap: 6 }}>
            {scopeFor.data_scope.map((field) => (
              <li key={field} style={chip}>{field}</li>
            ))}
          </ul>
        </div>

        <div style={{ marginTop: 16 }}>
          <strong style={{ color: "#e6e6e6", fontSize: 14, fontFamily: "ui-monospace, monospace" }}>output_types</strong>
          <p style={{ color: "#8a8a92", fontSize: 13, margin: "4px 0 8px" }}>
            What this agent can produce. Outputs are signed server-side; your Liaison agent verifies before posting to your local Paperclip.
          </p>
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexWrap: "wrap", gap: 6 }}>
            {scopeFor.output_types.map((kind) => (
              <li key={kind} style={chip}>{kind}</li>
            ))}
          </ul>
        </div>

        <div style={{ marginTop: 16, fontSize: 13, color: "#8a8a92" }}>
          <strong style={{ color: "#e6e6e6", fontFamily: "ui-monospace, monospace" }}>daily_token_cap</strong>:&nbsp;
          {scopeFor.daily_token_cap.toLocaleString()} tokens / day. When this cap hits, the agent idles until the next UTC day.
        </div>

        <div style={{ marginTop: 24, padding: 16, background: "#0a0a0a", border: "1px solid #1f1f23", borderRadius: 8 }}>
          <label style={{ display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={consentChecked}
              onChange={(e) => setConsentChecked(e.target.checked)}
              style={{ marginTop: 3 }}
            />
            <span style={{ fontSize: 13, color: "#e6e6e6", lineHeight: 1.5 }}>
              I have read and agree to the{" "}
              <a href={AGREEMENT_URL} target="_blank" rel="noopener noreferrer" style={{ color: "#4ec9b0", textDecoration: "underline" }}>
                WaveX Expert Agent Processing Agreement v{AGREEMENT_VERSION}
              </a>
              {" "}for {scopeFor.display_name}. I understand this agent will receive the fields listed above from my fleet, and that I can revoke at any time.
            </span>
          </label>
        </div>

        {!tierOk && (
          <div style={{ marginTop: 16, padding: 12, background: "#1f1715", border: "1px solid #5a3a30", borderRadius: 8, color: "#e0a899", fontSize: 13 }}>
            This agent requires the <strong>{scopeFor.required_tier}</strong> tier.
            {currentTier ? ` You're currently on ${currentTier}.` : " You don't have a subscription yet."}{" "}
            Clicking Continue starts checkout for the required tier.
          </div>
        )}

        <div style={{ marginTop: 20, display: "flex", gap: 12, justifyContent: "flex-end" }}>
          <button type="button" onClick={() => { setScopeFor(null); setConsentChecked(false); }} style={ghostButton}>Cancel</button>
          <button
            type="button"
            disabled={!consentChecked}
            onClick={() => onHireRequest(scopeFor.id, scopeFor.required_tier)}
            style={primaryButton(!consentChecked)}
          >
            {tierOk ? "Hire this agent" : `Continue to ${scopeFor.required_tier} checkout`}
          </button>
        </div>
      </div>
    );
  }

  // ── Step 1: browse catalog ─────────────────────────────────────────
  const hireByCatalogId = new Map(hires.filter((h) => h.status === "active").map((h) => [h.catalog_id, h]));

  return (
    <div>
      <h2 style={{ fontSize: 20, marginBottom: 8 }}>Hire a WaveX Expert Agent</h2>
      <p style={{ color: "#8a8a92", fontSize: 14, marginTop: 0, marginBottom: 20, lineHeight: 1.5 }}>
        Each agent has a specific data scope and purpose. You hire individually; each hire is its own consent event under the Processing Agreement.
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16 }}>
        {catalog.map((agent) => {
          const hired = hireByCatalogId.get(agent.id);
          return (
            <div key={agent.id} style={agentCard}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, marginBottom: 8 }}>
                <strong style={{ fontSize: 15 }}>{agent.display_name}</strong>
                <span style={tierBadge(agent.required_tier)}>{agent.required_tier}</span>
              </div>
              <p style={{ color: "#8a8a92", fontSize: 13, lineHeight: 1.5, flex: 1, margin: "8px 0 12px" }}>
                {agent.purpose}
              </p>
              <div style={{ fontSize: 11, color: "#8a8a92", fontFamily: "ui-monospace, monospace", marginBottom: 12 }}>
                reads {agent.data_scope.length} field{agent.data_scope.length === 1 ? "" : "s"} ·{" "}
                {agent.daily_token_cap.toLocaleString()} tok/d
              </div>
              {hired ? (
                <button type="button" disabled style={hiredButton}>✓ Hired</button>
              ) : (
                <button
                  type="button"
                  onClick={() => { setScopeFor(agent); setConsentChecked(false); }}
                  style={primaryButton(false)}
                  disabled={!session}
                >
                  {session ? "Hire →" : "Sign in to hire"}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── styles ────────────────────────────────────────────────────────────
const panel: React.CSSProperties = {
  background: "#0e0e10",
  border: "1px solid #1f1f23",
  borderRadius: 12,
  padding: 24,
};
const agentCard: React.CSSProperties = {
  background: "#0a0a0a",
  border: "1px solid #1f1f23",
  borderRadius: 8,
  padding: 16,
  display: "flex",
  flexDirection: "column",
};
const chip: React.CSSProperties = {
  background: "#0e1f1a",
  color: "#4ec9b0",
  border: "1px solid #2a6b5e",
  borderRadius: 4,
  padding: "3px 8px",
  fontSize: 11,
  fontFamily: "ui-monospace, monospace",
};
const tierBadge = (tier: string): React.CSSProperties => ({
  background: tier === "founder" ? "#0e1f1a" : tier === "growth" ? "#1a1e2f" : "#2a1a2f",
  color: tier === "founder" ? "#4ec9b0" : tier === "growth" ? "#7da3e6" : "#c97aa1",
  borderRadius: 3,
  padding: "1px 7px",
  fontSize: 10,
  fontFamily: "ui-monospace, monospace",
  textTransform: "uppercase",
  letterSpacing: 0.5,
});
const primaryButton = (disabled: boolean): React.CSSProperties => ({
  background: disabled ? "#1f1f23" : "#4ec9b0",
  color: disabled ? "#666" : "#0a0a0a",
  border: "none",
  borderRadius: 6,
  padding: "9px 16px",
  fontSize: 13,
  fontFamily: "ui-monospace, monospace",
  cursor: disabled ? "not-allowed" : "pointer",
  opacity: disabled ? 0.6 : 1,
  width: "100%",
});
const hiredButton: React.CSSProperties = {
  background: "transparent",
  color: "#4ec9b0",
  border: "1px solid #2a6b5e",
  borderRadius: 6,
  padding: "9px 16px",
  fontSize: 13,
  fontFamily: "ui-monospace, monospace",
  cursor: "default",
  width: "100%",
};
const ghostButton: React.CSSProperties = {
  background: "transparent",
  color: "#8a8a92",
  border: "1px solid #1f1f23",
  borderRadius: 6,
  padding: "8px 14px",
  fontSize: 13,
  fontFamily: "ui-monospace, monospace",
  cursor: "pointer",
};
const errorCard: React.CSSProperties = {
  background: "#1f1515",
  border: "1px solid #5a2c2c",
  color: "#e09999",
  padding: 12,
  borderRadius: 8,
  fontSize: 13,
};
