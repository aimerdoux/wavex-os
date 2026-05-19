/** Mission Control — action → ActivityEventKind map.
 *
 *  Paperclip's `activity_log` table stores an opaque `action` string per
 *  row (e.g. `avatar.gmail.draft_created`, `agent_hired`, `kpi_snapshot_recorded`).
 *  Mission Control's universal model uses `ActivityEventKind` (e.g.
 *  `deliverable_produced`, `node_added`, `kpi_measurement_taken`).
 *
 *  This map projects existing action strings into universal event kinds.
 *  Anything not in the map is rendered as a generic `info` event with the
 *  raw action surfaced.
 *
 *  We avoid touching the vendored `packages/core/server/src/services/activity-log.ts`
 *  `ACTIVITY_ACTION_TO_PLUGIN_EVENT` map; this lives in the wavex layer
 *  and gets consumed by the activity-query API + plugin worker.
 *
 *  When NEW wavex-side `logActivity()` calls land (Phase 1.6), prefer
 *  actions that map 1:1 to MC event kinds. Cross-package action strings
 *  (Paperclip-emitted) stay opaque and get translated here on read.
 */

import type { ActivityEventKind } from "@wavex-os/shared/types/mission-control";

/** Hard-coded translations from existing or expected action strings to
 *  Mission Control event kinds. Add a row when a new action ships. */
export const ACTION_TO_EVENT_KIND: Readonly<Record<string, ActivityEventKind>> = {
  // ── Paperclip-side actions (read-only translation) ─────────────────
  agent_hired: "node_added",
  agent_paused: "node_paused",
  agent_resumed: "node_resumed",
  agent_archived: "node_archived",
  agent_promoted: "node_promoted",
  agent_flagged: "node_flagged",
  agent_corrected: "node_corrected",

  issue_created: "task_originated",
  issue_assigned: "task_assigned",
  issue_accepted: "task_accepted",
  issue_delegated: "task_delegated",
  issue_awaiting_review: "task_awaiting_review",
  issue_completed: "task_completed",
  issue_failed: "task_failed",
  issue_cancelled: "task_cancelled",
  issue_document_created: "deliverable_produced",
  issue_document_updated: "deliverable_revised",

  approval_approved: "task_approved",
  approval_rejected: "task_rejected",
  approval_revision_requested: "deliverable_revised",

  kpi_snapshot_recorded: "kpi_measurement_taken",
  kpi_target_hit: "kpi_target_hit",
  kpi_target_missed: "kpi_target_missed",

  budget_soft_threshold_crossed: "cost_threshold_crossed",
  budget_hard_threshold_crossed: "cost_threshold_crossed",

  // ── Wavex-side actions (emitted by op-omega-server) ────────────────
  // Avatar runners. Phase 1.6 adds `logActivity()` calls with these.
  "avatar.gmail.draft_created": "deliverable_produced",
  "avatar.gmail.draft_sent": "deliverable_published",
  "avatar.outlook.draft_created": "deliverable_produced",
  "avatar.outlook.draft_sent": "deliverable_published",
  "avatar.google_calendar.draft_created": "deliverable_produced",
  "avatar.microsoft_calendar.draft_created": "deliverable_produced",
  "avatar.slack.digest_produced": "deliverable_produced",
  "avatar.approval.decided": "task_approved",
  "avatar.approval.auto_approved": "task_approved",
  "avatar.skill.paused": "node_paused",
  "avatar.skill.resumed": "node_resumed",

  // Bridge events (Paperclip handoff lifecycle).
  "wavex.paperclip_handoff.agent_hired": "node_added",
  "wavex.paperclip_handoff.agent_skipped": "node_archived",
  "wavex.avatar_handoff.conductor_hired": "node_added",
  "wavex.avatar_handoff.subagent_hired": "node_added",

  // Mission-Control-originated events (Phase 6+).
  "mc.chief.pattern_detected": "chief_pattern_detected",
  "mc.chief.origination_blocked": "chief_origination_blocked",
  "mc.chief.rebalance_recommended": "chief_rebalance_recommended",
  "mc.kpi.variance_detected": "kpi_variance_detected",
  "mc.kpi.trend_alert": "kpi_trend_alert",
};

/** Translate a Paperclip / wavex action string to its Mission Control
 *  event kind, or null if the action isn't mapped. Callers that get null
 *  should render the event as a generic informational entry with the raw
 *  action surfaced (so unknowns don't disappear from the stream). */
export function actionToEventKind(action: string): ActivityEventKind | null {
  return ACTION_TO_EVENT_KIND[action] ?? null;
}

/** Severity hints by event kind. Renderers + UI tile colors use this when
 *  the raw activity row doesn't carry a severity field of its own. */
export function defaultSeverityForKind(
  kind: ActivityEventKind,
): "info" | "notable" | "warning" | "critical" {
  switch (kind) {
    case "task_failed":
    case "kpi_target_missed":
    case "kpi_variance_detected":
    case "cost_threshold_crossed":
    case "chief_origination_blocked":
    case "integrity_warning_shown":
      return "warning";
    case "integrity_warning_overridden":
      return "critical";
    case "task_originated":
    case "task_completed":
    case "task_approved":
    case "deliverable_produced":
    case "deliverable_approved":
    case "deliverable_published":
    case "kpi_target_hit":
    case "chief_pattern_detected":
    case "chief_rebalance_recommended":
    case "kpi_trend_alert":
    case "node_added":
    case "node_promoted":
      return "notable";
    default:
      return "info";
  }
}
