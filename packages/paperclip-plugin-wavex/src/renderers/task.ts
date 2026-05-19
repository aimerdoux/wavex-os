/** Task lifecycle renderers — origination, assignment, accept, delegate,
 *  review, approve, reject, complete, fail, cancel.
 *
 *  Each renderer produces a single plain-language sentence. No HTML, no
 *  markdown — the EventRow component formats timestamps + drill-down
 *  affordances around the sentence.
 */

import type { ActivityEvent } from "@wavex-os/shared/types/mission-control";
import {
  type EventRenderer,
  type RenderContext,
  formatImpact,
  formatUSD,
  kpiName,
  nodeName,
  resolveOriginator,
} from "./render-context.js";

function taskTitle(event: ActivityEvent): string {
  return event.taskRef?.title ?? event.subjectRef.title ?? "(untitled task)";
}

export const task_originated: EventRenderer = (event, ctx) => {
  const who = resolveOriginator(event, ctx);
  const title = taskTitle(event);
  const impact = formatImpact(event.expectedImpact);
  const kpi = event.kpiRef ? kpiName(event.kpiRef.id, ctx) : null;
  const tail = kpi
    ? `Linked KPI: ${kpi}`
    : impact ?? "no KPI linkage stated";
  return `${who} originated task: "${title}" — ${tail}`;
};

export const task_assigned: EventRenderer = (event, ctx) => {
  const from = resolveOriginator(event, ctx);
  const to = nodeName(event.subjectRef.toNodeId, ctx);
  const title = taskTitle(event);
  const reason = event.subjectRef.reason;
  return `${from} assigned "${title}" to ${to}${reason ? ` (${reason})` : ""}`;
};

export const task_accepted: EventRenderer = (event, ctx) => {
  const who = nodeName(event.actorNodeId, ctx);
  const title = taskTitle(event);
  const cost = event.costUSD ? ` est ${formatUSD(event.costUSD)}` : "";
  return `${who} accepted task: "${title}"${cost}`;
};

export const task_delegated: EventRenderer = (event, ctx) => {
  const from = nodeName(event.actorNodeId, ctx);
  const to = nodeName(event.subjectRef.toNodeId, ctx);
  const title = event.subjectRef.title ?? taskTitle(event);
  const reason = event.subjectRef.reason;
  return `${from} delegated to ${to}: "${title}"${reason ? ` — ${reason}` : ""}`;
};

export const task_awaiting_review: EventRenderer = (event, ctx) => {
  const who = nodeName(event.actorNodeId, ctx);
  const title = taskTitle(event);
  return `${who} flagged "${title}" for review`;
};

export const task_approved: EventRenderer = (event, ctx) => {
  const reviewer = nodeName(event.actorNodeId, ctx);
  const title = taskTitle(event);
  return `${reviewer} approved "${title}"`;
};

export const task_rejected: EventRenderer = (event, ctx) => {
  const reviewer = nodeName(event.actorNodeId, ctx);
  const title = taskTitle(event);
  const reason = event.subjectRef.reason;
  return `${reviewer} rejected "${title}"${reason ? ` — ${reason}` : ""}`;
};

export const task_completed: EventRenderer = (event, ctx) => {
  const who = nodeName(event.actorNodeId, ctx);
  const title = taskTitle(event);
  const cost = event.costUSD !== undefined ? ` (${formatUSD(event.costUSD)})` : "";
  return `${who} completed "${title}"${cost}`;
};

export const task_failed: EventRenderer = (event, ctx) => {
  const who = nodeName(event.actorNodeId, ctx);
  const title = taskTitle(event);
  const reason = event.subjectRef.reason;
  return `${who} failed "${title}"${reason ? ` — ${reason}` : ""}`;
};

export const task_cancelled: EventRenderer = (event, ctx) => {
  const who = nodeName(event.actorNodeId, ctx);
  const title = taskTitle(event);
  const reason = event.subjectRef.reason;
  return `${who} cancelled "${title}"${reason ? ` — ${reason}` : ""}`;
};
