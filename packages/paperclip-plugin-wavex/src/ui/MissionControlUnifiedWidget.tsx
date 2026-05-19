/** Mission Control — Unified Surface (v0.7.0).
 *
 *  Replaces the 7 separate dashboardWidget slots with one cohesive
 *  decision-making surface. Layout:
 *
 *    ┌─ HERO KPIs (top, 4 cards) ───────────────────┐
 *    │ MRR  · QMR · Burn · Runway                   │
 *    ├──────────────────────┬───────────────────────┤
 *    │ ACTIVITY (spine)     │ CONTEXT (rail)        │
 *    │  - filter chips      │  swaps by selection:  │
 *    │  - search            │   kpi  → impact chain │
 *    │  - grouped events    │   node → profile      │
 *    │                      │   event→ deliverables │
 *    │                      │   null → top KPI      │
 *    ├──────────────────────┴───────────────────────┤
 *    │ OPS STATUS (footer, single line)             │
 *    └──────────────────────────────────────────────┘
 *
 *  Selection model: last-click-wins (no pins). Default selection =
 *  scoreboard's first entry (top by forecast impact) so the rail is
 *  never empty.
 *
 *  Data sources are all existing wavex MC endpoints — no new server
 *  work. This widget is purely a UI consolidation.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  usePluginData,
  type PluginWidgetProps,
} from "@wavex-os/plugin-sdk-shim/ui";
import type {
  ActivityEvent,
  Deliverable,
  KPI,
  ScopeNode,
  Task,
} from "@wavex-os/shared/types/mission-control";
import { renderEvent, type RenderContext } from "../renderers/index.js";
import { MissionControlHeadlineStrip } from "./MissionControlHeadline.js";
import { MissionControlDecisionQueue } from "./MissionControlDecisionQueue.js";
import { ReceiptsPanel } from "./ReceiptsPanel.js";

// WaveX OS palette — pulled from the wavexcard.com/os section.
//   Brand accent: mint #4ec9b0 (the WaveX OS terminal-green —
//                 dot, wordmark, primary CTAs, tab indicators)
//   Surface:      #020617 near-black (primary), #0a0a18 elevated
//   Text:         pure white primary, muted for secondary
//
// (The gold/amber palette on wavexcard.com is the *card* product;
//  the *OS* subpage is the mint-on-black brand we mirror here.)
const WAVEX_COLOR = "#4ec9b0";
const WAVEX_TEAL = "#4ec9b0";
const WAVEX_BG = "color-mix(in srgb, #4ec9b0 6%, transparent)";

// ─── Types ─────────────────────────────────────────────────────────────

interface ContextSelection {
  type: "kpi" | "node" | "event";
  id: string;
  label?: string;
}

interface KpiScoreboardRichRow {
  kpiId: string;
  current: number;
  target: number;
  delta: number;
  status: "on-track" | "at-risk" | "off-track";
  attainmentRatio: number;
  lastMeasuredAt: string | null;
  freshnessWarning: boolean;
  ownerNodeIds: string[];
  history: Array<{ at: string; value: number }>;
}
interface ScoreboardRichResponse {
  ok: boolean;
  scoreboard?: KpiScoreboardRichRow[];
  error?: string;
}

interface ScopeTreeEntry {
  id: string;
  name: string;
  kind: ScopeNode["kind"];
  parentId?: string;
  childIds?: string[];
  shortId?: string;
  slug?: string;
}
interface ActivityResponse {
  ok: boolean;
  events: ActivityEvent[];
  scopeNodes: ScopeTreeEntry[];
  kpis: Array<{ id: string; name: string }>;
  mode: RenderContext["mode"];
  source?: string;
}

interface ImpactNode {
  taskRefId: string;
  forecastDelta: number;
  realizedDelta: number | null;
  accuracy: number | null;
  ownerNodeId: string | null;
  deliverableIds: string[];
  impactId: string;
}
interface ImpactGraphResponse {
  ok: boolean;
  kpiId?: string;
  totalImpacts?: number;
  cumulativeForecast?: number;
  cumulativeRealized?: number;
  nodes?: ImpactNode[];
}

interface OpenAssignmentsResponse {
  ok: boolean;
  open?: Array<{
    id: string;
    taskRefId: string;
    fromNodeId: string;
    toNodeId: string;
    relation: string;
    at: string;
  }>;
}

interface DeliverablesResponse {
  ok: boolean;
  deliverables?: Array<{
    id: string;
    taskRefId: string;
    title: string;
    kind: string;
    status: string;
    producedAt: string;
    producedByNodeId: string;
  }>;
}

interface CostResponse {
  ok: boolean;
  totals?: { costUSD: number; events: number };
  byNode?: Array<{ nodeId: string; nodeName: string; costUSD: number; events: number }>;
}

interface AccountabilityGraphResponse {
  ok: boolean;
  graph?: {
    nodes: Array<{
      id: string;
      name: string;
      kind: string;
      health?: "healthy" | "at-risk" | "critical";
      isBottleneck?: boolean;
      openDeliverables?: number;
      openAssignments?: number;
    }>;
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────

function deriveShortIdClient(nodeId: string): string {
  if (nodeId.includes(":")) {
    const tail = nodeId.split(":").pop() ?? nodeId;
    return tail.length <= 8 ? tail : tail.slice(0, 8);
  }
  return nodeId.length <= 8 ? nodeId : nodeId.slice(-8);
}

function buildCtx(data: ActivityResponse | null | undefined): RenderContext | null {
  if (!data) return null;
  const byId = new Map<string, ScopeNode>();
  for (const n of data.scopeNodes) {
    byId.set(n.id, {
      id: n.id,
      kind: n.kind,
      name: n.name,
      shortId: n.shortId ?? deriveShortIdClient(n.id),
      slug: n.slug ?? n.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      parentId: n.parentId,
      childIds: n.childIds ?? [],
      metadata: {
        activeTaskCount: 0,
        kpisOwned: [],
        costThisPeriodUSD: 0,
      },
    });
  }
  const kpiCatalog = new Map<string, KPI>();
  for (const k of data.kpis) {
    kpiCatalog.set(k.id, {
      id: k.id,
      instanceId: "",
      name: k.name,
      type: "output",
      unit: "",
      target: 0,
      window: "day",
      source: { kind: "manual_input" },
      ownerNodeIds: [],
      history: [],
    });
  }
  return {
    mode: data.mode,
    scopeTree: { byId },
    kpiCatalog,
    taskCatalog: new Map<string, Task>(),
    deliverableCatalog: new Map<string, Deliverable>(),
  };
}

function formatRelative(at: string, now: number): string {
  const t = new Date(at).getTime();
  const delta = Math.max(0, now - t);
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h`;
  return `${Math.floor(delta / 86_400_000)}d`;
}

function formatNum(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function statusColor(status: string): string {
  switch (status) {
    case "on-track":
    case "healthy":
      return "#4ec9b0";
    case "at-risk":
      return "#ffaa00";
    case "off-track":
    case "critical":
      return "#ff4d4f";
    default:
      return "#8a8f98";
  }
}

function severityColor(severity: ActivityEvent["severity"]): string {
  switch (severity) {
    case "critical":
      return "#ff6b6b";
    case "warning":
      return "#ffd166";
    case "notable":
      return WAVEX_COLOR;
    case "info":
      return "#8a8f98";
  }
}

/** Map an event to a context selection. Prefers KPI > node > raw event. */
function eventToSelection(event: ActivityEvent): ContextSelection {
  if (event.kpiRef) return { type: "kpi", id: event.kpiRef.id, label: event.kpiRef.name };
  if (event.actorNodeId) return { type: "node", id: event.actorNodeId };
  return { type: "event", id: event.id };
}

