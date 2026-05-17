/** Mission Control — ExpectedKpiImpact write/query/measurement.
 *
 *  Phase 3 (Task → KPI). The spec invariant is "every task either declares
 *  an expected KPI impact or carries `kpiImpactJustifiedAsNone`." This
 *  module implements the declaration side + the measurement scheduler
 *  that fills in `actualDelta` + variance after the time horizon elapses.
 *
 *  Measurement strategies:
 *    - manual_input  (default v1): operator fills in actualDelta via a
 *      REST endpoint; scheduler skips these but flags them as due.
 *    - inferred      : take the delta from a KPI source if Phase 3 lands
 *      a KPI mirror table (deferred to Phase 6 when chief loop needs it).
 *    - auto_kpi_query: hit an external metric (out-of-scope for v1).
 *
 *  Variance signal feeds the Phase 6 Chief of Staff learning loop. We
 *  compute variance as `actualDelta - estimatedDelta`. */

import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, lte, sql } from "drizzle-orm";
import {
  type Db,
  expectedKpiImpacts,
  getDb,
  type ExpectedKpiImpactInsert,
} from "@wavex-os/db";
import type {
  ActivityEventKind,
  ExpectedKpiImpact,
  PaperclipMode,
} from "@wavex-os/shared/types/mission-control";
import { logMissionControlActivity } from "./activity-log.js";

export interface DeclareKpiImpactInput {
  companyId: string;
  taskRefType: "issue" | "avatar_approval" | "mission_control_task";
  taskRefId: string;
  kpiId: string;
  scopeNodeId: string;
  direction: "increase" | "decrease" | "maintain";
  estimatedDelta: number;
  unit: string;
  timeHorizon: "immediate" | "hours" | "days" | "weeks";
  confidence: number;
  rationale: string;
  basedOnPriorTasks?: string[];
  measureAt?: Date;
  measurementMethod?: "auto_kpi_query" | "manual_input" | "inferred";
}

const TIME_HORIZON_MS: Record<DeclareKpiImpactInput["timeHorizon"], number> = {
  immediate: 5 * 60 * 1000,
  hours: 6 * 60 * 60 * 1000,
  days: 3 * 24 * 60 * 60 * 1000,
  weeks: 7 * 24 * 60 * 60 * 1000,
};

export async function declareKpiImpact(
  input: DeclareKpiImpactInput,
  db?: Db,
): Promise<ExpectedKpiImpact> {
  const resolved = db ?? (await getDb());
  const id = randomUUID();
  const measureAt =
    input.measureAt ??
    new Date(Date.now() + TIME_HORIZON_MS[input.timeHorizon]);
  const row: ExpectedKpiImpactInsert = {
    id,
    companyId: input.companyId,
    taskRefType: input.taskRefType,
    taskRefId: input.taskRefId,
    kpiId: input.kpiId,
    scopeNodeId: input.scopeNodeId,
    direction: input.direction,
    estimatedDelta: input.estimatedDelta,
    unit: input.unit,
    timeHorizon: input.timeHorizon,
    confidence: input.confidence,
    rationale: input.rationale,
    basedOnPriorTasks: input.basedOnPriorTasks ?? null,
    measureAt,
    measurementMethod: input.measurementMethod ?? "manual_input",
  };
  const inserted = await resolved.insert(expectedKpiImpacts).values(row).returning();
  const stored = inserted[0];
  if (!stored) throw new Error("declareKpiImpact insert returned no row");
  return rowToImpact(stored);
}

export interface QueryKpiImpactsInput {
  companyId: string;
  kpiId?: string;
  taskRefId?: string;
  scopeNodeId?: string;
  unmeasuredOnly?: boolean;
  limit?: number;
}

export async function queryKpiImpacts(
  input: QueryKpiImpactsInput,
  db?: Db,
): Promise<ExpectedKpiImpact[]> {
  const resolved = db ?? (await getDb());
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  const conds = [eq(expectedKpiImpacts.companyId, input.companyId)];
  if (input.kpiId) conds.push(eq(expectedKpiImpacts.kpiId, input.kpiId));
  if (input.taskRefId)
    conds.push(eq(expectedKpiImpacts.taskRefId, input.taskRefId));
  if (input.scopeNodeId)
    conds.push(eq(expectedKpiImpacts.scopeNodeId, input.scopeNodeId));
  if (input.unmeasuredOnly) conds.push(isNull(expectedKpiImpacts.actualDelta));
  const rows = await resolved
    .select()
    .from(expectedKpiImpacts)
    .where(and(...conds))
    .orderBy(desc(expectedKpiImpacts.createdAt))
    .limit(limit);
  return rows.map(rowToImpact);
}

