/** Mission Control — Chief of Staff (Phase 6).
 *
 *  Persists per-instance config + origination rules, evaluates triggers
 *  on demand, and surfaces the result via the MC event bus. The Chief
 *  is the universal name for whatever orchestrator the mode provides:
 *
 *    - Avatar mode  → the conductor (kernel agent that routes work to
 *      sub-agents). The chief config rows persist as if there's a
 *      single "chief" so the dashboard surface stays uniform.
 *    - Solo Founder → an explicit chief_of_staff scope node from the
 *      swarm manifest. Rules persist in this table; on each tick the
 *      evaluator walks them.
 *    - Hybrid       → same as Solo Founder, scoped to the workspace.
 *
 *  Trigger kinds implemented in v1:
 *    - kpi_threshold:  fire when a KPI's attainment ratio drops below
 *      a configurable floor.
 *    - kpi_variance:   fire when the most recent measurement variance
 *      exceeds a configurable magnitude.
 *    - capacity_imbalance: fire when one node has >2× the average
 *      activity count of the rest.
 *    - schedule:       fire on every evaluator tick (poor-person's cron).
 *    - pattern:        no-op (placeholder for ML-driven detection).
 *
 *  Each fired rule emits a chief_pattern_detected event with the trigger
 *  details; a follow-up chief_rebalance_recommended fires only for
 *  capacity_imbalance. The actual task origination is intentionally
 *  deferred — the operator approves the recommendation, then the Phase 2
 *  Deliverable + Phase 4 AssignmentLink flow takes over. */

import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import {
  type Db,
  chiefConfigs,
  chiefOriginationRules,
  getDb,
  type ChiefConfigInsert,
  type ChiefConfigRow,
  type ChiefOriginationRuleInsert,
  type ChiefOriginationRuleRow,
} from "@wavex-os/db";
import type {
  ActivityEventKind,
  ChiefOriginationRule,
  ChiefResponsibility,
  ChiefOfStaffConfig,
  PaperclipMode,
  ScopeOfAuthority,
} from "@wavex-os/shared/types/mission-control";
import { logMissionControlActivity } from "./activity-log.js";
import { getScoreboard } from "./kpi-impacts.js";
import { buildAccountabilityGraph } from "./graph.js";

export interface UpsertChiefConfigInput {
  instanceId: string;
  mode: PaperclipMode;
  enabled?: boolean;
  responsibilities?: ChiefResponsibility[];
  scopeOfAuthority?: ScopeOfAuthority;
  dailyBudgetUSD?: number;
  cooldownMinutes?: number;
  maxOriginationsPerDay?: number;
}

export async function upsertChiefConfig(
  input: UpsertChiefConfigInput,
  db?: Db,
): Promise<ChiefOfStaffConfig> {
  const resolved = db ?? (await getDb());
  const existing = await resolved
    .select()
    .from(chiefConfigs)
    .where(eq(chiefConfigs.instanceId, input.instanceId))
    .limit(1);
  const payload: ChiefConfigInsert = {
    instanceId: input.instanceId,
    mode: input.mode,
    enabled: input.enabled ?? true,
    responsibilities: input.responsibilities ?? [],
    scopeOfAuthority: input.scopeOfAuthority ?? { kind: "whole_org", departmentIds: [] },
    dailyBudgetUsd: input.dailyBudgetUSD ?? 0,
    cooldownMinutes: input.cooldownMinutes ?? 15,
    maxOriginationsPerDay: input.maxOriginationsPerDay ?? 20,
    updatedAt: new Date(),
  };
  if (existing.length === 0) {
    await resolved.insert(chiefConfigs).values(payload);
  } else {
    await resolved
      .update(chiefConfigs)
      .set(payload)
      .where(eq(chiefConfigs.instanceId, input.instanceId));
  }
  return getChiefConfig(input.instanceId, resolved) as Promise<ChiefOfStaffConfig>;
}

