#!/usr/bin/env node
/** Mission Control demo seeder.
 *
 *  Usage: node scripts/seed-mission-control.mjs <paperclipCompanyId>
 *
 *  Writes a fake avatar to disk so the ScopeTree resolves, then fans
 *  out a believable burst of activity through every Phase 1–7 ledger
 *  so the dashboard widgets render real content. */

import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const companyId = process.argv[2];
if (!companyId) {
  console.error("usage: node scripts/seed-mission-control.mjs <companyId>");
  process.exit(1);
}

const root = process.env.WAVEX_OS_STATE_DIR ?? join(homedir(), ".wavex-os");
const avatarDir = join(root, "instances", "default", "avatars", companyId);
const approvalsDir = join(avatarDir, "approvals");

console.log(`[1/7] writing avatar disk state for ${companyId}`);
await mkdir(approvalsDir, { recursive: true });
await writeFile(
  join(avatarDir, "profile.json"),
  JSON.stringify({
    name: "Mission Control Demo",
    role: "general",
    tz: "America/New_York",
    working_hours: ["09:00", "17:00"],
  }, null, 2),
);
await writeFile(
  join(avatarDir, "voice.json"),
  JSON.stringify({ tone: "concise", formality: "casual" }, null, 2),
);
await writeFile(
  join(avatarDir, "paperclip-handoff.json"),
  JSON.stringify({
    paperclipCompanyId: companyId,
    conductorAgentId: "demo-conductor",
    agents: {
      conductor: "demo-conductor",
      gmail: "demo-gmail",
      gcal: "demo-gcal",
      slack: "demo-slack",
    },
  }, null, 2),
);

const { runMigrations, _resetDbCache } = await import("@wavex-os/db");
_resetDbCache();
await runMigrations();

const { logMissionControlActivity } = await import("../src/mission-control/activity-log.js");
const { writeDeliverable } = await import("../src/mission-control/deliverables.js");
const { appendAssignmentLink } = await import("../src/mission-control/assignment-chain.js");
const { declareKpiImpact, recordKpiMeasurement } = await import("../src/mission-control/kpi-impacts.js");
const { upsertChiefConfig, addOriginationRule } = await import("../src/mission-control/chief-of-staff.js");
const { invalidateAllScopeTrees } = await import("../src/mission-control/scope-tree-cache.js");

invalidateAllScopeTrees();

const baseEvent = {
  companyId,
  instanceId: companyId,
  modeContext: "avatar",
};
const CONDUCTOR = "agent:demo-conductor";
const GMAIL = "agent:demo-gmail";
const GCAL = "agent:demo-gcal";
const SLACK = "agent:demo-slack";
const USER = `user:${companyId}`;
const AVATAR_NODE = `avatar:${companyId}`;

// Phase 1 — Activity Stream
console.log("[2/7] seeding Mission Control events");
const eventSeed = [
  { kind: "node_added", actorNodeId: USER, action: "wavex.avatar_handoff.conductor_hired", subjectRef: { kind: "node", id: CONDUCTOR }, costUSD: 0 },
  { kind: "node_added", actorNodeId: CONDUCTOR, action: "wavex.avatar_handoff.subagent_hired", subjectRef: { kind: "node", id: GMAIL, toNodeId: CONDUCTOR }, costUSD: 0 },
  { kind: "node_added", actorNodeId: CONDUCTOR, action: "wavex.avatar_handoff.subagent_hired", subjectRef: { kind: "node", id: GCAL, toNodeId: CONDUCTOR }, costUSD: 0 },
  { kind: "node_added", actorNodeId: CONDUCTOR, action: "wavex.avatar_handoff.subagent_hired", subjectRef: { kind: "node", id: SLACK, toNodeId: CONDUCTOR }, costUSD: 0 },
  { kind: "mode_changed", actorNodeId: USER, action: "mc.mode_changed", subjectRef: { kind: "mode", from: "(none)", to: "avatar" } },
  { kind: "cost_threshold_crossed", actorNodeId: GMAIL, action: "mc.cost.daily_warning", subjectRef: { kind: "cost", tier: "daily" }, costUSD: 4.25, severity: "warning" },
  { kind: "integrity_warning_shown", actorNodeId: GMAIL, action: "mc.integrity.warning_shown", subjectRef: { kind: "integrity", id: GMAIL, reason: "draft references unverified claim about Q4 numbers" }, severity: "warning" },
];
for (const e of eventSeed) {
  await logMissionControlActivity({ ...baseEvent, ...e });
}

