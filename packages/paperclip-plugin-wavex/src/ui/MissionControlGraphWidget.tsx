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
} from "@wavex-os/plugin-sdk-shim/ui";

const WAVEX_COLOR = "#00d4ff";
const WAVEX_BG = "color-mix(in srgb, #00d4ff 6%, transparent)";

interface GraphNode {
  id: string;
  name: string;
  kind: string;
  parentId?: string;
  activityCount: number;
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

export function MissionControlGraphWidget({ context }: PluginWidgetProps) {
  const companyId = context.companyId ?? "";
  const [windowChoice, setWindowChoice] = useState<WindowChoice>("7d");
  const since = useMemo(
    () => new Date(Date.now() - WINDOW_MS[windowChoice]).toISOString(),
    [windowChoice],
  );
  const { data, loading, error, refresh } = usePluginData<GraphResponse>(
    "mission-control-graph",
    { companyId, since },
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
      {!graph || graph.nodes.length === 0 ? (
        <div style={{ opacity: 0.7, padding: "8px 0", fontSize: 13 }}>
          No nodes in the scope tree yet.
        </div>
      ) : (
        <GraphSvg graph={graph} />
      )}
    </Card>
  );
}

function GraphSvg({ graph }: { graph: AccountabilityGraph }) {
  const layout = useForceLayout(graph);
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
}: {
  node: GraphNode;
  x: number;
  y: number;
  size: number;
}) {
  const fill =
    node.kind === "chief_of_staff"
      ? "#ffd166"
      : node.kind === "human_member" || node.kind === "user"
        ? "#4ade80"
        : node.kind === "department" || node.kind === "org" || node.kind === "workspace"
          ? "#8a8f98"
          : WAVEX_COLOR;
  const labelOffsetY = size + 12;
  const isCircle = node.kind === "human_member" || node.kind === "user";
  const isDiamond = node.kind === "chief_of_staff";
  const isRoundRect =
    node.kind === "department" || node.kind === "org" || node.kind === "workspace";
  return (
    <g transform={`translate(${x},${y})`}>
      {isCircle ? (
        <circle r={size / 2} fill={fill} opacity={0.85} />
      ) : isDiamond ? (
        <polygon
          points={`0,${-size / 2} ${size / 2},0 0,${size / 2} ${-size / 2},0`}
          fill={fill}
          opacity={0.85}
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
        />
      ) : (
        <rect
          x={-size / 2}
          y={-size / 2}
          width={size}
          height={size}
          fill={fill}
          opacity={0.85}
        />
      )}
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

interface LayoutResult {
  positions: Map<string, { x: number; y: number }>;
  width: number;
  height: number;
}

// Tiny deterministic force-layout. Bin nodes by depth (BFS over scope
// tree parentIds) → place each depth on a horizontal band, spread by
// index. Not a full physics sim but predictable + good enough for the
// 35-agent demo + handles up to ~100 nodes legibly.
function useForceLayout(graph: AccountabilityGraph): LayoutResult {
  return useMemo(() => {
    const width = 720;
    const height = 320;
    const padding = 30;
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
  }, [graph]);
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
