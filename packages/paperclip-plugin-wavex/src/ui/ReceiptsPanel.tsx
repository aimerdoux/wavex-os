/** Mission Control — KPI Receipts side panel (Frontier F3).
 *
 *  Portaled drawer that slides in from the right when the operator
 *  clicks any KPI number. Shows the causal chain that produced the
 *  number: contributors, deliverables, cost, and a confidence label.
 *
 *  This is the "show your work" surface — non-technical users see
 *  receipts before they can trust the headline numbers.
 *
 *  Mount via: <ReceiptsPanel companyId={...} kpiId={...} onClose={...} />
 *  Pass a null/empty kpiId to render nothing.
 */

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { usePluginData } from "@paperclipai/plugin-sdk/ui";

const MINT = "#4ec9b0";
const URGENT = "#ff6b6b";
const WARN = "#ffd166";
const GOOD = "#4ade80";
const TEXT = "rgba(255,255,255,0.92)";
const TEXT_MUTED = "rgba(255,255,255,0.62)";
const TEXT_DIM = "rgba(255,255,255,0.45)";
const SURFACE = "#0f1419";
const SURFACE_ALT = "rgba(255,255,255,0.03)";
const BORDER = "rgba(255,255,255,0.08)";

type Confidence = "high" | "medium" | "low" | "unknown";
type State = "confirmed" | "forecast";

interface ReceiptDeliverable {
  id: string;
  title: string;
  kind: string;
  status: string;
}
interface ReceiptContributor {
  taskRefId: string;
  taskRefType: string;
  ownerNodeId: string | null;
  ownerName: string | null;
  forecastDelta: number;
  realizedDelta: number | null;
  accuracy: number | null;
  state: State;
  measureAt: string;
  measuredAt: string | null;
  deliverables: ReceiptDeliverable[];
}
interface ReceiptsResponse {
  ok: boolean;
  kpiId?: string;
  current?: number | null;
  target?: number | null;
  delta?: number | null;
  status?: string | null;
  freshnessWarning?: boolean;
  totalImpacts?: number;
  measuredImpacts?: number;
  cumulativeForecast?: number;
  cumulativeRealized?: number;
  confidence?: Confidence;
  totalSpendUSD?: number;
  dollarsPerPoint?: number | null;
  contributors?: ReceiptContributor[];
  generatedAt?: string;
}

const CONFIDENCE_COLOR: Record<Confidence, string> = {
  high: GOOD,
  medium: WARN,
  low: URGENT,
  unknown: TEXT_MUTED,
};

const STATUS_COLOR: Record<string, string> = {
  "on-track": GOOD,
  "at-risk": WARN,
  "off-track": URGENT,
};

function fmtNum(n: number | null | undefined, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return Number.isInteger(n) ? String(n) : n.toFixed(digits);
}

function fmtPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${Math.round(n * 100)}%`;
}

export function ReceiptsPanel({
  companyId,
  kpiId,
  onClose,
}: {
  companyId: string;
  kpiId: string | null;
  onClose: () => void;
}) {
  const open = !!kpiId;
  const { data, loading, error } = usePluginData<ReceiptsResponse>(
    "mission-control-kpi-receipts",
    open ? { companyId, kpiId } : { companyId: "", kpiId: "" },
  );

  // ESC to close + body scroll lock
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  const confidence: Confidence = data?.confidence ?? "unknown";
  const statusColor = data?.status ? STATUS_COLOR[data.status] ?? TEXT_MUTED : TEXT_MUTED;

  const panel = (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        role="presentation"
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(2, 6, 23, 0.65)",
          zIndex: 999,
        }}
      />
      {/* Panel */}
      <aside
        role="dialog"
        aria-label={`Receipts for ${kpiId}`}
        style={{
          position: "fixed",
          top: 0,
          right: 0,
          bottom: 0,
          width: "min(560px, 96vw)",
          background: SURFACE,
          color: TEXT,
          borderLeft: `1px solid ${BORDER}`,
          boxShadow: "-12px 0 32px rgba(0,0,0,0.45)",
          zIndex: 1000,
          display: "flex",
          flexDirection: "column",
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, sans-serif",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "20px 24px 14px",
            borderBottom: `1px solid ${BORDER}`,
            display: "flex",
            alignItems: "flex-start",
            gap: 12,
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 11,
                letterSpacing: "0.08em",
                textTransform: "uppercase",
                color: MINT,
                fontWeight: 600,
                marginBottom: 4,
              }}
            >
              Receipts
            </div>
            <div
              style={{
                fontSize: 22,
                fontWeight: 600,
                color: TEXT,
                lineHeight: 1.25,
                letterSpacing: "-0.01em",
                fontFamily:
                  "'Inter Display', 'Inter', ui-sans-serif, system-ui, sans-serif",
              }}
            >
              {kpiId}
            </div>
            <div
              style={{
                marginTop: 6,
                display: "flex",
                gap: 12,
                alignItems: "baseline",
                flexWrap: "wrap",
              }}
            >
              <span
                style={{
                  fontSize: 28,
                  fontWeight: 600,
                  color: TEXT,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {fmtNum(data?.current ?? null)}
              </span>
              {data?.target != null ? (
                <span style={{ fontSize: 13, color: TEXT_MUTED }}>
                  / {fmtNum(data.target)}
                </span>
              ) : null}
              {data?.delta != null ? (
                <span
                  style={{
                    fontSize: 13,
                    color: (data.delta ?? 0) >= 0 ? GOOD : URGENT,
                    fontWeight: 500,
                  }}
                >
                  {data.delta >= 0 ? "+" : ""}
                  {fmtNum(data.delta)}
                </span>
              ) : null}
              {data?.status ? (
                <Pill color={statusColor} label={data.status} />
              ) : null}
              {data?.freshnessWarning ? (
                <Pill color={WARN} label="stale" />
              ) : null}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close receipts"
            style={{
              background: "none",
              border: "none",
              color: TEXT_MUTED,
              cursor: "pointer",
              fontSize: 22,
              padding: "0 6px",
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: "auto", padding: "16px 24px 32px" }}>
          {loading && !data ? (
            <Empty>Loading receipts…</Empty>
          ) : error ? (
            <Empty>Could not load: {error.message}</Empty>
          ) : (
            <>
              {/* Confidence + cost summary */}
              <Section title="Confidence">
                <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
                  <Stat
                    label="Confidence"
                    value={confidence}
                    color={CONFIDENCE_COLOR[confidence]}
                    hint={`${data?.measuredImpacts ?? 0} of ${data?.totalImpacts ?? 0} impacts measured`}
                  />
                  <Stat
                    label="Spent"
                    value={`$${(data?.totalSpendUSD ?? 0).toFixed(2)}`}
                    hint="last 365d on tasks linked to this KPI"
                  />
                  <Stat
                    label="$ per point"
                    value={
                      data?.dollarsPerPoint != null
                        ? `$${data.dollarsPerPoint.toFixed(2)}`
                        : "—"
                    }
                    hint="cost ÷ measured delta"
                  />
                </div>
              </Section>

              {/* Cumulative forecast vs realized */}
              <Section title="Movement">
                <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
                  <Stat
                    label="Forecast (all)"
                    value={fmtNum(data?.cumulativeForecast)}
                    hint="sum of declared impacts"
                  />
                  <Stat
                    label="Realized"
                    value={fmtNum(data?.cumulativeRealized)}
                    color={
                      (data?.cumulativeRealized ?? 0) >= (data?.cumulativeForecast ?? 0) * 0.7
                        ? GOOD
                        : WARN
                    }
                    hint="sum of measured deltas"
                  />
                </div>
              </Section>

              {/* Causal chain */}
              <Section title={`Who moved it (${data?.contributors?.length ?? 0})`}>
                {(data?.contributors?.length ?? 0) === 0 ? (
                  <Empty>
                    No declared impacts yet. Declare one on any task with{" "}
                    <code>POST /api/mission-control/.../kpi-impacts</code> so this
                    KPI gets attribution.
                  </Empty>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {data?.contributors?.map((c) => (
                      <ContributorRow key={c.taskRefId} c={c} />
                    ))}
                  </div>
                )}
              </Section>
            </>
          )}
        </div>
      </aside>
    </>
  );

  return createPortal(panel, document.body);
}

function ContributorRow({ c }: { c: ReceiptContributor }) {
  const isConfirmed = c.state === "confirmed";
  const accentColor = isConfirmed ? GOOD : MINT;
  return (
    <div
      style={{
        padding: "12px 14px",
        background: SURFACE_ALT,
        border: `1px solid ${BORDER}`,
        borderRadius: 8,
      }}
    >
      <div
        style={{
          display: "flex",
          gap: 10,
          alignItems: "baseline",
          flexWrap: "wrap",
        }}
      >
        <strong style={{ fontSize: 13, color: TEXT }}>
          {c.ownerName ?? "(unassigned)"}
        </strong>
        <span style={{ fontSize: 11, color: TEXT_DIM }}>
          task {c.taskRefId.slice(0, 10)}
        </span>
        <span style={{ marginLeft: "auto" }}>
          <Pill color={accentColor} label={isConfirmed ? "confirmed" : "forecast"} />
        </span>
      </div>
      <div
        style={{
          marginTop: 6,
          display: "flex",
          gap: 16,
          fontSize: 12,
          color: TEXT_MUTED,
        }}
      >
        <span>
          forecast{" "}
          <span style={{ color: TEXT }}>
            {c.forecastDelta >= 0 ? "+" : ""}
            {fmtNum(c.forecastDelta)}
          </span>
        </span>
        {c.realizedDelta != null ? (
          <span>
            realized{" "}
            <span style={{ color: TEXT }}>
              {c.realizedDelta >= 0 ? "+" : ""}
              {fmtNum(c.realizedDelta)}
            </span>
          </span>
        ) : null}
        {c.accuracy != null ? (
          <span>
            accuracy{" "}
            <span
              style={{
                color:
                  c.accuracy >= 0.8 ? GOOD : c.accuracy >= 0.5 ? WARN : URGENT,
              }}
            >
              {fmtPct(c.accuracy)}
            </span>
          </span>
        ) : null}
      </div>
      {c.deliverables.length > 0 ? (
        <ul
          style={{
            marginTop: 8,
            paddingLeft: 18,
            color: TEXT_MUTED,
            fontSize: 12,
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
        >
          {c.deliverables.slice(0, 5).map((d) => (
            <li key={d.id}>
              <span style={{ color: TEXT }}>{d.title}</span>{" "}
              <span style={{ color: TEXT_DIM }}>· {d.kind} · {d.status}</span>
            </li>
          ))}
          {c.deliverables.length > 5 ? (
            <li style={{ color: TEXT_DIM, listStyle: "none", marginLeft: -18 }}>
              + {c.deliverables.length - 5} more
            </li>
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 22 }}>
      <h3
        style={{
          fontSize: 11,
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.06em",
          color: TEXT_DIM,
          margin: "0 0 10px",
        }}
      >
        {title}
      </h3>
      {children}
    </section>
  );
}

function Stat({
  label,
  value,
  hint,
  color,
}: {
  label: string;
  value: string;
  hint?: string;
  color?: string;
}) {
  return (
    <div style={{ minWidth: 100 }}>
      <div style={{ fontSize: 11, color: TEXT_DIM, marginBottom: 4 }}>
        {label}
      </div>
      <div
        style={{
          fontSize: 18,
          fontWeight: 600,
          color: color ?? TEXT,
          textTransform: label === "Confidence" ? "capitalize" : "none",
          fontVariantNumeric: "tabular-nums",
          lineHeight: 1.1,
        }}
      >
        {value}
      </div>
      {hint ? (
        <div style={{ fontSize: 10, color: TEXT_DIM, marginTop: 4 }}>
          {hint}
        </div>
      ) : null}
    </div>
  );
}

function Pill({ color, label }: { color: string; label: string }) {
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: "0.04em",
        padding: "2px 7px",
        borderRadius: 4,
        background: `color-mix(in srgb, ${color} 18%, transparent)`,
        color,
        whiteSpace: "nowrap",
      }}
    >
      {label.replace(/_/g, " ")}
    </span>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: "16px",
        fontSize: 13,
        color: TEXT_MUTED,
        background: SURFACE_ALT,
        border: `1px solid ${BORDER}`,
        borderRadius: 8,
        lineHeight: 1.5,
      }}
    >
      {children}
    </div>
  );
}
