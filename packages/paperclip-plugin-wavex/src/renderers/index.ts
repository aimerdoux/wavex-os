/** Mission Control — plain-language renderer registry.
 *
 *  One function per ActivityEventKind. Renderers must be pure (no I/O,
 *  no Date.now() — timestamps come from the event), so snapshot tests
 *  don't flake. Unknown event kinds fall back to a generic sentence
 *  that surfaces the raw action so nothing silently disappears.
 *
 *  Mode awareness is achieved via `RenderContext.scopeTree` lookups —
 *  the renderer doesn't branch on mode; it just resolves node IDs, and
 *  the upstream scope tree decides whether a node is named e.g. "Sales
 *  Avatar" (Avatar mode) or "Sales Department Head" (Solo Founder mode).
 */

import type {
  ActivityEvent,
  ActivityEventKind,
} from "@wavex-os/shared/types/mission-control";
import type { EventRenderer, RenderContext } from "./render-context.js";

import * as task from "./task.js";
import * as deliverable from "./deliverable.js";
import * as node from "./node.js";
import * as kpi from "./kpi.js";
import * as chief from "./chief.js";
import * as system from "./system.js";

export { type EventRenderer, type RenderContext } from "./render-context.js";
export {
  nodeName,
  kpiName,
  formatBytes,
  formatUSD,
  formatImpact,
  resolveOriginator,
} from "./render-context.js";

export const renderers: Readonly<Record<ActivityEventKind, EventRenderer>> = {
  // Task
  task_originated: task.task_originated,
  task_assigned: task.task_assigned,
  task_accepted: task.task_accepted,
  task_delegated: task.task_delegated,
  task_awaiting_review: task.task_awaiting_review,
  task_approved: task.task_approved,
  task_rejected: task.task_rejected,
  task_completed: task.task_completed,
  task_failed: task.task_failed,
  task_cancelled: task.task_cancelled,
  // Deliverable
  deliverable_produced: deliverable.deliverable_produced,
  deliverable_revised: deliverable.deliverable_revised,
  deliverable_approved: deliverable.deliverable_approved,
  deliverable_published: deliverable.deliverable_published,
  // Node
  node_added: node.node_added,
  node_archived: node.node_archived,
  node_paused: node.node_paused,
  node_resumed: node.node_resumed,
  node_corrected: node.node_corrected,
  node_flagged: node.node_flagged,
  node_promoted: node.node_promoted,
  // KPI
  kpi_measurement_taken: kpi.kpi_measurement_taken,
  kpi_target_hit: kpi.kpi_target_hit,
  kpi_target_missed: kpi.kpi_target_missed,
  kpi_variance_detected: kpi.kpi_variance_detected,
  kpi_trend_alert: kpi.kpi_trend_alert,
  // Chief
  chief_pattern_detected: chief.chief_pattern_detected,
  chief_origination_blocked: chief.chief_origination_blocked,
  chief_rebalance_recommended: chief.chief_rebalance_recommended,
  // System
  cost_threshold_crossed: system.cost_threshold_crossed,
  integrity_warning_shown: system.integrity_warning_shown,
  integrity_warning_overridden: system.integrity_warning_overridden,
  mode_changed: system.mode_changed,
  workspace_member_added: system.workspace_member_added,
  department_added: system.department_added,
};

/** Render an ActivityEvent to a plain-language sentence. Returns the
 *  event's `plainLanguageSentence` field if set (server-rendered), else
 *  applies the registered renderer for the kind, else falls back to a
 *  generic "Actor did X" sentence. */
export function renderEvent(event: ActivityEvent, ctx: RenderContext): string {
  if (event.plainLanguageSentence && event.plainLanguageSentence.length > 0) {
    return event.plainLanguageSentence;
  }
  const r = renderers[event.kind];
  if (r) return r(event, ctx);
  // Fallback for kinds we haven't mapped yet (or rows from older Paperclip
  // versions). Surfaces the raw action so nothing silently vanishes.
  const actor = event.actorNodeId;
  return `${actor} → ${event.action}`;
}
