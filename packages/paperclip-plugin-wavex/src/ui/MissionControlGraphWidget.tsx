/** Mission Control — accountability graph (Phase 5).
 *
 *  Dependency-free SVG renderer with a tiny inline force simulation.
 *  Mode-aware shapes:
 *    - human_member / user           → circle
 *    - chief_of_staff                → diamond
 *    - department / org / workspace  → rounded rect
 *    - simulated_agent / workspace_agent / avatar → square
 *
 *  Edges:
 *    - Solid grey for structural (parent → child)
 *    - Cyan thickness-scaled for work-flow (weight from assignment chain)
 *
 *  Time scrubber lets the operator dial the window (1h / 24h / 7d / 30d).
 *  KPI lens stub renders (kpiId filter wired but the server-side join
 *  lands in Phase 6 with the KPI mirror table). */

import { useMemo, useState } from "react";
import {
  usePluginData,
  type PluginWidgetProps,
} from "@paperclipai/plugin-sdk/ui";

const WAVEX_COLOR = "#00d4ff";
const WAVEX_BG = "color-mix(in srgb, #00d4ff 6%, transparent)";

interface GraphNode {
  id: string;
  name: string;
  kind: string;
  parentId?: string;
  activityCount: number;
  health?: "healthy" | "at-risk" | "critical";
  isBottleneck?: boolean;
  openDeliverables?: number;
  openAssignments?: number;
}
interface GraphEdge {
  fromNodeId: string;
  toNodeId: string;
  weight: number;
  lastAt: string;
}
interface AccountabilityGraph {
  mode: string;
  instanceId: string;
  nodes: GraphNode[];
  workEdges: GraphEdge[];
  structuralEdges: Array<{ fromNodeId: string; toNodeId: string }>;
  window: { since: string; until: string };
  totalWorkEvents: number;
}
interface GraphResponse {
  ok: boolean;
  graph?: AccountabilityGraph;
  error?: string;
  source?: string;
}

type WindowChoice = "1h" | "24h" | "7d" | "30d";
const WINDOW_MS: Record<WindowChoice, number> = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
};

interface ScopeTreeNode {
  id: string;
  name: string;
}
interface ScopeTreeResponse {
  ok: boolean;
  tree?: { kpis?: Array<{ id: string; name: string }> };
}

