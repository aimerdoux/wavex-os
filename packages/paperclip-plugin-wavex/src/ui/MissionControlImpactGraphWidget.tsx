/** Mission Control v2 — Causal Impact Graph (Phase 3).
 *
 *  Three tabs:
 *    - Top KPIs: ranked by total forecast delta; click row to see chain
 *    - Top Work: top-5 work items projected to move the headline KPI
 *    - Orphans: work without a declared KPI impact (red flag)
 *
 *  Click a KPI row → loads its impact graph (tasks → deliverables →
 *  owners → forecast vs realized). */

import { useMemo, useState } from "react";
import {
  usePluginData,
  type PluginWidgetProps,
} from "@wavex-os/plugin-sdk-shim/ui";

const WAVEX_COLOR = "#00d4ff";
const WAVEX_BG = "color-mix(in srgb, #00d4ff 6%, transparent)";

interface ImpactNode {
  taskRefId: string;
  taskRefType: string;
  impactId: string;
  forecastDelta: number;
  realizedDelta: number | null;
  accuracy: number | null;
  ownerNodeId: string | null;
  deliverableIds: string[];
  measureAt: string;
  measuredAt: string | null;
}

interface ImpactSummaryResponse {
  ok: boolean;
  topKpisByForecast: Array<{
    kpiId: string;
    totalImpacts: number;
    cumulativeForecast: number;
    cumulativeRealized: number;
  }>;
  topWorkForHeadline: ImpactNode[];
  orphanWork: Array<{
    taskRefId: string;
    taskRefType: string;
    ownerNodeId: string | null;
    ageHours: number;
  }>;
  ownerCalibration: Array<{
    ownerNodeId: string;
    impactsMeasured: number;
    avgAccuracy: number;
  }>;
  error?: string;
}

interface KpiGraphResponse {
  ok: boolean;
  kpiId?: string;
  totalImpacts?: number;
  measuredImpacts?: number;
  cumulativeForecast?: number;
  cumulativeRealized?: number;
  nodes?: ImpactNode[];
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

type Tab = "kpis" | "work" | "orphans" | "calibration";

export function MissionControlImpactGraphWidget({
  context,
}: PluginWidgetProps) {
  const companyId = context.companyId ?? "";
  const [tab, setTab] = useState<Tab>("kpis");
  const [drilldownKpi, setDrilldownKpi] = useState<string | null>(null);

  const summary = usePluginData<ImpactSummaryResponse>(
    "mission-control-impact-summary",
    { companyId },
  );
  const drilldown = usePluginData<KpiGraphResponse>(
    "mission-control-impact-graph",
    drilldownKpi ? { companyId, kpiId: drilldownKpi } : { companyId },
  );
  const tree = usePluginData<ScopeTreeResponse>(
    "mission-control-scope-tree",
    { companyId },
  );

  const nodeNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const n of tree.data?.tree?.nodes ?? []) m.set(n.id, n.name);
    return m;
  }, [tree.data]);

  if (!companyId) {
    return (
      <Card label="Mission Control — Causal Impact">
        <div style={{ opacity: 0.7 }}>Select a company.</div>
      </Card>
    );
  }

  return (
    <Card label="Mission Control — Causal Impact">
      <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
        <TabBtn label="Top KPIs" on={tab === "kpis"} onClick={() => setTab("kpis")} />
        <TabBtn label="Top Work" on={tab === "work"} onClick={() => setTab("work")} />
        <TabBtn
          label="Orphans"
          on={tab === "orphans"}
          onClick={() => setTab("orphans")}
          count={summary.data?.orphanWork.length}
        />
        <TabBtn
          label="Calibration"
          on={tab === "calibration"}
          onClick={() => setTab("calibration")}
        />
      </div>

      {summary.loading && !summary.data ? (
        <div style={{ opacity: 0.6, fontSize: 13 }}>Loading…</div>
      ) : summary.error ? (
        <div style={{ color: "#ff6b6b", fontSize: 13 }}>
          {summary.error.message}
        </div>
      ) : (
        <>
          {tab === "kpis" ? (
            <KpisTab
              summary={summary.data}
              drilldownKpi={drilldownKpi}
              setDrilldownKpi={setDrilldownKpi}
              drilldown={drilldown.data}
              nodeNameById={nodeNameById}
            />
          ) : tab === "work" ? (
            <WorkTab
              nodes={summary.data?.topWorkForHeadline ?? []}
              headlineKpi={summary.data?.topKpisByForecast[0]?.kpiId ?? null}
              nodeNameById={nodeNameById}
            />
          ) : tab === "orphans" ? (
            <OrphansTab
              orphans={summary.data?.orphanWork ?? []}
              nodeNameById={nodeNameById}
            />
          ) : (
            <CalibrationTab
              entries={summary.data?.ownerCalibration ?? []}
              nodeNameById={nodeNameById}
            />
          )}
        </>
      )}
    </Card>
  );
}