// Phase 4 — Assignment chain + Phase 1 task events via the chain
console.log("[3/7] seeding assignment chain");
const tasks = [
  { id: "task-cold-outreach", title: "Cold outreach to 25 leads", from: CONDUCTOR, to: GMAIL, reason: "best fit for email tone" },
  { id: "task-board-deck",    title: "Refresh board deck slides 3-7", from: CONDUCTOR, to: GMAIL, reason: "owns founder voice" },
  { id: "task-reschedule",    title: "Reschedule design review",       from: CONDUCTOR, to: GCAL,  reason: "calendar conflict" },
  { id: "task-team-sync",     title: "Draft weekly team sync agenda",  from: CONDUCTOR, to: SLACK, reason: "slack-native message" },
  { id: "task-pricing",       title: "Update pricing one-pager",       from: CONDUCTOR, to: GMAIL, reason: "loops with sales-ops" },
];
for (const t of tasks) {
  await appendAssignmentLink({
    ...baseEvent,
    taskRefType: "avatar_approval",
    taskRefId: t.id,
    kind: "originated",
    toNodeId: t.from,
    reason: "Originated by conductor",
    taskRef: { id: t.id, title: t.title, status: "originated" },
  });
  await appendAssignmentLink({
    ...baseEvent,
    taskRefType: "avatar_approval",
    taskRefId: t.id,
    kind: "assigned",
    fromNodeId: t.from,
    toNodeId: t.to,
    reason: t.reason,
    taskRef: { id: t.id, title: t.title, status: "assigned" },
  });
  await appendAssignmentLink({
    ...baseEvent,
    taskRefType: "avatar_approval",
    taskRefId: t.id,
    kind: "accepted",
    fromNodeId: t.to,
    toNodeId: t.to,
    taskRef: { id: t.id, title: t.title, status: "accepted" },
  });
}

// One delegated chain so the chain inspector has variety
await appendAssignmentLink({
  ...baseEvent,
  taskRefType: "avatar_approval",
  taskRefId: "task-cold-outreach",
  kind: "delegated",
  fromNodeId: GMAIL,
  toNodeId: SLACK,
  reason: "ping in #sales-ops first",
  taskRef: { id: "task-cold-outreach", title: "Cold outreach to 25 leads", status: "delegated" },
});

// Phase 2 — Deliverables across kinds
console.log("[4/7] seeding deliverables");
const deliverableSeed = [
  {
    taskRefId: "task-cold-outreach",
    producedByNodeId: GMAIL,
    kind: "email_draft",
    title: "Reply: Series A intro from Sequoia",
    description: "Warm intro reply with Q3 metrics + next-step ask",
    previewText: "Hi Roelof,\n\nThanks for the intro — happy to share the Q3 dashboard. Three quick wins...",
    payload: { from: "roelof@sequoiacap.com", subject: "Series A intro" },
  },
  {
    taskRefId: "task-board-deck",
    producedByNodeId: GMAIL,
    kind: "document",
    title: "Board deck — slides 3-7 refresh",
    description: "Quarterly traction + roadmap",
    previewText: "Slide 3: Traction\n- ARR: $4.2M (+22% QoQ)\n- Net retention: 128%\n- ...",
  },
  {
    taskRefId: "task-reschedule",
    producedByNodeId: GCAL,
    kind: "meeting_artifact",
    title: "Invite: Design review v2 (Thu 2pm ET)",
    description: "Rescheduled for Thursday at 2pm ET",
    previewText: "Proposed Thu 2026-05-21 at 14:00 ET. Conflicts cleared with three engineering attendees.",
  },
  {
    taskRefId: "task-team-sync",
    producedByNodeId: SLACK,
    kind: "message_draft",
    title: "#team — weekly sync agenda",
    description: "Five bullets, copy-paste ready",
    previewText: "Hey team — agenda for tomorrow:\n1. Pricing update (5m)\n2. Q3 KR review (10m)\n3. Hiring updates (5m)\n4. Open mic (10m)\n5. Demo time! (15m)",
  },
  {
    taskRefId: "task-pricing",
    producedByNodeId: GMAIL,
    kind: "code",
    title: "pricing-one-pager.md",
    description: "Markdown one-pager",
    previewText: "# Pricing — Q3 2026\n\n## Starter\n- $99/mo\n- up to 5 seats\n\n## Pro\n- $299/mo\n- up to 25 seats\n\n## Enterprise\n- talk to sales",
  },
];
for (const d of deliverableSeed) {
  await writeDeliverable({
    ...baseEvent,
    taskRefType: "avatar_approval",
    taskRef: { id: d.taskRefId, title: d.title, status: "awaiting_review" },
    ...d,
  });
}

