/** Mission Control — KPI Scoreboard v2 (Phase 2 of MC v2 polish).
 *
 *  For each KPI: current value (bold), target (muted), delta arrow,
 *  status pill, 80px sparkline, freshness warning chip, owner avatars,
 *  click → in-card drilldown. Polls /scoreboard-rich which joins
 *  expected_kpi_impacts with kpi_snapshots time series. */

import { useEffect, useMemo, useState } from "react";
import {
  usePluginAction,
  usePluginData,
  type PluginWidgetProps,
} from "@wavex-os/plugin-sdk-shim/ui";
import { ReceiptsPanel } from "./ReceiptsPanel.js";

const WAVEX_COLOR = "#00d4ff";
const WAVEX_BG = "color-mix(in srgb, #00d4ff 6%, transparent)";

type KpiStatus = "on-track" | "at-risk" | "off-track";

interface KpiHistoryPoint {
  at: string;
  value: number;
}

interface ScoreboardEntry {
  kpiId: string;
  totalImpacts: number;
  measuredImpacts: number;
  dueNow: number;
  cumulativeEstimated: number;
  cumulativeActual: number;
  attainmentRatio: number;
  ownerNodeIds: string[];
  current: number;
  target: number;
  delta: number;
  status: KpiStatus;
  lastMeasuredAt: string | null;
  freshnessWarning: boolean;
  history: KpiHistoryPoint[];
}

interface ScoreboardResponse {
  ok: boolean;
  scoreboard: ScoreboardEntry[];
  error?: string;
}

interface ScopeNode {
  id: string;
  name: string;
  shortId?: string;
}
interface ScopeTreeResponse {
  ok: boolean;
  tree?: { nodes?: ScopeNode[] };
}

function formatNum(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

const STATUS_COLOR: Record<KpiStatus, string> = {
  "on-track": "#4ade80",
  "at-risk": "#ffd166",
  "off-track": "#ff6b6b",
};

const STATUS_LABEL: Record<KpiStatus, string> = {
  "on-track": "on track",
  "at-risk": "at risk",
  "off-track": "off track",
};

export function MissionControlScoreboardWidget({
  context,
}: PluginWidgetProps) {
  const companyId = context.companyId ?? "";
  const board = usePluginData<ScoreboardResponse>(
    "mission-control-scoreboard-rich",
    { companyId },
  );
  const tree = usePluginData<ScopeTreeResponse>(
    "mission-control-scope-tree",
    { companyId },
  );
  const sample = usePluginAction("mission-control-sample-kpis");
  const [opening, setOpening] = useState<string | null>(null);
  const [sampleStatus, setSampleStatus] = useState<string | null>(null);
  const [receiptsKpi, setReceiptsKpi] = useState<string | null>(null);

  useEffect(() => {
    setSampleStatus(null);
    setOpening(null);
  }, [companyId]);

  const nodeNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of tree.data?.tree?.nodes ?? []) m.set(n.id, n.name);
    return m;
  }, [tree.data]);

  if (!companyId) {
    return (
      <Card label="Mission Control — KPI Scoreboard">
        <div style={{ opacity: 0.7 }}>Select a company.</div>
      </Card>
    );
  }
  if (board.loading && !board.data) {
    return (
      <Card label="Mission Control — KPI Scoreboard">
        <div style={{ opacity: 0.6 }}>Loading scoreboard…</div>
      </Card>
    );
  }
  if (board.error) {
    return (
      <Card label="Mission Control — KPI Scoreboard">
        <div style={{ color: "#ff6b6b" }}>
          Couldn't load: {board.error.message}{" "}
          <button type="button" onClick={board.refresh} style={linkStyle}>
            retry
          </button>
        </div>
      </Card>
    );
  }
  const entries = board.data?.scoreboard ?? [];

  return (
    <Card label="Mission Control — KPI Scoreboard">
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 8,
          fontSize: 12,
          opacity: 0.65,
        }}
      >
        <span>
          {entries.length} {entries.length === 1 ? "KPI" : "KPIs"} tracked
        </span>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            onClick={async () => {
              const res = (await sample({ companyId })) as {
                sampled?: number;
              };
              setSampleStatus(`sampled ${res?.sampled ?? 0} KPIs`);
              board.refresh();
            }}
            style={linkStyle}
            title="Capture a snapshot row for each KPI right now (sparkline tick)"
          >
            sample now
          </button>
          <button type="button" onClick={board.refresh} style={linkStyle}>
            refresh
          </button>
        </div>
      </div>
      {sampleStatus ? (
        <div
          style={{ fontSize: 11, opacity: 0.7, color: WAVEX_COLOR, marginBottom: 6 }}
        >
          {sampleStatus}
        </div>
      ) : null}
      {entries.length === 0 ? (
        <div style={{ opacity: 0.7, padding: "8px 0", fontSize: 13 }}>
          No KPI impacts declared yet. Tasks declare an expected impact
          when they emit a task_originated event.
        </div>
      ) : (
        <div style={{ display: "grid", gap: 16 }}>
          {entries.map((e) => (
            <KpiRow
              key={e.kpiId}
              entry={e}
              nodeNameById={nodeNameById}
              open={opening === e.kpiId}
              onToggle={() =>
                setOpening((prev) => (prev === e.kpiId ? null : e.kpiId))
              }
              onOpenReceipts={() => setReceiptsKpi(e.kpiId)}
            />
          ))}
        </div>
      )}
      <ReceiptsPanel
        companyId={companyId}
        kpiId={receiptsKpi}
        onClose={() => setReceiptsKpi(null)}
      />
    </Card>
  );
}