// ─── Main widget ───────────────────────────────────────────────────────

export function MissionControlUnifiedWidget({ context }: PluginWidgetProps) {
  const companyId = context.companyId ?? "";
  const [selection, setSelection] = useState<ContextSelection | null>(null);
  const [receiptsKpi, setReceiptsKpi] = useState<string | null>(null);
  // Paperclip's dashboard renders plugin widgets in a `md:grid-cols-2`
  // Tailwind grid via PluginSlotMount's wrapper div. The wrapper is
  // outside our control, so we walk up to it on mount and ask it to
  // span both columns. Only affects this widget's specific wrapper —
  // other plugins still get their default single column.
  const rootRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const wrapper = rootRef.current?.parentElement;
    if (!wrapper) return;
    const prev = wrapper.style.gridColumn;
    wrapper.style.gridColumn = "1 / -1";
    return () => {
      wrapper.style.gridColumn = prev;
    };
  }, []);

  const scoreboard = usePluginData<ScoreboardRichResponse>(
    "mission-control-scoreboard-rich",
    { companyId },
  );
  const activity = usePluginData<ActivityResponse>(
    "mission-control-activity",
    { companyId },
  );

  const renderCtx = useMemo(() => buildCtx(activity.data), [activity.data]);

  // Default selection: top KPI by impact once scoreboard loads.
  useEffect(() => {
    if (selection != null) return;
    const top = scoreboard.data?.scoreboard?.[0];
    if (top) setSelection({ type: "kpi", id: top.kpiId, label: top.kpiId });
  }, [scoreboard.data, selection]);

  if (!companyId) {
    return (
      <Card label="Mission Control">
        <div style={{ opacity: 0.7 }}>Select a company.</div>
      </Card>
    );
  }

  return (
    <Card label="Mission Control" rootRef={rootRef}>
      <MissionControlHeadlineStrip context={context} />
      <div style={{ padding: "12px 18px 4px" }}>
        <MissionControlDecisionQueue context={context} mode="compact" />
      </div>
      <HeroKpiStrip
        rows={scoreboard.data?.scoreboard ?? []}
        loading={scoreboard.loading && !scoreboard.data}
        selectedKpiId={selection?.type === "kpi" ? selection.id : null}
        onSelect={(kpiId, label) =>
          setSelection({ type: "kpi", id: kpiId, label })
        }
        onOpenReceipts={(kpiId) => setReceiptsKpi(kpiId)}
      />
      <ReceiptsPanel
        companyId={companyId}
        kpiId={receiptsKpi}
        onClose={() => setReceiptsKpi(null)}
      />
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1.1fr) minmax(0, 1fr)",
          gap: 10,
          marginTop: 10,
          alignItems: "start",
        }}
      >
        <ActivitySpine
          companyId={companyId}
          activity={activity.data}
          loading={activity.loading && !activity.data}
          ctx={renderCtx}
          onSelectEvent={(ev) => setSelection(eventToSelection(ev))}
          onPoll={activity.refresh}
        />
        <ContextRail
          companyId={companyId}
          selection={selection}
          ctx={renderCtx}
        />
      </div>
      <OpsStatusBar companyId={companyId} />
    </Card>
  );
}