// Phase 3 — KPI impacts (declare + measure)
console.log("[5/7] seeding KPI impacts + measurements");
const kpiSeed = [
  { kpiId: "qualified_meetings_per_week", direction: "increase", estimatedDelta: 5, unit: "meetings", confidence: 0.7, rationale: "Cold outreach historically converts ~5 meetings/wk", actualDelta: 5.1, taskRefId: "task-cold-outreach" },
  { kpiId: "qualified_meetings_per_week", direction: "increase", estimatedDelta: 3, unit: "meetings", confidence: 0.5, rationale: "Slack ping shrinks the warm-intro funnel", actualDelta: 1, taskRefId: "task-cold-outreach-2" },
  { kpiId: "weekly_inbox_zero_hours",   direction: "decrease", estimatedDelta: -2, unit: "hours",    confidence: 0.8, rationale: "Avatar handles auto-replies", actualDelta: -1.8, taskRefId: "task-board-deck" },
  { kpiId: "weekly_calendar_conflicts", direction: "decrease", estimatedDelta: -1, unit: "conflicts", confidence: 0.6, rationale: "Calendar agent reshuffles", actualDelta: -1, taskRefId: "task-reschedule" },
];
for (const k of kpiSeed) {
  const impact = await declareKpiImpact({
    companyId,
    taskRefType: "avatar_approval",
    taskRefId: k.taskRefId,
    kpiId: k.kpiId,
    scopeNodeId: GMAIL,
    direction: k.direction,
    estimatedDelta: k.estimatedDelta,
    unit: k.unit,
    timeHorizon: "days",
    confidence: k.confidence,
    rationale: k.rationale,
  });
  if (typeof k.actualDelta === "number") {
    await recordKpiMeasurement({
      impactId: impact.id,
      actualDelta: k.actualDelta,
      modeContext: "avatar",
      recordedByNodeId: CONDUCTOR,
    });
  }
}

// Phase 6 — Chief of Staff config + rules
console.log("[6/7] seeding Chief of Staff config + rules");
await upsertChiefConfig({
  instanceId: companyId,
  mode: "avatar",
  enabled: true,
  responsibilities: ["kpi_monitoring", "capacity_planning", "rebalancing_recommendations"],
  dailyBudgetUSD: 12,
  cooldownMinutes: 30,
  maxOriginationsPerDay: 20,
});
await addOriginationRule({
  instanceId: companyId,
  name: "Qualified meetings slipping below 70%",
  description: "Watch the weekly KPI; nudge if attainment drops",
  triggerKind: "kpi_threshold",
  triggerConfig: { kpiId: "qualified_meetings_per_week", minRatio: 0.7 },
  taskTemplate: {
    title: "Investigate meeting volume slip",
    description: "Why are we below 70% of target?",
    assigneeStrategy: "best_performer_for_kpi",
  },
  enabled: true,
});
await addOriginationRule({
  instanceId: companyId,
  name: "Rebalance if any agent at 2× avg load",
  description: "Spread work when one agent gets pummeled",
  triggerKind: "capacity_imbalance",
  triggerConfig: { imbalanceRatio: 2 },
  taskTemplate: {
    title: "Rebalance agent load",
    description: "Move some work to a lighter agent",
    assigneeStrategy: "least_loaded_in_scope",
  },
  enabled: true,
});

// A few cost-bearing completed events so the Operations widget has bars
console.log("[7/7] seeding cost-bearing completion events");
const completions = [
  { actorNodeId: GMAIL, cost: 1.85 },
  { actorNodeId: GMAIL, cost: 2.10 },
  { actorNodeId: GCAL,  cost: 0.65 },
  { actorNodeId: SLACK, cost: 0.48 },
  { actorNodeId: GMAIL, cost: 1.32 },
];
for (const c of completions) {
  await logMissionControlActivity({
    ...baseEvent,
    kind: "task_completed",
    actorNodeId: c.actorNodeId,
    action: "task.completed",
    subjectRef: { kind: "task" },
    costUSD: c.cost,
  });
}

console.log("\n✓ Mission Control seeded.");
console.log(`  open Paperclip at  http://localhost:5174`);
console.log(`  navigate to the "Mission Control Demo" company`);
console.log(`  every widget on the right column should now show real content`);