export function MissionControlGraphWidget({ context }: PluginWidgetProps) {
  const companyId = context.companyId ?? "";
  const [windowChoice, setWindowChoice] = useState<WindowChoice>("7d");
  const [layoutMode, setLayoutMode] = useState<"auto" | "tree">("auto");
  const [heatmap, setHeatmap] = useState(false);
  const [kpiLens, setKpiLens] = useState<string>("");
  // Time scrubber: how many days back the window ends. 0 = "now",
  // 30 = "30 days ago". Lets the user replay past graph state.
  const [endOffsetDays, setEndOffsetDays] = useState(0);

  const { since, until } = useMemo(() => {
    const endMs = Date.now() - endOffsetDays * 24 * 60 * 60 * 1000;
    const startMs = endMs - WINDOW_MS[windowChoice];
    return {
      since: new Date(startMs).toISOString(),
      until: new Date(endMs).toISOString(),
    };
  }, [windowChoice, endOffsetDays]);

  // KPI dropdown options come from scope-tree (same source the rest of
  // Mission Control uses — keeps labels consistent).
  const treeData = usePluginData<ScopeTreeResponse>(
    "mission-control-scope-tree",
    { companyId },
  );
  const kpiOptions = treeData.data?.tree?.kpis ?? [];

  const { data, loading, error, refresh } = usePluginData<GraphResponse>(
    "mission-control-graph",
    { companyId, since, until, kpiId: kpiLens || undefined },
  );

  if (!companyId) {
    return (
      <Card label="Mission Control — Accountability Graph">
        <div style={{ opacity: 0.7 }}>Select a company.</div>
      </Card>
    );
  }
  if (loading && !data) {
    return (
      <Card label="Mission Control — Accountability Graph">
        <div style={{ opacity: 0.6 }}>Loading graph…</div>
      </Card>
    );
  }
  if (error) {
    return (
      <Card label="Mission Control — Accountability Graph">
        <div style={{ color: "#ff6b6b" }}>
          Couldn't load: {error.message}{" "}
          <button type="button" onClick={refresh} style={linkStyle}>
            retry
          </button>
        </div>
      </Card>
    );
  }
  const graph = data?.graph;
  return (
    <Card label="Mission Control — Accountability Graph">
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          marginBottom: 8,
        }}
      >
        <select
          value={windowChoice}
          onChange={(e) => setWindowChoice(e.target.value as WindowChoice)}
          style={selectStyle}
        >
          {(Object.keys(WINDOW_MS) as WindowChoice[]).map((w) => (
            <option key={w} value={w}>
              Last {w}
            </option>
          ))}
        </select>
        <select
          value={layoutMode}
          onChange={(e) => setLayoutMode(e.target.value as "auto" | "tree")}
          style={selectStyle}
          title="Layout mode"
        >
          <option value="auto">Auto layout</option>
          <option value="tree">Tree</option>
        </select>
        {kpiOptions.length > 0 ? (
          <select
            value={kpiLens}
            onChange={(e) => setKpiLens(e.target.value)}
            style={selectStyle}
            title="Filter by KPI"
          >
            <option value="">All KPIs</option>
            {kpiOptions.map((k) => (
              <option key={k.id} value={k.id}>
                {k.name}
              </option>
            ))}
          </select>
        ) : null}
        <label
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            fontSize: 12,
            opacity: 0.85,
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={heatmap}
            onChange={(e) => setHeatmap(e.target.checked)}
          />
          Heatmap
        </label>
        <span style={{ fontSize: 12, opacity: 0.65 }}>
          {graph?.nodes.length ?? 0} nodes ·{" "}
          {graph?.totalWorkEvents ?? 0} work events ·{" "}
          {graph?.mode ?? "?"} mode
        </span>
        <button
          type="button"
          onClick={refresh}
          style={{ ...linkStyle, marginLeft: "auto" }}
        >
          refresh
        </button>
      </div>

      {/* Time scrubber — drag to replay graph state in the past */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          marginBottom: 8,
          fontSize: 11,
          color: "rgba(255,255,255,0.6)",
        }}
      >
        <span style={{ minWidth: 70 }}>
          {endOffsetDays === 0 ? "Now" : `−${endOffsetDays}d`}
        </span>
        <input
          type="range"
          min={0}
          max={30}
          step={1}
          value={endOffsetDays}
          onChange={(e) => setEndOffsetDays(Number(e.target.value))}
          aria-label="Time scrubber"
          style={{ flex: 1, accentColor: WAVEX_COLOR }}
        />
        <span style={{ minWidth: 70, textAlign: "right" }}>
          {new Date(until).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
        </span>
        {endOffsetDays > 0 ? (
          <button
            type="button"
            onClick={() => setEndOffsetDays(0)}
            style={{ ...linkStyle, fontSize: 11 }}
          >
            reset
          </button>
        ) : null}
      </div>

      {!graph || graph.nodes.length === 0 ? (
        <div style={{ opacity: 0.7, padding: "8px 0", fontSize: 13 }}>
          {kpiLens
            ? "No work edges for this KPI lens in the window."
            : "No nodes in the scope tree yet."}
        </div>
      ) : (
        <GraphSvg graph={graph} heatmap={heatmap} layoutMode={layoutMode} />
      )}
      <HealthLegend />
      {graph && graph.nodes.some((n) => n.isBottleneck) ? (
        <div
          style={{
            marginTop: 6,
            fontSize: 11,
            color: "#ff6b6b",
            opacity: 0.8,
          }}
        >
          ⚠ {graph.nodes.filter((n) => n.isBottleneck).length} bottleneck
          {graph.nodes.filter((n) => n.isBottleneck).length === 1 ? "" : "s"}{" "}
          detected (≥3 in-review deliverables)
        </div>
      ) : null}
    </Card>
  );
}

