/** System / cross-cutting renderers — cost thresholds, integrity warnings,
 *  mode switches, workspace member adds, department adds. */

import {
  type EventRenderer,
  formatUSD,
  nodeName,
} from "./render-context.js";

export const cost_threshold_crossed: EventRenderer = (event, ctx) => {
  const node = nodeName(event.actorNodeId, ctx);
  const cost = formatUSD(event.costUSD);
  const tier = event.subjectRef.tier as string | undefined;
  return `⚠ ${node} crossed ${tier ?? "cost"} threshold (${cost})`;
};

export const integrity_warning_shown: EventRenderer = (event, ctx) => {
  const target = nodeName(event.subjectRef.id ?? event.actorNodeId, ctx);
  const reason = event.subjectRef.reason ?? "unspecified";
  return `Integrity warning shown to ${target}: ${reason}`;
};

export const integrity_warning_overridden: EventRenderer = (event, ctx) => {
  const who = nodeName(event.actorNodeId, ctx);
  const reason = event.subjectRef.reason ?? "no reason given";
  return `⚠ ${who} overrode integrity warning: ${reason}`;
};

export const mode_changed: EventRenderer = (event, ctx) => {
  const subj = event.subjectRef;
  const from = subj.from as string | undefined;
  const to = subj.to as string | undefined;
  return `Instance mode changed${from && to ? `: ${from} → ${to}` : ""}`;
};

export const workspace_member_added: EventRenderer = (event, ctx) => {
  const member = nodeName(event.subjectRef.memberId, ctx);
  return `${member} joined the workspace`;
};

export const department_added: EventRenderer = (event, ctx) => {
  const dept = nodeName(event.subjectRef.departmentId, ctx);
  return `${dept} department added`;
};