export interface RecordMeasurementInput {
  impactId: string;
  actualDelta: number;
  modeContext: PaperclipMode;
  /** Node that recorded the measurement — usually the chief or operator. */
  recordedByNodeId: string;
}

const TARGET_HIT_THRESHOLD = 0.05; // 5% of estimated delta tolerance
const VARIANCE_ALERT_THRESHOLD = 0.5; // 50% off → variance event

export interface MeasurementResult {
  impact: ExpectedKpiImpact;
  variance: number;
  /** What kind of MC event was emitted alongside the measurement. */
  outcome: "target_hit" | "target_missed" | "variance_detected" | "neutral";
}

export async function recordKpiMeasurement(
  input: RecordMeasurementInput,
  db?: Db,
): Promise<MeasurementResult | null> {
  const resolved = db ?? (await getDb());
  const existing = await resolved
    .select()
    .from(expectedKpiImpacts)
    .where(eq(expectedKpiImpacts.id, input.impactId))
    .limit(1);
  const row = existing[0];
  if (!row) return null;
  const variance = input.actualDelta - row.estimatedDelta;
  const completedAt = new Date();
  const updated = await resolved
    .update(expectedKpiImpacts)
    .set({
      actualDelta: input.actualDelta,
      variance,
      measurementCompletedAt: completedAt,
    })
    .where(eq(expectedKpiImpacts.id, input.impactId))
    .returning();
  const finalRow = updated[0];
  if (!finalRow) return null;
  const impact = rowToImpact(finalRow);

  const outcome = classifyOutcome(row.estimatedDelta, input.actualDelta);
  const kind = outcomeToKind(outcome);
  if (kind) {
    await logMissionControlActivity({
      companyId: row.companyId,
      instanceId: row.companyId,
      kind,
      modeContext: input.modeContext,
      actorNodeId: input.recordedByNodeId,
      action: `mc.kpi.${outcome}`,
      subjectRef: {
        kind: "kpi_impact",
        id: row.id,
        gap: Math.abs(variance),
        variancePct:
          row.estimatedDelta !== 0
            ? Math.round((variance / Math.abs(row.estimatedDelta)) * 100)
            : 0,
      },
      kpiRef: { id: row.kpiId, name: row.kpiId },
    });
  }

  return { impact, variance, outcome };
}

function classifyOutcome(
  estimated: number,
  actual: number,
): MeasurementResult["outcome"] {
  if (estimated === 0) {
    return Math.abs(actual) < 0.0001 ? "target_hit" : "variance_detected";
  }
  const ratio = actual / estimated;
  if (ratio >= 1 - TARGET_HIT_THRESHOLD && ratio <= 1 + TARGET_HIT_THRESHOLD) {
    return "target_hit";
  }
  // Wrong direction OR materially off → missed; mild variance → variance
  const sameSign = Math.sign(estimated) === Math.sign(actual);
  if (!sameSign || ratio < 1 - VARIANCE_ALERT_THRESHOLD) {
    return "target_missed";
  }
  return "variance_detected";
}

function outcomeToKind(
  outcome: MeasurementResult["outcome"],
): ActivityEventKind | null {
  switch (outcome) {
    case "target_hit":
      return "kpi_target_hit";
    case "target_missed":
      return "kpi_target_missed";
    case "variance_detected":
      return "kpi_variance_detected";
    default:
      return null;
  }
}

/** Find every impact whose `measure_at <= now()` and that hasn't been
 *  measured yet. Used by the scheduler + the "due now" UI badge. */
export async function listDueKpiImpacts(
  companyId: string,
  db?: Db,
): Promise<ExpectedKpiImpact[]> {
  const resolved = db ?? (await getDb());
  const rows = await resolved
    .select()
    .from(expectedKpiImpacts)
    .where(
      and(
        eq(expectedKpiImpacts.companyId, companyId),
        isNull(expectedKpiImpacts.actualDelta),
        lte(expectedKpiImpacts.measureAt, new Date()),
      ),
    )
    .orderBy(desc(expectedKpiImpacts.measureAt));
  return rows.map(rowToImpact);
}