export async function getChiefConfig(
  instanceId: string,
  db?: Db,
): Promise<ChiefOfStaffConfig | null> {
  const resolved = db ?? (await getDb());
  const rows = await resolved
    .select()
    .from(chiefConfigs)
    .where(eq(chiefConfigs.instanceId, instanceId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const rules = await listOriginationRules(instanceId, resolved);
  return rowToConfig(row, rules);
}

export async function addOriginationRule(
  rule: Omit<ChiefOriginationRule, "id"> & { instanceId: string },
  db?: Db,
): Promise<ChiefOriginationRule> {
  const resolved = db ?? (await getDb());
  const id = randomUUID();
  const insert: ChiefOriginationRuleInsert = {
    id,
    instanceId: rule.instanceId,
    name: rule.name,
    description: rule.description ?? "",
    triggerKind: rule.triggerKind,
    triggerConfig: rule.triggerConfig ?? {},
    taskTemplate: rule.taskTemplate ?? {},
    enabled: rule.enabled ?? true,
  };
  const inserted = await resolved
    .insert(chiefOriginationRules)
    .values(insert)
    .returning();
  const stored = inserted[0];
  if (!stored) throw new Error("addOriginationRule insert returned no row");
  return rowToRule(stored);
}

export async function listOriginationRules(
  instanceId: string,
  db?: Db,
): Promise<ChiefOriginationRule[]> {
  const resolved = db ?? (await getDb());
  const rows = await resolved
    .select()
    .from(chiefOriginationRules)
    .where(eq(chiefOriginationRules.instanceId, instanceId))
    .orderBy(desc(chiefOriginationRules.createdAt));
  return rows.map(rowToRule);
}

export async function setRuleEnabled(
  ruleId: string,
  enabled: boolean,
  db?: Db,
): Promise<boolean> {
  const resolved = db ?? (await getDb());
  const result = await resolved
    .update(chiefOriginationRules)
    .set({ enabled })
    .where(eq(chiefOriginationRules.id, ruleId))
    .returning();
  return result.length > 0;
}

// ─── Evaluator ─────────────────────────────────────────────────────────────

export interface ChiefEvaluationResult {
  evaluatedRules: number;
  triggered: Array<{
    ruleId: string;
    ruleName: string;
    triggerKind: string;
    detail: string;
    eventKind: ActivityEventKind;
  }>;
  /** Rules skipped because disabled or rule kind unimplemented. */
  skipped: number;
}

export interface EvaluateChiefInput {
  instanceId: string;
  modeContext: PaperclipMode;
  /** Who runs the evaluator — usually the chief node id. */
  actorNodeId?: string;
}

export async function evaluateChiefTriggers(
  input: EvaluateChiefInput,
  db?: Db,
): Promise<ChiefEvaluationResult> {
  const resolved = db ?? (await getDb());
  const cfg = await getChiefConfig(input.instanceId, resolved);
  if (!cfg || !cfg.enabled) {
    return { evaluatedRules: 0, triggered: [], skipped: 0 };
  }
  const actorNodeId = input.actorNodeId ?? `chief:${input.instanceId}`;
  const triggered: ChiefEvaluationResult["triggered"] = [];
  let skipped = 0;

  // Precompute signals shared across rules.
  const scoreboard = await getScoreboard(input.instanceId, resolved);
  const graph = await buildAccountabilityGraph(
    { companyId: input.instanceId },
    resolved,
  );

  for (const rule of cfg.originationRules) {
    if (!rule.enabled) {
      skipped += 1;
      continue;
    }
    switch (rule.triggerKind) {
      case "kpi_threshold": {
        const kpiId = stringField(rule.triggerConfig, "kpiId");
        const minRatio = numberField(rule.triggerConfig, "minRatio", 0.7);
        const entry = scoreboard.find((e) => e.kpiId === kpiId);
        if (!entry || entry.measuredImpacts === 0) continue;
        if (entry.attainmentRatio < minRatio) {
          const detail = `${kpiId} attainment ${(entry.attainmentRatio * 100).toFixed(0)}% < ${(minRatio * 100).toFixed(0)}%`;
          await emit(
            "chief_pattern_detected",
            input,
            actorNodeId,
            rule,
            detail,
            { kpiId, attainmentRatio: entry.attainmentRatio, minRatio },
            resolved,
          );
          triggered.push({
            ruleId: rule.id,
            ruleName: rule.name,
            triggerKind: rule.triggerKind,
            detail,
            eventKind: "chief_pattern_detected",
          });
        }
        break;
      }
      case "kpi_variance": {
        const kpiId = stringField(rule.triggerConfig, "kpiId");
        const minPct = numberField(rule.triggerConfig, "minVariancePct", 25);
        const entry = scoreboard.find((e) => e.kpiId === kpiId);
        if (!entry || entry.cumulativeEstimated === 0) continue;
        const variance = entry.cumulativeActual - entry.cumulativeEstimated;
        const pct = Math.abs(variance / entry.cumulativeEstimated) * 100;
        if (pct >= minPct) {
          const detail = `${kpiId} variance ${pct.toFixed(0)}% ≥ ${minPct}%`;
          await emit(
            "chief_pattern_detected",
            input,
            actorNodeId,
            rule,
            detail,
            { kpiId, variancePct: pct, minPct },
            resolved,
          );
          triggered.push({
            ruleId: rule.id,
            ruleName: rule.name,
            triggerKind: rule.triggerKind,
            detail,
            eventKind: "chief_pattern_detected",
          });
        }
        break;
      }
      case "capacity_imbalance": {
        if (!graph || graph.nodes.length < 2) continue;
        const totals = graph.nodes
          .map((n) => n.activityCount)
          .filter((c) => c > 0);
        if (totals.length === 0) continue;
        const max = Math.max(...totals);
        const avg = totals.reduce((a, b) => a + b, 0) / totals.length;
        const ratio = numberField(rule.triggerConfig, "imbalanceRatio", 2);
        if (max >= avg * ratio) {
          const hotNode = graph.nodes.find((n) => n.activityCount === max);
          const detail = `${hotNode?.name ?? "node"} carries ${max} of ~${avg.toFixed(1)} avg — load ${((max / avg) || 0).toFixed(1)}× the rest`;
          await emit(
            "chief_rebalance_recommended",
            input,
            actorNodeId,
            rule,
            detail,
            {
              hotNodeId: hotNode?.id,
              max,
              avg,
              imbalanceRatio: max / Math.max(avg, 1),
            },
            resolved,
          );
          triggered.push({
            ruleId: rule.id,
            ruleName: rule.name,
            triggerKind: rule.triggerKind,
            detail,
            eventKind: "chief_rebalance_recommended",
          });
        }
        break;
      }
      case "schedule": {
        const detail = `Scheduled fire: ${rule.name}`;
        await emit(
          "chief_pattern_detected",
          input,
          actorNodeId,
          rule,
          detail,
          { scheduled: true },
          resolved,
        );
        triggered.push({
          ruleId: rule.id,
          ruleName: rule.name,
          triggerKind: rule.triggerKind,
          detail,
          eventKind: "chief_pattern_detected",
        });
        break;
      }
      case "pattern": {
        // Reserved for ML-driven detection; v1 no-op.
        skipped += 1;
        break;
      }
      default: {
        skipped += 1;
        break;
      }
    }
  }
  return {
    evaluatedRules: cfg.originationRules.length,
    triggered,
    skipped,
  };
}

async function emit(
  kind: ActivityEventKind,
  input: EvaluateChiefInput,
  actorNodeId: string,
  rule: ChiefOriginationRule,
  detail: string,
  extra: Record<string, unknown>,
  db: Db,
): Promise<void> {
  await logMissionControlActivity(
    {
      companyId: input.instanceId,
      instanceId: input.instanceId,
      kind,
      modeContext: input.modeContext,
      actorNodeId,
      action: `mc.chief.${kind === "chief_pattern_detected" ? "pattern_detected" : kind === "chief_rebalance_recommended" ? "rebalance_recommended" : "origination_blocked"}`,
      subjectRef: {
        kind: "chief_rule",
        id: rule.id,
        patternDescription: detail,
        summary: detail,
        ruleName: rule.name,
        triggerKind: rule.triggerKind,
        ...extra,
      },
    },
    db,
  );
}

function rowToConfig(
  row: ChiefConfigRow,
  rules: ChiefOriginationRule[],
): ChiefOfStaffConfig {
  return {
    instanceId: row.instanceId,
    enabled: row.enabled,
    mode: row.mode as PaperclipMode,
    responsibilities: (row.responsibilities as ChiefResponsibility[]) ?? [],
    originationRules: rules,
    scopeOfAuthority: (row.scopeOfAuthority as ScopeOfAuthority) ?? {
      kind: "whole_org",
      departmentIds: [],
    },
    dailyBudgetUSD: row.dailyBudgetUsd,
    cooldownMinutes: row.cooldownMinutes,
    maxOriginationsPerDay: row.maxOriginationsPerDay,
  };
}

function rowToRule(row: ChiefOriginationRuleRow): ChiefOriginationRule {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    triggerKind: row.triggerKind as ChiefOriginationRule["triggerKind"],
    triggerConfig: (row.triggerConfig as Record<string, unknown>) ?? {},
    taskTemplate: (row.taskTemplate as ChiefOriginationRule["taskTemplate"]) ?? {
      title: "",
      description: "",
      assigneeStrategy: "least_loaded_in_scope",
    },
    enabled: row.enabled,
  };
}

function stringField(
  obj: Record<string, unknown> | undefined,
  key: string,
): string {
  const v = obj?.[key];
  return typeof v === "string" ? v : "";
}

function numberField(
  obj: Record<string, unknown> | undefined,
  key: string,
  fallback: number,
): number {
  const v = obj?.[key];
  return typeof v === "number" ? v : fallback;
}

export const _dbHelpers = { eq, and };
