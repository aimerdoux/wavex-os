/** Mission Control — AssignmentLink append + chain reconstruction.
 *
 *  Phase 4. The chain is an append-only audit trail of how a task moved
 *  between nodes. We never update rows; rejections and re-assignments
 *  land as new entries so the operator can reconstruct exactly who
 *  passed the baton when. */

import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, isNull, or, sql } from "drizzle-orm";
import {
  type Db,
  assignmentLinks,
  getDb,
  type AssignmentLinkInsert,
  type AssignmentLinkRow,
} from "@wavex-os/db";
import type {
  ActivityEventKind,
  AssignmentLink,
  PaperclipMode,
  TaskRef,
} from "@wavex-os/shared/types/mission-control";
import { logMissionControlActivity } from "./activity-log.js";

export type AssignmentLinkKind =
  | "originated"
  | "assigned"
  | "accepted"
  | "rejected"
  | "delegated"
  | "completed"
  | "failed"
  | "cancelled";

export interface AppendLinkInput {
  companyId: string;
  instanceId: string;
  modeContext: PaperclipMode;
  taskRefType: "issue" | "avatar_approval" | "mission_control_task";
  taskRefId: string;
  kind: AssignmentLinkKind;
  fromNodeId?: string;
  toNodeId?: string;
  reason?: string;
  taskRef?: TaskRef;
}

const KIND_TO_EVENT: Partial<Record<AssignmentLinkKind, ActivityEventKind>> = {
  originated: "task_originated",
  assigned: "task_assigned",
  accepted: "task_accepted",
  rejected: "task_rejected",
  delegated: "task_delegated",
  completed: "task_completed",
  failed: "task_failed",
  cancelled: "task_cancelled",
};

export async function appendAssignmentLink(
  input: AppendLinkInput,
  db?: Db,
): Promise<AssignmentLinkRow> {
  const resolved = db ?? (await getDb());
  const id = randomUUID();
  const row: AssignmentLinkInsert = {
    id,
    companyId: input.companyId,
    instanceId: input.instanceId,
    taskRefType: input.taskRefType,
    taskRefId: input.taskRefId,
    kind: input.kind,
    fromNodeId: input.fromNodeId ?? null,
    toNodeId: input.toNodeId ?? null,
    reason: input.reason ?? null,
  };
  const inserted = await resolved.insert(assignmentLinks).values(row).returning();
  const stored = inserted[0];
  if (!stored) throw new Error("appendAssignmentLink insert returned no row");

  const eventKind = KIND_TO_EVENT[input.kind];
  if (eventKind) {
    await logMissionControlActivity({
      companyId: input.companyId,
      instanceId: input.instanceId,
      kind: eventKind,
      modeContext: input.modeContext,
      actorNodeId: input.fromNodeId ?? input.toNodeId ?? "system",
      action: `mc.assignment.${input.kind}`,
      subjectRef: {
        kind: "task",
        id: input.taskRefId,
        toNodeId: input.toNodeId,
        reason: input.reason,
      },
      taskRef: input.taskRef,
    });
  }

  return stored;
}

export async function queryAssignmentChain(
  taskRefId: string,
  db?: Db,
): Promise<AssignmentLink[]> {
  const resolved = db ?? (await getDb());
  const rows = await resolved
    .select()
    .from(assignmentLinks)
    .where(eq(assignmentLinks.taskRefId, taskRefId))
    .orderBy(asc(assignmentLinks.at));
  return rows.map(rowToAssignmentLink);
}

export async function listOpenAssignmentsForNode(
  toNodeId: string,
  limit = 100,
  db?: Db,
): Promise<AssignmentLinkRow[]> {
  const resolved = db ?? (await getDb());
  // Open = an `assigned`/`delegated` link with no subsequent terminal
  // entry for the same task. Approximate via the most recent link per
  // task — if it's assigned/delegated to me, it's open.
  const rows = await resolved
    .select()
    .from(assignmentLinks)
    .where(eq(assignmentLinks.toNodeId, toNodeId))
    .orderBy(desc(assignmentLinks.at))
    .limit(Math.min(Math.max(limit, 1), 500));
  // Group by task, take only the last link per task, keep if still pending.
  const seen = new Set<string>();
  const open: AssignmentLinkRow[] = [];
  for (const row of rows) {
    if (seen.has(row.taskRefId)) continue;
    seen.add(row.taskRefId);
    if (row.kind === "assigned" || row.kind === "delegated") {
      open.push(row);
    }
  }
  return open;
}

function rowToAssignmentLink(row: AssignmentLinkRow): AssignmentLink {
  return {
    fromNodeId: row.fromNodeId ?? "",
    toNodeId: row.toNodeId ?? "",
    assignedAt: row.at.toISOString(),
    reason: row.reason ?? "",
    acceptedAt: row.kind === "accepted" ? row.at.toISOString() : undefined,
    rejectedAt: row.kind === "rejected" ? row.at.toISOString() : undefined,
    rejectionReason: row.kind === "rejected" ? (row.reason ?? undefined) : undefined,
  };
}

/** Reconstruct the current owner of a task by walking the chain. Returns
 *  null if the task has no chain entries (never assigned). */
export async function currentOwnerOf(
  taskRefId: string,
  db?: Db,
): Promise<string | null> {
  const resolved = db ?? (await getDb());
  const rows = await resolved
    .select()
    .from(assignmentLinks)
    .where(eq(assignmentLinks.taskRefId, taskRefId))
    .orderBy(desc(assignmentLinks.at))
    .limit(1);
  const latest = rows[0];
  if (!latest) return null;
  if (latest.kind === "assigned" || latest.kind === "delegated" || latest.kind === "accepted") {
    return latest.toNodeId ?? null;
  }
  if (latest.kind === "rejected") {
    return latest.fromNodeId ?? null;
  }
  return null; // terminal — no current owner
}

// Convenience export so tests can use the same DSL.
export const _dbHelpers = { eq, sql, or, isNull };