function KpisTab({
  summary,
  drilldownKpi,
  setDrilldownKpi,
  drilldown,
  nodeNameById,
}: {
  summary: ImpactSummaryResponse | null | undefined;
  drilldownKpi: string | null;
  setDrilldownKpi: (kpi: string | null) => void;
  drilldown: KpiGraphResponse | null | undefined;
  nodeNameById: Map<string, string>;
}) {
  const rows = summary?.topKpisByForecast ?? [];
  if (rows.length === 0) {
    return (
      <div style={{ opacity: 0.7, fontSize: 13 }}>
        No declared KPI impacts yet — every task originated should declare
        an `ExpectedKpiImpact`. Look in the Orphans tab.
      </div>
    );
  }
  return (
    <div style={{ display: "grid", gap: 6 }}>
      {rows.map((r) => {
        const open = drilldownKpi === r.kpiId;
        const sign = r.cumulativeForecast > 0 ? "+" : "";
        return (
          <div key={r.kpiId}>
            <button
              type="button"
              onClick={() => setDrilldownKpi(open ? null : r.kpiId)}
              style={{
                ...rowBtnStyle,
                background: open
                  ? "color-mix(in srgb, #00d4ff 12%, transparent)"
                  : "transparent",
              }}
            >
              <span style={{ flex: 1, fontWeight: 500 }}>{r.kpiId}</span>
              <span style={{ fontSize: 12, opacity: 0.7 }}>
                {r.totalImpacts} impact{r.totalImpacts === 1 ? "" : "s"}
              </span>
              <span
                style={{
                  fontSize: 13,
                  color: WAVEX_COLOR,
                  marginLeft: 8,
                  fontWeight: 600,
                }}
              >
                {sign}
                {formatNum(r.cumulativeForecast)}
              </span>
              <span style={{ fontSize: 11, opacity: 0.55, marginLeft: 6 }}>
                realized {formatNum(r.cumulativeRealized)}
              </span>
            </button>
            {open ? (
              <div style={drilldownStyle}>
                {drilldown?.nodes?.length === 0 ? (
                  <div style={{ opacity: 0.6 }}>No tasks in this chain.</div>
                ) : (
                  (drilldown?.nodes ?? []).map((n) => (
                    <div
                      key={n.impactId}
                      style={{ padding: "4px 0", fontSize: 12 }}
                    >
                      <span style={{ color: WAVEX_COLOR }}>
                        {n.taskRefId.slice(0, 12)}
                      </span>{" "}
                      → owner{" "}
                      <strong>
                        {n.ownerNodeId
                          ? nodeNameById.get(n.ownerNodeId) ?? n.ownerNodeId
                          : "(unassigned)"}
                      </strong>{" "}
                      · forecast {formatNum(n.forecastDelta)} · realized{" "}
                      {n.realizedDelta != null
                        ? formatNum(n.realizedDelta)
                        : "—"}{" "}
                      {n.accuracy != null ? (
                        <span style={{ opacity: 0.65 }}>
                          ({Math.round(n.accuracy * 100)}% accurate)
                        </span>
                      ) : null}
                      {n.deliverableIds.length > 0 ? (
                        <span style={{ opacity: 0.5 }}>
                          {" "}· {n.deliverableIds.length} deliverable
                          {n.deliverableIds.length === 1 ? "" : "s"}
                        </span>
                      ) : null}
                    </div>
                  ))
                )}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function WorkTab({
  nodes,
  headlineKpi,
  nodeNameById,
}: {
  nodes: ImpactNode[];
  headlineKpi: string | null;
  nodeNameById: Map<string, string>;
}) {
  if (!headlineKpi || nodes.length === 0) {
    return (
      <div style={{ opacity: 0.7, fontSize: 13 }}>
        No headline-KPI work to surface yet.
      </div>
    );
  }
  return (
    <div>
      <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 6 }}>
        Projected to move <strong>{headlineKpi}</strong>:
      </div>
      <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
        {nodes.map((n) => (
          <li
            key={n.impactId}
            style={{
              padding: "6px 0",
              borderBottom: "1px solid rgba(255,255,255,0.05)",
              fontSize: 13,
            }}
          >
            <strong style={{ color: WAVEX_COLOR }}>
              {formatNum(n.forecastDelta)}
            </strong>{" "}
            forecast — task <code>{n.taskRefId.slice(0, 10)}</code> owned by{" "}
            <strong>
              {n.ownerNodeId
                ? nodeNameById.get(n.ownerNodeId) ?? n.ownerNodeId
                : "(unassigned)"}
            </strong>
            {n.realizedDelta != null ? (
              <span style={{ opacity: 0.65 }}>
                {" "}— realized {formatNum(n.realizedDelta)}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function OrphansTab({
  orphans,
  nodeNameById,
}: {
  orphans: Array<{
    taskRefId: string;
    taskRefType: string;
    ownerNodeId: string | null;
    ageHours: number;
  }>;
  nodeNameById: Map<string, string>;
}) {
  if (orphans.length === 0) {
    return (
      <div style={{ opacity: 0.7, fontSize: 13 }}>
        🎉 Every active task declares a KPI impact. No orphan work.
      </div>
    );
  }
  return (
    <div>
      <div
        style={{
          fontSize: 12,
          color: "#ff6b6b",
          marginBottom: 6,
          fontWeight: 600,
        }}
      >
        ⚠ {orphans.length} task{orphans.length === 1 ? "" : "s"} with no
        declared KPI impact
      </div>
      <ul style={{ margin: 0, padding: 0, listStyle: "none", maxHeight: 280, overflowY: "auto" }}>
        {orphans.slice(0, 50).map((o) => (
          <li
            key={o.taskRefId}
            style={{
              padding: "5px 0",
              borderBottom: "1px solid rgba(255,255,255,0.05)",
              fontSize: 12,
            }}
          >
            <code style={{ color: WAVEX_COLOR }}>
              {o.taskRefId.slice(0, 12)}
            </code>{" "}
            · owner{" "}
            <strong>
              {o.ownerNodeId
                ? nodeNameById.get(o.ownerNodeId) ?? o.ownerNodeId
                : "(unassigned)"}
            </strong>{" "}
            <span style={{ opacity: 0.55 }}>· {o.ageHours}h old</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CalibrationTab({
  entries,
  nodeNameById,
}: {
  entries: Array<{
    ownerNodeId: string;
    impactsMeasured: number;
    avgAccuracy: number;
  }>;
  nodeNameById: Map<string, string>;
}) {
  if (entries.length === 0) {
    return (
      <div style={{ opacity: 0.7, fontSize: 13 }}>
        No measured impacts yet — calibration appears after some KPI
        measurements are recorded.
      </div>
    );
  }
  return (
    <div>
      <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 6 }}>
        Forecast accuracy per owner (1.0 = perfect):
      </div>
      <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
        {entries.map((e) => {
          const color = e.avgAccuracy >= 0.8 ? "#4ade80" : e.avgAccuracy >= 0.5 ? "#ffd166" : "#ff6b6b";
          return (
            <li
              key={e.ownerNodeId}
              style={{
                display: "flex",
                gap: 8,
                alignItems: "center",
                padding: "5px 0",
                borderBottom: "1px solid rgba(255,255,255,0.05)",
                fontSize: 13,
              }}
            >
              <span style={{ flex: 1 }}>
                {nodeNameById.get(e.ownerNodeId) ?? e.ownerNodeId}
              </span>
              <span style={{ opacity: 0.55, fontSize: 11 }}>
                {e.impactsMeasured} measured
              </span>
              <span style={{ color, fontWeight: 600 }}>
                {Math.round(e.avgAccuracy * 100)}%
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function TabBtn({
  label,
  on,
  onClick,
  count,
}: {
  label: string;
  on: boolean;
  onClick: () => void;
  count?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: "3px 10px",
        fontSize: 11,
        borderRadius: 4,
        textTransform: "uppercase",
        letterSpacing: "0.05em",
        cursor: "pointer",
        border: `1px solid ${on ? `color-mix(in srgb, ${WAVEX_COLOR} 50%, transparent)` : "rgba(255,255,255,0.12)"}`,
        background: on
          ? `color-mix(in srgb, ${WAVEX_COLOR} 18%, transparent)`
          : "transparent",
        color: on ? WAVEX_COLOR : "#8a8f98",
        fontWeight: 600,
      }}
    >
      {label}
      {count != null && count > 0 ? (
        <span
          style={{ marginLeft: 6, opacity: 0.7, fontWeight: 400 }}
        >
          ({count})
        </span>
      ) : null}
    </button>
  );
}

function formatNum(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
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

const rowBtnStyle: React.CSSProperties = {
  width: "100%",
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "8px 10px",
  borderRadius: 4,
  border: "1px solid rgba(255,255,255,0.08)",
  color: "inherit",
  cursor: "pointer",
  fontSize: 13,
  textAlign: "left",
};

const drilldownStyle: React.CSSProperties = {
  marginTop: 4,
  padding: "8px 10px",
  borderRadius: 4,
  background: "rgba(0,0,0,0.2)",
  fontSize: 13,
};
