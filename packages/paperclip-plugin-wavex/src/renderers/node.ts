/** Node (agent/human/department) lifecycle renderers — added, archived,
 *  paused, resumed, corrected, flagged, promoted. */

import { type EventRenderer, nodeName } from "./render-context.js";

export const node_added: EventRenderer = (event, ctx) => {
  const newNode = nodeName(event.subjectRef.id ?? event.actorNodeId, ctx);
  const parent = event.subjectRef.toNodeId
    ? ` under ${nodeName(event.subjectRef.toNodeId, ctx)}`
    : "";
  return `${newNode} joined${parent}`;
};

export const node_archived: EventRenderer = (event, ctx) => {
  const archived = nodeName(event.subjectRef.id ?? event.actorNodeId, ctx);
  const reason = event.subjectRef.reason;
  return `${archived} archived${reason ? ` — ${reason}` : ""}`;
};

export const node_paused: EventRenderer = (event, ctx) => {
  const who = nodeName(event.actorNodeId, ctx);
  const target = nodeName(event.subjectRef.id ?? event.actorNodeId, ctx);
  const reason = event.subjectRef.reason;
  if (who === target) return `${who} paused${reason ? ` — ${reason}` : ""}`;
  return `${who} paused ${target}${reason ? ` — ${reason}` : ""}`;
};

export const node_resumed: EventRenderer = (event, ctx) => {
  const who = nodeName(event.actorNodeId, ctx);
  const target = nodeName(event.subjectRef.id ?? event.actorNodeId, ctx);
  if (who === target) return `${who} resumed`;
  return `${who} resumed ${target}`;
};

export const node_corrected: EventRenderer = (event, ctx) => {
  const corrector = nodeName(event.actorNodeId, ctx);
  const target = nodeName(event.subjectRef.id, ctx);
  const reason = event.subjectRef.reason;
  return `${corrector} corrected ${target}${reason ? `: ${reason}` : ""}`;
};

export const node_flagged: EventRenderer = (event, ctx) => {
  const flagger = nodeName(event.actorNodeId, ctx);
  const target = nodeName(event.subjectRef.id, ctx);
  const reason = event.subjectRef.reason;
  return `${flagger} flagged ${target}${reason ? `: ${reason}` : ""}`;
};

export const node_promoted: EventRenderer = (event, ctx) => {
  const promoter = nodeName(event.actorNodeId, ctx);
  const target = nodeName(event.subjectRef.id, ctx);
  return `${promoter} promoted ${target}`;
};
