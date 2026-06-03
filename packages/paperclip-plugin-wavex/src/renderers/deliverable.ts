/** Deliverable lifecycle renderers — produced, revised, approved, published. */

import {
  type EventRenderer,
  formatBytes,
  nodeName,
} from "./render-context.js";

function deliverableName(event: Parameters<EventRenderer>[0]): string {
  return event.deliverableRef?.title ?? event.subjectRef.title ?? "(untitled)";
}

export const deliverable_produced: EventRenderer = (event, ctx) => {
  const who = nodeName(event.actorNodeId, ctx);
  const title = deliverableName(event);
  const kind = event.deliverableRef?.kind ?? "artifact";
  const d = event.deliverableRef
    ? ctx.deliverableCatalog.get(event.deliverableRef.id)
    : undefined;
  const size = d?.sizeBytes ? ` (${formatBytes(d.sizeBytes)})` : "";
  return `${who} produced ${kind.replace(/_/g, " ")}: ${title}${size}`;
};

export const deliverable_revised: EventRenderer = (event, ctx) => {
  const who = nodeName(event.actorNodeId, ctx);
  const title = deliverableName(event);
  return `${who} revised: ${title}`;
};

export const deliverable_approved: EventRenderer = (event, ctx) => {
  const reviewer = nodeName(event.actorNodeId, ctx);
  const title = deliverableName(event);
  return `${reviewer} approved: ${title}`;
};

export const deliverable_published: EventRenderer = (event, ctx) => {
  const who = nodeName(event.actorNodeId, ctx);
  const title = deliverableName(event);
  return `${who} published: ${title}`;
};

export const deliverable_verified: EventRenderer = (event, ctx) => {
  const who = nodeName(event.actorNodeId, ctx);
  const title = deliverableName(event);
  return `${who} verified: ${title}`;
};