function GraphSvg({
  graph,
  heatmap,
  layoutMode,
}: {
  graph: AccountabilityGraph;
  heatmap: boolean;
  layoutMode: "auto" | "tree";
}) {
  const layout = useForceLayout(graph, layoutMode);
  const maxActivity = Math.max(1, ...graph.nodes.map((n) => n.activityCount));
  const maxWeight = Math.max(1, ...graph.workEdges.map((e) => e.weight));
  return (
    <svg
      width="100%"
      height={360}
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      role="img"
      aria-label="Accountability graph"
      style={{
        background: "rgba(0,0,0,0.15)",
        borderRadius: 6,
        border: "1px solid rgba(255,255,255,0.06)",
      }}
    >
      {/* Structural edges first so work edges paint on top */}
      {graph.structuralEdges.map((e, i) => {
        const from = layout.positions.get(e.fromNodeId);
        const to = layout.positions.get(e.toNodeId);
        if (!from || !to) return null;
        return (
          <line
            key={`s-${i}`}
            x1={from.x}
            y1={from.y}
            x2={to.x}
            y2={to.y}
            stroke="rgba(255,255,255,0.12)"
            strokeWidth={1}
            strokeDasharray="4 4"
          />
        );
      })}
      {graph.workEdges.map((e, i) => {
        const from = layout.positions.get(e.fromNodeId);
        const to = layout.positions.get(e.toNodeId);
        if (!from || !to) return null;
        const widthPx = 1 + Math.round((e.weight / maxWeight) * 4);
        return (
          <line
            key={`w-${i}`}
            x1={from.x}
            y1={from.y}
            x2={to.x}
            y2={to.y}
            stroke={`color-mix(in srgb, ${WAVEX_COLOR} ${30 + Math.round((e.weight / maxWeight) * 50)}%, transparent)`}
            strokeWidth={widthPx}
          />
        );
      })}
      {graph.nodes.map((n) => {
        const pos = layout.positions.get(n.id);
        if (!pos) return null;
        const baseSize =
          14 + Math.round((n.activityCount / maxActivity) * 14);
        return (
          <NodeShape
            key={n.id}
            node={n}
            x={pos.x}
            y={pos.y}
            size={baseSize}
            heatmap={heatmap}
            heatIntensity={n.activityCount / maxActivity}
          />
        );
      })}
    </svg>
  );
}

function NodeShape({
  node,
  x,
  y,
  size,
  heatmap,
  heatIntensity,
}: {
  node: GraphNode;
  x: number;
  y: number;
  size: number;
  heatmap: boolean;
  heatIntensity: number;
}) {
  const kindFill =
    node.kind === "chief_of_staff"
      ? "#ffd166"
      : node.kind === "human_member" || node.kind === "user"
        ? "#4ade80"
        : node.kind === "department" || node.kind === "org" || node.kind === "workspace"
          ? "#8a8f98"
          : WAVEX_COLOR;
  // Heatmap fills use a temperature ramp instead of node-kind color so
  // load imbalance jumps out visually. Cool = lavender, hot = magenta.
  const heatFill = `hsl(${280 - Math.round(heatIntensity * 280)}, 80%, 55%)`;
  const fill = heatmap ? heatFill : kindFill;

  const healthStroke =
    node.health === "critical"
      ? "#ff4d4f"
      : node.health === "at-risk"
        ? "#ffaa00"
        : node.health === "healthy"
          ? "#4ade80"
          : "rgba(255,255,255,0.15)";
  const strokeWidth = node.health && node.health !== "healthy" ? 2 : 1;

  const labelOffsetY = size + 12;
  const isCircle = node.kind === "human_member" || node.kind === "user";
  const isDiamond = node.kind === "chief_of_staff";
  const isRoundRect =
    node.kind === "department" || node.kind === "org" || node.kind === "workspace";

  const shape = isCircle ? (
    <circle
      r={size / 2}
      fill={fill}
      opacity={0.85}
      stroke={healthStroke}
      strokeWidth={strokeWidth}
    />
  ) : isDiamond ? (
    <polygon
      points={`0,${-size / 2} ${size / 2},0 0,${size / 2} ${-size / 2},0`}
      fill={fill}
      opacity={0.85}
      stroke={healthStroke}
      strokeWidth={strokeWidth}
    />
  ) : isRoundRect ? (
    <rect
      x={-size / 2}
      y={-size / 2}
      width={size}
      height={size}
      rx={4}
      ry={4}
      fill={fill}
      opacity={0.85}
      stroke={healthStroke}
      strokeWidth={strokeWidth}
    />
  ) : (
    <rect
      x={-size / 2}
      y={-size / 2}
      width={size}
      height={size}
      fill={fill}
      opacity={0.85}
      stroke={healthStroke}
      strokeWidth={strokeWidth}
    />
  );

  const tooltip =
    node.openDeliverables != null
      ? `${node.name}\nopen deliverables: ${node.openDeliverables}\nopen assignments: ${node.openAssignments ?? 0}\nhealth: ${node.health ?? "?"}`
      : node.name;

  return (
    <g transform={`translate(${x},${y})`}>
      <title>{tooltip}</title>
      {node.isBottleneck ? (
        <circle
          r={size / 2 + 6}
          fill="none"
          stroke="#ff4d4f"
          strokeWidth={1.5}
          opacity={0.55}
        >
          <animate
            attributeName="r"
            values={`${size / 2 + 4};${size / 2 + 9};${size / 2 + 4}`}
            dur="2s"
            repeatCount="indefinite"
          />
          <animate
            attributeName="opacity"
            values="0.6;0.15;0.6"
            dur="2s"
            repeatCount="indefinite"
          />
        </circle>
      ) : null}
      {shape}
      <text
        x={0}
        y={labelOffsetY}
        textAnchor="middle"
        fontSize="10"
        fill="rgba(255,255,255,0.75)"
      >
        {node.name.length > 18 ? `${node.name.slice(0, 17)}…` : node.name}
      </text>
    </g>
  );
}