// ─── HERO KPI STRIP ────────────────────────────────────────────────────

function HeroKpiStrip({
  rows,
  loading,
  selectedKpiId,
  onSelect,
  onOpenReceipts,
}: {
  rows: KpiScoreboardRichRow[];
  loading: boolean;
  selectedKpiId: string | null;
  onSelect: (kpiId: string, label: string) => void;
  onOpenReceipts: (kpiId: string) => void;
}) {
  if (loading) {
    return (
      <div style={{ opacity: 0.6, fontSize: 12, padding: "6px 0" }}>
        Loading KPIs…
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div style={{ opacity: 0.7, fontSize: 12, padding: "6px 0" }}>
        No KPI impacts declared yet. Origination + measurements will
        populate this surface.
      </div>
    );
  }
  // Show up to 4 hero KPIs; rest hidden under a "+N" chip the user
  // can click to scroll the rail to a fuller list (future polish).
  const visible = rows.slice(0, 4);
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${visible.length}, minmax(0, 1fr))`,
        gap: 8,
      }}
    >
      {visible.map((r) => {
        const on = selectedKpiId === r.kpiId;
        return (
          <button
            key={r.kpiId}
            type="button"
            onClick={() => onSelect(r.kpiId, r.kpiId)}
            style={{
              padding: "8px 10px",
              borderRadius: 5,
              cursor: "pointer",
              textAlign: "left",
              border: `1px solid ${
                on
                  ? `color-mix(in srgb, ${WAVEX_COLOR} 60%, transparent)`
                  : "rgba(255,255,255,0.08)"
              }`,
              background: on
                ? `color-mix(in srgb, ${WAVEX_COLOR} 14%, transparent)`
                : "rgba(255,255,255,0.02)",
              color: "inherit",
              display: "grid",
              gap: 2,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              <span
                style={{
                  fontSize: 11,
                  opacity: 0.7,
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                  flex: 1,
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {r.kpiId}
              </span>
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => { e.stopPropagation(); onOpenReceipts(r.kpiId); }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    e.stopPropagation();
                    onOpenReceipts(r.kpiId);
                  }
                }}
                aria-label={`Open receipts for ${r.kpiId}`}
                title="Show receipts"
                style={{
                  fontSize: 9,
                  letterSpacing: "0.06em",
                  textTransform: "uppercase",
                  color: WAVEX_COLOR,
                  cursor: "pointer",
                  fontWeight: 600,
                  flexShrink: 0,
                }}
              >
                Receipts →
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
              <span style={{ fontSize: 20, fontWeight: 600 }}>
                {formatNum(r.current)}
              </span>
              {r.target ? (
                <span style={{ fontSize: 11, opacity: 0.55 }}>
                  / {formatNum(r.target)}
                </span>
              ) : null}
            </div>
            <Sparkline values={r.history.map((p) => p.value)} />
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}>
              <StatusPill status={r.status} />
              <DeltaArrow delta={r.delta} />
              {r.freshnessWarning ? (
                <span title="No measurement in >7d" style={{ color: "#ffaa00" }}>
                  ⚠
                </span>
              ) : null}
            </div>
          </button>
        );
      })}
    </div>
  );
}

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) {
    return (
      <div style={{ height: 18, opacity: 0.3, fontSize: 10 }}>—</div>
    );
  }
  const w = 100;
  const h = 18;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const step = w / (values.length - 1);
  const points = values
    .map((v, i) => `${(i * step).toFixed(1)},${(h - ((v - min) / range) * h).toFixed(1)}`)
    .join(" ");
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      style={{ width: "100%", height: 18, display: "block" }}
    >
      <polyline
        fill="none"
        stroke={WAVEX_COLOR}
        strokeWidth="1.5"
        points={points}
      />
    </svg>
  );
}

function StatusPill({ status }: { status: string }) {
  return (
    <span
      style={{
        fontSize: 9,
        textTransform: "uppercase",
        padding: "1px 5px",
        borderRadius: 8,
        background: `color-mix(in srgb, ${statusColor(status)} 18%, transparent)`,
        color: statusColor(status),
        letterSpacing: "0.04em",
      }}
    >
      {status}
    </span>
  );
}

function DeltaArrow({ delta }: { delta: number }) {
  if (delta === 0) return null;
  const up = delta > 0;
  return (
    <span style={{ color: up ? "#4ec9b0" : "#ff6b6b", fontWeight: 500 }}>
      {up ? "▲" : "▼"} {formatNum(Math.abs(delta))}
    </span>
  );
}

// ─── ACTIVITY SPINE ────────────────────────────────────────────────────

const WINDOW_MS = {
  "1h": 60 * 60_000,
  "24h": 24 * 60 * 60_000,
  "7d": 7 * 24 * 60 * 60_000,
  all: Number.POSITIVE_INFINITY,
} as const;
type WindowChoice = keyof typeof WINDOW_MS;

function ActivitySpine({
  companyId,
  activity,
  loading,
  ctx,
  onSelectEvent,
  onPoll,
}: {
  companyId: string;
  activity: ActivityResponse | null | undefined;
  loading: boolean;
  ctx: RenderContext | null;
  onSelectEvent: (event: ActivityEvent) => void;
  onPoll?: () => void;
}) {
  const [windowChoice, setWindowChoice] = useState<WindowChoice>("24h");
  const [query, setQuery] = useState("");
  const stream = { events: [] as ActivityEvent[], connected: Boolean(companyId) };
  useEffect(() => {
    if (!companyId || !onPoll) return;
    const handle = setInterval(() => onPoll(), 5000);
    return () => clearInterval(handle);
  }, [companyId, onPoll]);

  const merged = useMemo(() => {
    if (!activity || !ctx) return [];
    const m = new Map<string, ActivityEvent>();
    for (const e of activity.events) m.set(e.id, e);
    for (const e of stream.events) m.set(e.id, e);
    const list = Array.from(m.values()).sort((a, b) =>
      a.at < b.at ? 1 : a.at > b.at ? -1 : 0,
    );
    const cutoff =
      WINDOW_MS[windowChoice] === Number.POSITIVE_INFINITY
        ? 0
        : Date.now() - WINDOW_MS[windowChoice];
    const q = query.trim().toLowerCase();
    return list.filter((e) => {
      if (new Date(e.at).getTime() < cutoff) return false;
      if (q && !renderEvent(e, ctx).toLowerCase().includes(q)) return false;
      return true;
    });
  }, [activity, stream.events, ctx, windowChoice, query]);

  if (loading) {
    return (
      <Panel label="Activity">
        <div style={{ opacity: 0.6, fontSize: 12 }}>Loading…</div>
      </Panel>
    );
  }

  return (
    <Panel label="Activity" live={stream.connected}>
      <div
        style={{
          display: "flex",
          gap: 6,
          alignItems: "center",
          marginBottom: 6,
          flexWrap: "wrap",
        }}
      >
        <select
          value={windowChoice}
          onChange={(e) => setWindowChoice(e.target.value as WindowChoice)}
          style={selectStyle}
        >
          <option value="1h">1h</option>
          <option value="24h">24h</option>
          <option value="7d">7d</option>
          <option value="all">all</option>
        </select>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search…"
          style={{ ...selectStyle, flex: 1, minWidth: 100 }}
        />
        <span style={{ fontSize: 10, opacity: 0.55 }}>
          {merged.length} event{merged.length === 1 ? "" : "s"}
        </span>
      </div>
      {merged.length === 0 ? (
        <div style={{ opacity: 0.7, fontSize: 12, padding: "10px 0" }}>
          {activity?.events.length === 0
            ? "No activity yet."
            : "No events match the filters."}
        </div>
      ) : (
        <ol
          style={{
            listStyle: "none",
            margin: 0,
            padding: 0,
            maxHeight: 360,
            overflowY: "auto",
          }}
        >
          {merged.map((event) => (
            <EventRow
              key={event.id}
              event={event}
              ctx={ctx!}
              onClick={() => onSelectEvent(event)}
            />
          ))}
        </ol>
      )}
    </Panel>
  );
}

function EventRow({
  event,
  ctx,
  onClick,
}: {
  event: ActivityEvent;
  ctx: RenderContext;
  onClick: () => void;
}) {
  const sentence = renderEvent(event, ctx);
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        style={{
          display: "flex",
          gap: 8,
          padding: "6px 4px",
          width: "100%",
          textAlign: "left",
          background: "none",
          border: "none",
          borderBottom: "1px solid rgba(255,255,255,0.04)",
          color: "inherit",
          cursor: "pointer",
          fontSize: 12.5,
          lineHeight: 1.4,
        }}
      >
        <span
          aria-hidden
          style={{
            width: 5,
            height: 5,
            marginTop: 6,
            borderRadius: 3,
            background: severityColor(event.severity),
            flexShrink: 0,
          }}
        />
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ wordBreak: "break-word" }}>{sentence}</span>
          <span style={{ opacity: 0.5, fontSize: 10, marginLeft: 6 }}>
            {formatRelative(event.at, Date.now())} ago
          </span>
        </span>
      </button>
    </li>
  );
}

// ─── CONTEXT RAIL ──────────────────────────────────────────────────────

function ContextRail({
  companyId,
  selection,
  ctx,
}: {
  companyId: string;
  selection: ContextSelection | null;
  ctx: RenderContext | null;
}) {
  if (!selection) {
    return (
      <Panel label="Context">
        <div style={{ opacity: 0.6, fontSize: 12 }}>
          Click a KPI or an event to inspect.
        </div>
      </Panel>
    );
  }
  if (selection.type === "kpi") {
    return (
      <KpiContext
        companyId={companyId}
        kpiId={selection.id}
        label={selection.label}
        ctx={ctx}
      />
    );
  }
  if (selection.type === "node") {
    return (
      <NodeContext companyId={companyId} nodeId={selection.id} ctx={ctx} />
    );
  }
  return <EventContext companyId={companyId} eventId={selection.id} />;
}

function KpiContext({
  companyId,
  kpiId,
  label,
  ctx,
}: {
  companyId: string;
  kpiId: string;
  label?: string;
  ctx: RenderContext | null;
}) {
  const impact = usePluginData<ImpactGraphResponse>(
    "mission-control-impact-graph",
    { companyId, kpiId },
  );
  const nodes = impact.data?.nodes ?? [];
  const totalForecast = impact.data?.cumulativeForecast ?? 0;
  const totalRealized = impact.data?.cumulativeRealized ?? 0;
  const accuracy =
    totalForecast === 0
      ? null
      : Math.max(0, 1 - Math.abs(totalForecast - totalRealized) / Math.abs(totalForecast));

  return (
    <Panel label={`KPI · ${label ?? kpiId}`}>
      {impact.loading && !impact.data ? (
        <div style={{ opacity: 0.6, fontSize: 12 }}>Loading impact chain…</div>
      ) : nodes.length === 0 ? (
        <div style={{ opacity: 0.7, fontSize: 12 }}>
          No declared impacts for this KPI yet. Originate tasks with an
          ExpectedKpiImpact pointing to <code>{kpiId}</code>.
        </div>
      ) : (
        <>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr 1fr",
              gap: 6,
              fontSize: 11,
              marginBottom: 8,
            }}
          >
            <Stat label="forecast" value={formatNum(totalForecast)} />
            <Stat label="realized" value={formatNum(totalRealized)} />
            <Stat
              label="accuracy"
              value={accuracy == null ? "—" : `${Math.round(accuracy * 100)}%`}
            />
          </div>
          <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 4 }}>
            Top contributors:
          </div>
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {nodes
              .slice()
              .sort((a, b) => b.forecastDelta - a.forecastDelta)
              .slice(0, 6)
              .map((n) => {
                const ownerName =
                  n.ownerNodeId && ctx
                    ? ctx.scopeTree.byId.get(n.ownerNodeId)?.name ?? n.ownerNodeId
                    : "(unassigned)";
                return (
                  <li
                    key={n.impactId}
                    style={{
                      padding: "4px 0",
                      borderBottom: "1px solid rgba(255,255,255,0.04)",
                      fontSize: 12,
                      display: "flex",
                      gap: 6,
                      alignItems: "baseline",
                    }}
                  >
                    <span style={{ color: WAVEX_COLOR, minWidth: 70 }}>
                      {formatNum(n.forecastDelta)}
                    </span>
                    <span style={{ flex: 1, minWidth: 0 }}>
                      task <code>{n.taskRefId.slice(0, 8)}</code> · {ownerName}
                    </span>
                    {n.realizedDelta != null ? (
                      <span style={{ opacity: 0.6, fontSize: 11 }}>
                        actual {formatNum(n.realizedDelta)}
                      </span>
                    ) : null}
                  </li>
                );
              })}
          </ul>
        </>
      )}
    </Panel>
  );
}

function NodeContext({
  companyId,
  nodeId,
  ctx,
}: {
  companyId: string;
  nodeId: string;
  ctx: RenderContext | null;
}) {
  const open = usePluginData<OpenAssignmentsResponse>(
    "mission-control-node-open-assignments",
    { companyId, nodeId },
  );
  const node = ctx?.scopeTree.byId.get(nodeId);
  const items = open.data?.open ?? [];
  return (
    <Panel label={`Node · ${node?.name ?? nodeId.slice(0, 12)}`}>
      <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 6 }}>
        {node?.kind ?? "unknown"} · {items.length} open assignment
        {items.length === 1 ? "" : "s"}
      </div>
      {open.loading && !open.data ? (
        <div style={{ opacity: 0.6, fontSize: 12 }}>Loading…</div>
      ) : items.length === 0 ? (
        <div style={{ opacity: 0.7, fontSize: 12 }}>No open work for this node.</div>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {items.slice(0, 8).map((it) => (
            <li
              key={it.id}
              style={{
                padding: "5px 0",
                borderBottom: "1px solid rgba(255,255,255,0.04)",
                fontSize: 12,
              }}
            >
              <code style={{ color: WAVEX_COLOR }}>
                {it.taskRefId.slice(0, 10)}
              </code>{" "}
              · {it.relation}{" "}
              <span style={{ opacity: 0.55, fontSize: 11 }}>
                {formatRelative(it.at, Date.now())} ago
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function EventContext({
  companyId,
  eventId,
}: {
  companyId: string;
  eventId: string;
}) {
  // For raw event selection, fetch the deliverables for the event's
  // task ref (event includes taskRefId if it's a task-shaped event).
  const dels = usePluginData<DeliverablesResponse>(
    "mission-control-deliverables",
    { companyId, limit: 10 },
  );
  void eventId; // not used directly — the deliverables list is the context
  const items = dels.data?.deliverables ?? [];
  return (
    <Panel label="Recent deliverables">
      {dels.loading && !dels.data ? (
        <div style={{ opacity: 0.6, fontSize: 12 }}>Loading…</div>
      ) : items.length === 0 ? (
        <div style={{ opacity: 0.7, fontSize: 12 }}>No deliverables yet.</div>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {items.slice(0, 8).map((d) => (
            <li
              key={d.id}
              style={{
                padding: "5px 0",
                borderBottom: "1px solid rgba(255,255,255,0.04)",
                fontSize: 12,
              }}
            >
              <span style={{ color: WAVEX_COLOR }}>{d.kind}</span> ·{" "}
              <span>{d.title.slice(0, 36)}</span>
              <div style={{ fontSize: 11, opacity: 0.55 }}>
                {d.status} · {formatRelative(d.producedAt, Date.now())} ago
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

// ─── OPS STATUS BAR ────────────────────────────────────────────────────

function OpsStatusBar({ companyId }: { companyId: string }) {
  const cost = usePluginData<CostResponse>("mission-control-cost", { companyId });
  const graph = usePluginData<AccountabilityGraphResponse>(
    "mission-control-graph",
    { companyId },
  );
  const totalCost = cost.data?.totals?.costUSD ?? 0;
  const nodes = graph.data?.graph?.nodes ?? [];
  const agentCount = nodes.filter(
    (n) => n.kind === "simulated_agent" || n.kind === "workspace_agent" || n.kind === "avatar",
  ).length;
  const inReview = nodes.reduce((a, n) => a + (n.openDeliverables ?? 0), 0);
  const bottlenecks = nodes.filter((n) => n.isBottleneck).length;
  const criticals = nodes.filter((n) => n.health === "critical").length;

  return (
    <div
      style={{
        marginTop: 10,
        padding: "6px 10px",
        borderRadius: 4,
        background: "rgba(0,0,0,0.18)",
        border: "1px solid rgba(255,255,255,0.05)",
        fontSize: 11,
        opacity: 0.8,
        display: "flex",
        gap: 14,
        flexWrap: "wrap",
        alignItems: "center",
      }}
    >
      <span>
        7d spend{" "}
        <strong style={{ color: WAVEX_COLOR }}>
          ${totalCost.toFixed(2)}
        </strong>
      </span>
      <span>{agentCount} agents</span>
      <span>{inReview} in-review</span>
      {bottlenecks > 0 ? (
        <span style={{ color: "#ff6b6b" }}>
          ⚠ {bottlenecks} bottleneck{bottlenecks === 1 ? "" : "s"}
        </span>
      ) : null}
      {criticals > 0 ? (
        <span style={{ color: "#ff4d4f" }}>
          ● {criticals} critical
        </span>
      ) : (
        bottlenecks === 0 && (
          <span style={{ color: "#4ec9b0" }}>✓ no blockers</span>
        )
      )}
    </div>
  );
}

// ─── Primitives ────────────────────────────────────────────────────────

function Card({
  label,
  children,
  rootRef,
}: {
  label: string;
  children: React.ReactNode;
  rootRef?: React.RefObject<HTMLElement | null>;
}) {
  return (
    <section
      ref={rootRef}
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

function Panel({
  label,
  children,
  live,
}: {
  label: string;
  children: React.ReactNode;
  live?: boolean;
}) {
  return (
    <section
      aria-label={label}
      style={{
        padding: "8px 10px",
        borderRadius: 4,
        background: "rgba(0,0,0,0.18)",
        border: "1px solid rgba(255,255,255,0.05)",
      }}
    >
      <div
        style={{
          fontSize: 10,
          letterSpacing: "0.05em",
          textTransform: "uppercase",
          opacity: 0.65,
          marginBottom: 6,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <span>{label}</span>
        {live != null ? (
          <span
            title={live ? "Live stream connected" : "Live stream offline"}
            style={{
              fontSize: 9,
              color: live ? "#4ec9b0" : "#8a8f98",
            }}
          >
            ● {live ? "LIVE" : "OFFLINE"}
          </span>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div
      style={{
        padding: "4px 6px",
        borderRadius: 3,
        background: "rgba(255,255,255,0.03)",
      }}
    >
      <div style={{ fontSize: 9, opacity: 0.6, textTransform: "uppercase" }}>
        {label}
      </div>
      <div style={{ fontSize: 13, fontWeight: 600 }}>{value}</div>
    </div>
  );
}

const selectStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.04)",
  color: "currentColor",
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: 3,
  padding: "3px 6px",
  fontSize: 11,
};
