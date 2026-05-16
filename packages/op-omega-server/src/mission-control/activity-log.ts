/** Mission Control activity-log service.
 *
 *  `logMissionControlActivity(input)` writes one row to the wavex-side
 *  `mission_control_events` table (mirrors Paperclip's `activity_log`
 *  shape), publishes the typed event onto the in-process bus, and
 *  returns the canonical `ActivityEvent` shape. Phase 1.6 wires the
 *  wavex runners (avatar mail/calendar/slack + bridge handoffs) to this.
 *
 *  `queryMissionControlEvents()` is the read side that powers the
 *  GET /api/mission-control/activity endpoint. It supports the filters
 *  the Stream widget needs (since/until/scope/kind/kpi/limit) and is
 *  index-aware: company+at for the default case, company+kind+at when
 *  filtering by kind. */

import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import { type Db, getDb, missionControlEvents } from "@wavex-os/db";
import type {
  ActivityEvent,
  ActivityEventKind,
  PaperclipMode,
  SubjectRef,
  TaskRef,
  KpiRef,
  DeliverableRef,
} from "@wavex-os/shared/types/mission-control";
import { defaultSeverityForKind } from "./event-kind-map.js";
import { publishMissionControlEvent } from "./activity-bus.js";

export interface LogMissionControlActivityInput {
  companyId: string;
  instanceId: string;
  kind: ActivityEventKind;
  modeContext: PaperclipMode;
  actorNodeId: string;
  action: string;
  subjectRef: SubjectRef;
  scopeChain?: string[];
  taskRef?: TaskRef;
  kpiRef?: KpiRef;
  deliverableRef?: DeliverableRef;
  costUSD?: number;
  expectedImpact?: string;
  plainLanguageSentence?: string;
  severity?: ActivityEvent["severity"];
  detailUrl?: string;
  visibleToScopeNodeIds?: string[];
}

function rowToEvent(row: typeof missionControlEvents.$inferSelect): ActivityEvent {
  const scopeChainRaw = row.scopeChain as unknown;
  const scopeChain = Array.isArray(scopeChainRaw)
    ? scopeChainRaw.filter((x): x is string => typeof x === "string")
    : [];
  const visibilityRaw = row.visibleToNodeIds as unknown;
  const visibility = Array.isArray(visibilityRaw)
    ? visibilityRaw.filter((x): x is string => typeof x === "string")
    : undefined;
  const taskRef: TaskRef | undefined = row.taskRefId
    ? {
        id: row.taskRefId,
        title: row.taskRefTitle ?? "",
        status: (row.taskRefStatus ?? "originated") as TaskRef["status"],
      }
    : undefined;
  const kpiRef: KpiRef | undefined = row.kpiRefId
    ? { id: row.kpiRefId, name: row.kpiRefName ?? "" }
    : undefined;
  const deliverableRef: DeliverableRef | undefined = row.deliverableRefId
    ? {
        id: row.deliverableRefId,
        title: row.deliverableRefTitle ?? "",
        kind: (row.deliverableRefKind ?? "document") as DeliverableRef["kind"],
      }
    : undefined;
  return {
    id: row.id,
    instanceId: row.instanceId,
    at: row.at.toISOString(),
    kind: row.kind as ActivityEventKind,
    modeContext: row.modeContext as PaperclipMode,
    scopeChain,
    actorNodeId: row.actorNodeId,
    action: row.action,
    subjectRef: row.subjectRef as SubjectRef,
    taskRef,
    kpiRef,
    deliverableRef,
    costUSD: row.costUsd ? Number(row.costUsd) : undefined,
    expectedImpact: row.expectedImpact ?? undefined,
    plainLanguageSentence: row.plainLanguageSentence,
    severity: row.severity as ActivityEvent["severity"],
    detailUrl: row.detailUrl,
    visibleToScopeNodeIds: visibility,
  };
}

export async function logMissionControlActivity(
  input: LogMissionControlActivityInput,
  db?: Db,
): Promise<ActivityEvent> {
  const resolved = db ?? (await getDb());
  const id = randomUUID();
  const at = new Date();
  const severity = input.severity ?? defaultSeverityForKind(input.kind);
  const insertedRows = await resolved
    .insert(missionControlEvents)
    .values({
      id,
      instanceId: input.instanceId,
      companyId: input.companyId,
      at,
      kind: input.kind,
      modeContext: input.modeContext,
      actorNodeId: input.actorNodeId,
      action: input.action,
      subjectRef: input.subjectRef,
      scopeChain: input.scopeChain ?? [],
      taskRefId: input.taskRef?.id ?? null,
      taskRefTitle: input.taskRef?.title ?? null,
      taskRefStatus: input.taskRef?.status ?? null,
      kpiRefId: input.kpiRef?.id ?? null,
      kpiRefName: input.kpiRef?.name ?? null,
      deliverableRefId: input.deliverableRef?.id ?? null,
      deliverableRefTitle: input.deliverableRef?.title ?? null,
      deliverableRefKind: input.deliverableRef?.kind ?? null,
      costUsd: input.costUSD?.toString() ?? null,
      expectedImpact: input.expectedImpact ?? null,
      plainLanguageSentence: input.plainLanguageSentence ?? "",
      severity,
      detailUrl: input.detailUrl ?? `/mission-control/event/${id}`,
      visibleToNodeIds: input.visibleToScopeNodeIds ?? null,
    })
    .returning();
  const row = insertedRows[0];
  if (!row) throw new Error("logMissionControlActivity insert returned no row");
  const event = rowToEvent(row);
  publishMissionControlEvent(event);
  return event;
}

export interface QueryMissionControlEventsInput {
  companyId: string;
  since?: Date;
  until?: Date;
  kinds?: ActivityEventKind[];
  kpiId?: string;
  taskRefId?: string;
  scopeNodeId?: string;
  limit?: number;
  order?: "asc" | "desc";
}

export async function queryMissionControlEvents(
  input: QueryMissionControlEventsInput,
  db?: Db,
): Promise<ActivityEvent[]> {
  const resolved = db ?? (await getDb());
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  const conds = [eq(missionControlEvents.companyId, input.companyId)];
  if (input.since) conds.push(gt(missionControlEvents.at, input.since));
  if (input.until) conds.push(lt(missionControlEvents.at, input.until));
  if (input.kinds && input.kinds.length > 0)
    conds.push(inArray(missionControlEvents.kind, input.kinds));
  if (input.kpiId) conds.push(eq(missionControlEvents.kpiRefId, input.kpiId));
  if (input.taskRefId)
    conds.push(eq(missionControlEvents.taskRefId, input.taskRefId));
  if (input.scopeNodeId) {
    // Match either actor or any ancestor in scope_chain.
    conds.push(
      sql`(${missionControlEvents.actorNodeId} = ${input.scopeNodeId} OR ${missionControlEvents.scopeChain}::jsonb ? ${input.scopeNodeId})`,
    );
  }
  const order = input.order === "asc" ? asc : desc;
  const rows = await resolved
    .select()
    .from(missionControlEvents)
    .where(and(...conds))
    .orderBy(order(missionControlEvents.at))
    .limit(limit);
  return rows.map(rowToEvent);
}
