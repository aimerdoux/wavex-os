/** Confirm modal for the destructive Reset action.
 *
 *  UX-1 fix (2026-05-13): the previous 3-button flow ("Cancel" /
 *  "Reset only" / "Reset + restart →") plus 6 lines of esoteric copy
 *  ("manifests, signatures, MC report, refinement history") was the
 *  customer's first interaction with destructive UI. Simplified to a
 *  single primary action ("Start fresh →") that does the right thing
 *  (drop into Pillar 1 with the same companyId). Operators who want
 *  the "Reset only / back to welcome" flow can hold Alt while clicking
 *  for the advanced option, or use the legacy explicit affordance from
 *  the welcome screen. */

import { useState, useEffect } from "react";

interface Props {
  companyId: string;
  busy: boolean;
  onCancel: () => void;
  /** restart=true → after reset, drop the operator at Pillar 1 with the
   *  same companyId. restart=false → reset and stay on the welcome screen. */
  onConfirm: (restart: boolean) => void;
}

export function ConfirmResetModal({ companyId, busy, onCancel, onConfirm }: Props) {
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [busy, onCancel]);

  return (
    <div
      style={{
        position: "fixed", inset: 0,
        background: "rgba(0,0,0,0.6)",
        display: "flex", alignItems: "center", justifyContent: "center",
        zIndex: 1000,
      }}
      onClick={onCancel}
    >
      <div
        style={{
          background: "var(--surface)",
          border: "1px solid var(--warning)",
          borderRadius: 8,
          padding: "1.5rem",
          maxWidth: 440,
          width: "90%",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ marginTop: 0, color: "var(--warning)", marginBottom: ".75rem" }}>
          Start over with <code>{companyId}</code>?
        </h3>
        <p style={{ fontSize: 14, marginBottom: "1.25rem", color: "var(--text-dim)" }}>
          This clears your onboarding answers, manifests, and any DB state from a previous activation.
          The company name stays the same — you'll land on Pillar 1 with a clean slate.
        </p>

        {showAdvanced && (
          <div style={{ fontSize: 12, marginBottom: "1rem", color: "var(--text-dim)", paddingLeft: "1rem", borderLeft: "2px solid var(--warning)" }}>
            <strong>What gets deleted:</strong> pillar responses, manifests, signatures, Monte Carlo report,
            refinement history, agents, KPIs, credentials, audit log, snapshots, cost events, issues, attributions.
            <br /><br />
            <button
              type="button"
              onClick={() => onConfirm(false)}
              disabled={busy}
              style={{
                background: "transparent", color: "var(--warning)",
                border: "1px solid var(--warning)", padding: "0.25rem 0.5rem",
                borderRadius: 4, fontSize: 12, cursor: busy ? "not-allowed" : "pointer",
              }}
            >
              Reset only (don't restart — back to welcome)
            </button>
          </div>
        )}

        <div style={{ display: "flex", gap: "0.5rem", justifyContent: "space-between", alignItems: "center" }}>
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            style={{
              background: "transparent",
              color: "var(--text-dim)",
              border: "none",
              fontSize: 12,
              cursor: "pointer",
              textDecoration: "underline",
              padding: 0,
            }}
          >
            {showAdvanced ? "Hide details" : "What gets deleted?"}
          </button>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button type="button" className="secondary" onClick={onCancel} disabled={busy}>
              Cancel
            </button>
            <button
              type="button"
              onClick={() => onConfirm(true)}
              disabled={busy}
              style={{ background: "var(--warning)", color: "#000" }}
            >
              {busy ? "Resetting…" : "Start fresh →"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