function rowToImpact(
  row: typeof expectedKpiImpacts.$inferSelect,
): ExpectedKpiImpact {
  const priorRaw = row.basedOnPriorTasks as unknown;
  const basedOnPriorTasks = Array.isArray(priorRaw)
    ? priorRaw.filter((x): x is string => typeof x === "string")
    : undefined;
  return {
    id: row.id,
    taskId: row.taskRefId,
    kpiId: row.kpiId,
    scopeNodeId: row.scopeNodeId,
    direction: row.direction as ExpectedKpiImpact["direction"],
    estimatedDelta: row.estimatedDelta,
    unit: row.unit,
    timeHorizon: row.timeHorizon as ExpectedKpiImpact["timeHorizon"],
    confidence: row.confidence,
    rationale: row.rationale,
    basedOnPriorTasks,
    measureAt: row.measureAt.toISOString(),
    actualDelta: row.actualDelta ?? undefined,
    measurementMethod:
      row.measurementMethod as ExpectedKpiImpact["measurementMethod"],
    measurementCompletedAt: row.measurementCompletedAt?.toISOString(),
    variance: row.variance ?? undefined,
  };
}

/** Aggregate per-KPI scoreboard data used by the Phase 3.3 widget. */
export interface KpiScoreboardEntry {
  kpiId: string;
  totalImpacts: number;
  measuredImpacts: number;
  dueNow: number;
  cumulativeEstimated: number;
  cumulativeActual: number;
  /** Cumulative actual / cumulative estimated. 1.0 == on target. */
  attainmentRatio: number;
  /** Owner nodes derived from scope_node_id distribution. */
  ownerNodeIds: string[];
}

export async function getScoreboard(
  companyId: string,
  db?: Db,
): Promise<KpiScoreboardEntry[]> {
  const resolved = db ?? (await getDb());
  const rows = await resolved
    .select()
    .from(expectedKpiImpacts)
    .where(eq(expectedKpiImpacts.companyId, companyId));
  const byKpi = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = byKpi.get(row.kpiId) ?? [];
    list.push(row);
    byKpi.set(row.kpiId, list);
  }
  const now = new Date();
  return Array.from(byKpi.entries()).map(([kpiId, list]) => {
    let cumulativeEstimated = 0;
    let cumulativeActual = 0;
    let measured = 0;
    let dueNow = 0;
    const owners = new Set<string>();
    for (const row of list) {
      cumulativeEstimated += row.estimatedDelta;
      owners.add(row.scopeNodeId);
      if (row.actualDelta != null) {
        cumulativeActual += row.actualDelta;
        measured += 1;
      } else if (row.measureAt <= now) {
        dueNow += 1;
      }
    }
    const attainmentRatio =
      cumulativeEstimated === 0
        ? 0
        : cumulativeActual / cumulativeEstimated;
    return {
      kpiId,
      totalImpacts: list.length,
      measuredImpacts: measured,
      dueNow,
      cumulativeEstimated,
      cumulativeActual,
      attainmentRatio,
      ownerNodeIds: Array.from(owners),
    };
  });
}

/** Convenience export for the scheduler endpoint — fans out a no-op
 *  measurement notice for every due impact (manual_input strategy) so
 *  the stream surfaces the "due now" signal. Real measurement still
 *  goes through `recordKpiMeasurement()`. */
export async function announceDueImpacts(
  companyId: string,
  modeContext: PaperclipMode,
  db?: Db,
): Promise<number> {
  const due = await listDueKpiImpacts(companyId, db);
  for (const impact of due) {
    await logMissionControlActivity({
      companyId,
      instanceId: companyId,
      kind: "kpi_measurement_taken",
      modeContext,
      actorNodeId: impact.scopeNodeId,
      action: "mc.kpi.measurement_due",
      subjectRef: {
        kind: "kpi_impact",
        id: impact.id,
        method: impact.measurementMethod,
      },
      kpiRef: { id: impact.kpiId, name: impact.kpiId },
    });
  }
  return due.length;
}

// Test helpers exported only for use in the vitest harness; consumers in
// production code should call `eq` from drizzle-orm directly.
export const _dbHelpers = { eq, sql };
