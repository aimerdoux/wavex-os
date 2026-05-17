/** Mission Control — KPI Scoreboard (Phase 3.3).
 *
 *  Per-KPI attainment view backed by the wavex-side ExpectedKpiImpact
 *  ledger. Each KPI shows cumulative estimated vs cumulative actual,
 *  the attainment ratio as a progress gauge, count of measured/total
 *  impacts, and a "due now" badge when there are unmeasured impacts
 *  whose `measure_at` has passed.
 *
 *  Mode-aware: in Solo Founder + Hybrid the owner list shows department
 *  / agent node names from the ScopeTree; in Avatar the owner is the
 *  avatar itself (since the avatar is the simulation boundary). The
 *  widget resolves names via the scope-tree worker handler shared with
 *  the Stream widget. */

import { useEffect, useMemo, useState } from "react";
import {
  usePluginAction,
  usePluginData,
  type PluginWidgetProps,
} from "@paperclipai/plugin-sdk/ui";

const WAVEX_COLOR = "#00d4ff";
const WAVEX_BG = "color-mix(in srgb, #00d4ff 6%, transparent)";

interface ScoreboardEntry {
  kpiId: string;
  totalImpacts: number;
  measuredImpacts: number;
  dueNow: number;
  cumulativeEstimated: number;
  cumulativeActual: number;
  attainmentRatio: number;
  ownerNodeIds: string[];
}

interface DueImpact {
  id: string;
  kpiId: string;
  taskId: string;
  scopeNodeId: string;
  estimatedDelta: number;
  unit: string;
  measureAt: string;
  rationale: string;
}

interface ScoreboardResponse {
  ok: boolean;
  scoreboard: ScoreboardEntry[];
  due: DueImpact[];
  source?: string;
  error?: string;
}

interface ScopeNode {
  id: string;
  name: string;
}

interface ScopeTreeResponse {
  ok: boolean;
  tree?: { nodes?: ScopeNode[] };
}

function formatNum(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

export function MissionControlScoreboardWidget({
  context,
}: PluginWidgetProps) {
  const companyId = context.companyId ?? "";
  const board = usePluginData<ScoreboardResponse>(
    "mission-control-scoreboard",
    { companyId },
  );
  const tree = usePluginData<ScopeTreeResponse>(
    "mission-control-scope-tree",
    { companyId },
  );
  const announceDue = usePluginAction("mission-control-announce-due");
  const [announceStatus, setAnnounceStatus] = useState<string | null>(null);

  const nodeNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const n of tree.data?.tree?.nodes ?? []) map.set(n.id, n.name);
    return map;
  }, [tree.data]);

  useEffect(() => {
    setAnnounceStatus(null);
  }, [companyId]);

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
  const dueAll = board.data?.due ?? [];

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
          {entries.length} {entries.length === 1 ? "KPI" : "KPIs"} tracked ·{" "}
          {dueAll.length} measurement{dueAll.length === 1 ? "" : "s"} due
        </span>
        <button type="button" onClick={board.refresh} style={linkStyle}>
          refresh
        </button>
      </div>
      {entries.length === 0 ? (
        <div style={{ opacity: 0.7, padding: "8px 0", fontSize: 13 }}>
          No KPI impacts declared yet. Tasks declare an expected impact
          when they emit a `task_originated` event.
        </div>
      ) : (
        <div style={{ display: "grid", gap: 14 }}>
          {entries.map((e) => (
            <KpiRow
              key={e.kpiId}
              entry={e}
              nodeNameById={nodeNameById}
            />
          ))}
        </div>
      )}
      {dueAll.length > 0 ? (
        <div
          style={{
            marginTop: 12,
            paddingTop: 10,
            borderTop: "1px solid rgba(255,255,255,0.08)",
            fontSize: 12,
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: 8,
          }}
        >
          <span style={{ opacity: 0.7 }}>
            {dueAll.length} impact{dueAll.length === 1 ? "" : "s"} are due
            for measurement
          </span>
          <button
            type="button"
            onClick={() => {
              void announceDue({ companyId }).then((res) => {
                const r = res as { announced?: number };
                setAnnounceStatus(
                  `${r.announced ?? 0} announcement${(r.announced ?? 0) === 1 ? "" : "s"} fired`,
                );
              });
            }}
            style={{
              ...linkStyle,
              padding: "3px 8px",
              border: `1px solid color-mix(in srgb, ${WAVEX_COLOR} 40%, transparent)`,
              borderRadius: 4,
              fontWeight: 600,
            }}
          >
            announce due
          </button>
        </div>
      ) : null}
      {announceStatus ? (
        <div
          style={{ marginTop: 6, fontSize: 11, color: WAVEX_COLOR, opacity: 0.85 }}
        >
          {announceStatus}
        </div>
      ) : null}
    </Card>
  );
}

function KpiRow({
  entry,
  nodeNameById,
}: {
  entry: ScoreboardEntry;
  nodeNameById: Map<string, string>;
}) {
  const pct = Math.max(0, Math.min(100, entry.attainmentRatio * 100));
  const onTarget = entry.attainmentRatio >= 0.95;
  const fill = onTarget
    ? "#4ade80"
    : entry.attainmentRatio >= 0.5
      ? WAVEX_COLOR
      : "#ffd166";
  const owners = entry.ownerNodeIds
    .map((id) => nodeNameById.get(id) ?? id)
    .slice(0, 3);
  return (
    <div style={{ fontSize: 13 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          marginBottom: 4,
        }}
      >
        <div>
          <strong>{entry.kpiId}</strong>
          {owners.length > 0 ? (
            <span style={{ opacity: 0.55, marginLeft: 6, fontSize: 11 }}>
              {owners.join(", ")}
              {entry.ownerNodeIds.length > owners.length
                ? ` +${entry.ownerNodeIds.length - owners.length}`
                : ""}
            </span>
          ) : null}
        </div>
        <span style={{ opacity: 0.7 }}>
          {formatNum(entry.cumulativeActual)}{" "}
          <span style={{ opacity: 0.5 }}>
            / {formatNum(entry.cumulativeEstimated)}
          </span>
        </span>
      </div>
      <div
        style={{
          height: 8,
          borderRadius: 4,
          background: "rgba(255,255,255,0.06)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: "100%",
            borderRadius: 4,
            background: fill,
            transition: "width 200ms ease",
          }}
        />
      </div>
      <div
        style={{
          fontSize: 11,
          opacity: 0.55,
          marginTop: 3,
          display: "flex",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <span>
          {entry.measuredImpacts}/{entry.totalImpacts} measured
        </span>
        {entry.dueNow > 0 ? (
          <span style={{ color: "#ffd166" }}>
            ⚠ {entry.dueNow} due now
          </span>
        ) : null}
        <span>{Math.round(pct)}% of target</span>
        {onTarget ? <span style={{ color: "#4ade80" }}>— on target</span> : null}
      </div>
    </div>
  );
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
