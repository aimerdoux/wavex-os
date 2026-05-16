/** Chief of Staff renderers — pattern detection, origination blocks,
 *  rebalancing recommendations. */

import { type EventRenderer, nodeName } from "./render-context.js";

export const chief_pattern_detected: EventRenderer = (event, ctx) => {
  const chief = nodeName(event.actorNodeId, ctx);
  const pattern = event.subjectRef.patternDescription ?? "(unspecified pattern)";
  return `${chief} detected pattern: ${pattern}`;
};

export const chief_origination_blocked: EventRenderer = (event, ctx) => {
  const chief = nodeName(event.actorNodeId, ctx);
  const reason = event.subjectRef.reason ?? "constraint";
  const wouldHaveAssignedTo = event.subjectRef.toNodeId
    ? ` (would have assigned to ${nodeName(event.subjectRef.toNodeId, ctx)})`
    : "";
  return `${chief} skipped origination — ${reason}${wouldHaveAssignedTo}`;
};

export const chief_rebalance_recommended: EventRenderer = (event, ctx) => {
  const chief = nodeName(event.actorNodeId, ctx);
  const summary =
    event.subjectRef.summary ??
    event.subjectRef.patternDescription ??
    "load imbalance across nodes";
  return `${chief} recommends rebalance: ${String(summary)}`;
};
