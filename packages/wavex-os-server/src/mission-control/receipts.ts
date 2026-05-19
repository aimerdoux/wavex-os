/** Mission Control — KPI Receipts (Frontier F3).
 *
 *  For a given KPI, return the *causal chain* that explains its current
 *  number: which tasks moved it, which agents owned those tasks, which
 *  deliverables were produced, and how much was spent doing it.
 *
 *  This is the trust-builder. Without it, the operator sees a number;
 *  with it, they see the work that produced the number — and can
 *  confidently delegate more autonomy to agents that have a track
 *  record.
 *
 *  Composes already-built services:
 *    - getScoreboardWithHistory  → current / target / delta / status
 *    - buildImpactGraph          → per-task forecast vs realized
 *    - queryDeliverables         → deliverable titles by taskRefId
 *    - getCostPerKpi             → total spend + $/point
 *    - getScopeTreeCached        → resolve nodeId → human name
 */

import { type Db, getDb } from "@wavex-os/db";
import { getScoreboardWithHistory } from "./kpi-impacts.js";
import { buildImpactGraph } from "./impact-graph.js";
import { queryDeliverables } from "./deliverables.js";
import { getCostPerKpi } from "./cost-attribution.js";
import { getScopeTreeCached } from "./scope-tree-cache.js";

export interface ReceiptDeliverable {
  id: string;
  title: string;
  kind: string;
  status: string;
}

export interface ReceiptContributor {
  taskRefId: string;
  taskRefType: string;
  ownerNodeId: string | null;
  ownerName: string | null;
  forecastDelta: number;
  realizedDelta: number | null;
  accuracy: number | null;
  /** "Confirmed" if measured, "Forecast" if not. */
  state: "confirmed" | "forecast";
  measureAt: string;
  measuredAt: string | null;
  deliverables: ReceiptDeliverable[];
}

export interface ReceiptsResult {
  kpiId: string;
  /** Headline number, or null if no scoreboard row yet. */
  current: number | null;
  target: number | null;
  delta: number | null;
  status: string | null;
  freshnessWarning: boolean;
  /** Aggregated impact metrics. */
  totalImpacts: number;
  measuredImpacts: number;
  cumulativeForecast: number;
  cumulativeRealized: number;
  /** Aggregate confidence label derived from contributor count + measurement state. */
  confidence: "high" | "medium" | "low" | "unknown";
  /** Total $ spent on tasks that declared an impact for this KPI (lifetime). */
  totalSpendUSD: number;
  /** $ per point of KPI movement; null when cumulativeRealized is 0. */
  dollarsPerPoint: number | null;
  /** Ranked contributing tasks (largest forecast first). */
  contributors: ReceiptContributor[];
  generatedAt: string;
}

function deriveConfidence(
  measured: number,
  total: number,
  cumulativeRealized: number,
  cumulativeForecast: number,
): ReceiptsResult["confidence"] {
  if (total === 0) return "unknown";
  if (measured === 0) return "low";
  const ratioMeasured = measured / total;
  if (cumulativeForecast === 0) return ratioMeasured > 0.5 ? "medium" : "low";
  const realizedToForecast = Math.abs(cumulativeRealized) / Math.abs(cumulativeForecast);
  // High = mostly measured AND realized close to forecast
  if (ratioMeasured >= 0.7 && realizedToForecast >= 0.7) return "high";
  if (ratioMeasured >= 0.4) return "medium";
  return "low";
}

export async function buildKpiReceipts(
  companyId: string,
  kpiId: string,
  db?: Db,
): Promise<ReceiptsResult> {
  const resolved = db ?? (await getDb());

  // ── KPI header (scoreboard row) ────────────────────────────────────
  const scoreboard = await getScoreboardWithHistory(companyId, {}, resolved).catch(
    () => [] as Awaited<ReturnType<typeof getScoreboardWithHistory>>,
  );
  const row = scoreboard.find((r) => r.kpiId === kpiId);

  // ── Causal chain (impacts → tasks → deliverables) ──────────────────
  const graph = await buildImpactGraph(companyId, kpiId, resolved).catch(
    () => null,
  );

  // ── Cost attribution for this KPI ──────────────────────────────────
  // getCostPerKpi requires a since; ask for "lifetime-ish" — 365d window.
  const costRows = await getCostPerKpi(
    companyId,
    { since: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000) },
    resolved,
  ).catch(() => []);
  const costRow = costRows.find((c) => c.kpiId === kpiId);

  // ── Resolve node-id → human name for owner attribution ─────────────
  const tree = await getScopeTreeCached(companyId).catch(() => null);
  const nameById = new Map<string, string>();
  if (tree?.nodes) {
    for (const n of tree.nodes) nameById.set(n.id, n.name);
  }

  // ── Pull deliverable titles (one query, then index by taskRefId) ───
  // Could be more efficient with a single WHERE IN, but our list is small.
  const allDeliverables = await queryDeliverables(
    { companyId, limit: 500 },
    resolved,
  ).catch(() => []);
  const delivByTask = new Map<string, ReceiptDeliverable[]>();
  for (const d of allDeliverables) {
    const list = delivByTask.get(d.taskRef.id) ?? [];
    list.push({ id: d.id, title: d.title, kind: d.kind, status: d.status });
    delivByTask.set(d.taskRef.id, list);
  }

  const contributors: ReceiptContributor[] = (graph?.nodes ?? []).map((n) => ({
    taskRefId: n.taskRefId,
    taskRefType: n.taskRefType,
    ownerNodeId: n.ownerNodeId,
    ownerName: n.ownerNodeId ? (nameById.get(n.ownerNodeId) ?? null) : null,
    forecastDelta: n.forecastDelta,
    realizedDelta: n.realizedDelta,
    accuracy: n.accuracy,
    state: n.realizedDelta != null ? "confirmed" : "forecast",
    measureAt: n.measureAt,
    measuredAt: n.measuredAt,
    deliverables: delivByTask.get(n.taskRefId) ?? [],
  }));

  return {
    kpiId,
    current: row?.current ?? null,
    target: row?.target ?? null,
    delta: row?.delta ?? null,
    status: row?.status ?? null,
    freshnessWarning: Boolean(row?.freshnessWarning),
    totalImpacts: graph?.totalImpacts ?? 0,
    measuredImpacts: graph?.measuredImpacts ?? 0,
    cumulativeForecast: graph?.cumulativeForecast ?? 0,
    cumulativeRealized: graph?.cumulativeRealized ?? 0,
    confidence: deriveConfidence(
      graph?.measuredImpacts ?? 0,
      graph?.totalImpacts ?? 0,
      graph?.cumulativeRealized ?? 0,
      graph?.cumulativeForecast ?? 0,
    ),
    totalSpendUSD: costRow?.totalCostUSD ?? 0,
    dollarsPerPoint: costRow?.dollarsPerPoint ?? null,
    contributors,
    generatedAt: new Date().toISOString(),
  };
}