function KpiRow({
  entry,
  nodeNameById,
  open,
  onToggle,
  onOpenReceipts,
}: {
  entry: ScoreboardEntry;
  nodeNameById: Map<string, string>;
  open: boolean;
  onToggle: () => void;
  onOpenReceipts: () => void;
}) {
  const status = entry.status;
  const owners = entry.ownerNodeIds
    .map((id) => nodeNameById.get(id) ?? id)
    .slice(0, 3);
  const deltaSign = entry.delta > 0 ? "+" : entry.delta < 0 ? "−" : "";
  const deltaColor =
    entry.delta > 0
      ? "#4ade80"
      : entry.delta < 0
        ? "#ff6b6b"
        : "rgba(255,255,255,0.5)";
  return (
    <div
      onClick={onToggle}
      style={{
        cursor: "pointer",
        borderLeft: `3px solid ${STATUS_COLOR[status]}`,
        paddingLeft: 10,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 10,
          marginBottom: 4,
        }}
      >
        <div style={{ fontWeight: 600, fontSize: 14 }}>{entry.kpiId}</div>
        <span
          style={{
            fontSize: 10,
            padding: "2px 6px",
            borderRadius: 4,
            background: `color-mix(in srgb, ${STATUS_COLOR[status]} 18%, transparent)`,
            color: STATUS_COLOR[status],
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.05em",
          }}
        >
          {STATUS_LABEL[status]}
        </span>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onOpenReceipts(); }}
          aria-label={`Open receipts for ${entry.kpiId}`}
          style={{
            marginLeft: "auto",
            background: "none",
            border: "1px solid rgba(78, 201, 176, 0.4)",
            color: "#4ec9b0",
            cursor: "pointer",
            fontSize: 10,
            padding: "2px 8px",
            borderRadius: 4,
            fontFamily: "inherit",
            letterSpacing: "0.04em",
            textTransform: "uppercase",
            fontWeight: 600,
          }}
        >
          Receipts →
        </button>
        {entry.freshnessWarning ? (
          <span
            style={{
              fontSize: 10,
              padding: "2px 6px",
              borderRadius: 4,
              border: "1px solid rgba(255, 209, 102, 0.5)",
              color: "#ffd166",
            }}
            title="Last measurement is > 7 days old"
          >
            ⚠ stale
          </span>
        ) : null}
        {entry.dueNow > 0 ? (
          <span
            style={{
              fontSize: 10,
              padding: "2px 6px",
              borderRadius: 4,
              border: "1px solid rgba(255, 209, 102, 0.5)",
              color: "#ffd166",
            }}
          >
            {entry.dueNow} due
          </span>
        ) : null}
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
          <span style={{ fontSize: 22, fontWeight: 600, color: WAVEX_COLOR }}>
            {formatNum(entry.current)}
          </span>
          <span style={{ fontSize: 12, opacity: 0.55 }}>
            / {formatNum(entry.target)}
          </span>
        </div>
        {entry.delta !== 0 ? (
          <span style={{ fontSize: 12, color: deltaColor, fontWeight: 600 }}>
            {deltaSign}
            {formatNum(Math.abs(entry.delta))}
          </span>
        ) : null}
        <Sparkline points={entry.history} color={STATUS_COLOR[status]} />
        {owners.length > 0 ? (
          <div style={{ display: "flex", gap: 4, marginLeft: "auto" }}>
            {owners.map((name) => (
              <span
                key={name}
                title={name}
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: "50%",
                  background: `color-mix(in srgb, ${WAVEX_COLOR} 22%, transparent)`,
                  color: WAVEX_COLOR,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 10,
                  fontWeight: 600,
                }}
              >
                {initialsOf(name)}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      <div
        style={{
          fontSize: 11,
          opacity: 0.55,
          marginTop: 4,
          display: "flex",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <span>
          {entry.measuredImpacts}/{entry.totalImpacts} measured
        </span>
        {entry.lastMeasuredAt ? (
          <span>
            last sampled {formatRelative(entry.lastMeasuredAt)}
          </span>
        ) : (
          <span>no samples yet — click "sample now"</span>
        )}
      </div>
      {open ? (
        <div
          style={{
            marginTop: 10,
            padding: 10,
            borderRadius: 6,
            background: "rgba(0,0,0,0.2)",
            fontSize: 12,
            color: "rgba(255,255,255,0.78)",
          }}
        >
          <strong style={{ color: WAVEX_COLOR }}>What's moving this KPI</strong>
          <div style={{ marginTop: 6, opacity: 0.65 }}>
            {entry.totalImpacts === 0
              ? "No declared task impacts yet."
              : `${entry.totalImpacts} task impact${entry.totalImpacts === 1 ? "" : "s"} declared; ${entry.measuredImpacts} measured. Open Mission Control → Causal DAG widget for the full task chain (Phase 3).`}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Sparkline({
  points,
  color,
}: {
  points: KpiHistoryPoint[];
  color: string;
}) {
  if (points.length < 2) {
    return (
      <span style={{ fontSize: 11, opacity: 0.4, fontStyle: "italic" }}>
        — sparkline pending —
      </span>
    );
  }
  const w = 80;
  const h = 26;
  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const xs = points.map(
    (_, i) => (i / (points.length - 1)) * (w - 2) + 1,
  );
  const ys = points.map((p) => h - 1 - ((p.value - min) / range) * (h - 2));
  const d = xs.map((x, i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${ys[i]!.toFixed(1)}`).join(" ");
  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      aria-hidden
      style={{ display: "inline-block" }}
    >
      <path d={d} stroke={color} strokeWidth={1.5} fill="none" />
      <circle
        cx={xs[xs.length - 1]}
        cy={ys[ys.length - 1]}
        r={2}
        fill={color}
      />
    </svg>
  );
}

function initialsOf(name: string): string {
  return (
    name
      .split(/[\s/_\-:]+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((s) => s[0])
      .join("")
      .toUpperCase() || "?"
  );
}

function formatRelative(at: string): string {
  const delta = Math.max(0, Date.now() - new Date(at).getTime());
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}

function Card({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-label={label}
      style={{
        padding: "12px 14px",
        borderRadius: 6,
        border: `1px solid color-mix(in srgb, ${WAVEX_COLOR} 25%, transparent)`,
        background: WAVEX_BG,
      }}
    >
      <div
        style={{
          fontSize: 11,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          opacity: 0.7,
          marginBottom: 8,
          color: WAVEX_COLOR,
        }}
      >
        {label}
      </div>
      {children}
    </section>
  );
}

const linkStyle: React.CSSProperties = {
  background: "none",
  color: WAVEX_COLOR,
  border: "none",
  cursor: "pointer",
  fontSize: 12,
  padding: 0,
};