function HealthLegend() {
  return (
    <div
      style={{
        display: "flex",
        gap: 10,
        marginTop: 6,
        fontSize: 10,
        opacity: 0.65,
        flexWrap: "wrap",
      }}
    >
      <LegendSwatch color="#4ade80" label="healthy" />
      <LegendSwatch color="#ffaa00" label="at-risk" />
      <LegendSwatch color="#ff4d4f" label="critical" />
      <LegendSwatch color="#ff4d4f" label="● bottleneck" outlined />
    </div>
  );
}
function LegendSwatch({
  color,
  label,
  outlined,
}: {
  color: string;
  label: string;
  outlined?: boolean;
}) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      <span
        style={{
          width: 10,
          height: 10,
          borderRadius: 2,
          background: outlined ? "transparent" : color,
          border: `1px solid ${color}`,
          display: "inline-block",
        }}
      />
      {label}
    </span>
  );
}

interface LayoutResult {
  positions: Map<string, { x: number; y: number }>;
  width: number;
  height: number;
}

// Tiny deterministic force-layout. Bin nodes by depth (BFS over scope
// tree parentIds) → place each depth on a horizontal band, spread by
// index. Not a full physics sim but predictable + good enough for the
// 35-agent demo + handles up to ~100 nodes legibly.
function useForceLayout(
  graph: AccountabilityGraph,
  layoutMode: "auto" | "tree",
): LayoutResult {
  return useMemo(() => {
    const width = 720;
    // Tree mode renders taller to make depth bands more legible.
    const useTree = layoutMode === "tree" || graph.nodes.length >= 30;
    const height = useTree ? 460 : 320;
    const padding = 30;
    void useTree;
    const childrenByParent = new Map<string, string[]>();
    for (const n of graph.nodes) {
      if (n.parentId) {
        const list = childrenByParent.get(n.parentId) ?? [];
        list.push(n.id);
        childrenByParent.set(n.parentId, list);
      }
    }
    const depth = new Map<string, number>();
    const queue: Array<{ id: string; d: number }> = [];
    for (const n of graph.nodes) {
      if (!n.parentId) {
        depth.set(n.id, 0);
        queue.push({ id: n.id, d: 0 });
      }
    }
    while (queue.length > 0) {
      const item = queue.shift()!;
      const kids = childrenByParent.get(item.id) ?? [];
      for (const k of kids) {
        if (!depth.has(k)) {
          depth.set(k, item.d + 1);
          queue.push({ id: k, d: item.d + 1 });
        }
      }
    }
    // Disconnected nodes default to depth 0.
    for (const n of graph.nodes) if (!depth.has(n.id)) depth.set(n.id, 0);

    const byDepth = new Map<number, string[]>();
    for (const n of graph.nodes) {
      const d = depth.get(n.id) ?? 0;
      const list = byDepth.get(d) ?? [];
      list.push(n.id);
      byDepth.set(d, list);
    }
    const maxDepth = Math.max(0, ...byDepth.keys());
    const positions = new Map<string, { x: number; y: number }>();
    const ySpan = (height - padding * 2) / Math.max(1, maxDepth);
    for (const [d, ids] of byDepth.entries()) {
      const xSpan = (width - padding * 2) / Math.max(1, ids.length);
      ids.forEach((id, i) => {
        positions.set(id, {
          x: padding + xSpan * (i + 0.5),
          y: padding + ySpan * d,
        });
      });
    }
    return { positions, width, height };
  }, [graph, layoutMode]);
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

const selectStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.04)",
  color: "currentColor",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 4,
  padding: "4px 8px",
  fontSize: 12,
};
const linkStyle: React.CSSProperties = {
  background: "none",
  color: WAVEX_COLOR,
  border: "none",
  cursor: "pointer",
  fontSize: 12,
  padding: 0,
};
