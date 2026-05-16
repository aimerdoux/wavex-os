/** Mission Control zod schemas — runtime validation for the types in
 *  `../types/mission-control.ts`. Each exported schema MUST stay in lockstep
 *  with the corresponding TS interface; mismatches surface as type errors
 *  at the call site of `.parse()` because we annotate the schemas with
 *  `z.ZodType<MyType>` where helpful.
 *
 *  Used by:
 *    - route validators (e.g. POST body parsing in mission-control routes)
 *    - JSONL log readers (one parse per line to catch corruption)
 *    - the migration backfill (validates synthesized Deliverable rows before insert)
 */

import { z } from "zod";

// ─── Mode + root scope ──────────────────────────────────────────────────

export const paperclipMode = z.enum(["avatar", "solo_founder", "hybrid"]);

export const rootScope = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("avatar_roster"), ownerId: z.string() }),
  z.object({
    kind: z.literal("simulated_org"),
    ownerId: z.string(),
    orgName: z.string(),
  }),
  z.object({
    kind: z.literal("workspace"),
    workspaceId: z.string(),
    name: z.string(),
  }),
]);

export const paperclipInstance = z.object({
  instanceId: z.string(),
  mode: paperclipMode,
  rootScope,
  createdAt: z.string(),
});

// ─── Scope tree ─────────────────────────────────────────────────────────

export const scopeKind = z.enum([
  "user",
  "avatar_roster",
  "avatar",
  "org",
  "department",
  "role",
  "simulated_agent",
  "workspace",
  "team",
  "human_member",
  "workspace_agent",
  "chief_of_staff",
]);

export const scopeMetadata = z.object({
  iconRef: z.string().optional(),
  colorHint: z.string().optional(),
  capacityScore: z.number().min(0).max(1).optional(),
  activeTaskCount: z.number().int().min(0),
  kpisOwned: z.array(z.string()),
  costThisPeriodUSD: z.number().min(0),
});

export const scopeNode = z.object({
  id: z.string(),
  kind: scopeKind,
  name: z.string(),
  parentId: z.string().optional(),
  childIds: z.array(z.string()),
  metadata: scopeMetadata,
});

// ─── Task ───────────────────────────────────────────────────────────────

export const taskStatus = z.enum([
  "originated",
  "assigned",
  "accepted",
  "delegated",
  "awaiting_review",
  "approved",
  "rejected",
  "completed",
  "failed",
  "cancelled",
]);

export const taskOriginator = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), userId: z.string() }),
  z.object({
    kind: z.literal("workspace_member"),
    memberId: z.string(),
    workspaceId: z.string(),
  }),
  z.object({
    kind: z.literal("chief_of_staff"),
    chiefId: z.string(),
    triggeringPattern: z.string(),
  }),
  z.object({
    kind: z.literal("agent_delegation"),
    parentTaskId: z.string(),
    delegatingNodeId: z.string(),
  }),
  z.object({
    kind: z.literal("department_head_delegation"),
    parentTaskId: z.string(),
    departmentId: z.string(),
  }),
  z.object({ kind: z.literal("scheduled"), cronExpression: z.string() }),
  z.object({
    kind: z.literal("event_triggered"),
    eventSource: z.string(),
    eventId: z.string(),
  }),
]);

export const assignmentLink = z.object({
  fromNodeId: z.string(),
  toNodeId: z.string(),
  assignedAt: z.string(),
  reason: z.string(),
  acceptedAt: z.string().optional(),
  rejectedAt: z.string().optional(),
  rejectionReason: z.string().optional(),
});

export const task = z.object({
  id: z.string(),
  instanceId: z.string(),
  modeContext: paperclipMode,
  parentTaskId: z.string().optional(),
  rootTaskId: z.string(),
  originatedBy: taskOriginator,
  originatedAt: z.string(),
  originationReason: z.string(),
  currentAssigneeNodeId: z.string(),
  assignmentChain: z.array(assignmentLink),
  title: z.string(),
  description: z.string(),
  successCriteria: z.array(z.string()),
  expectedKpiImpacts: z.array(z.string()),
  kpiImpactJustifiedAsNone: z.string().optional(),
  status: taskStatus,
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  estimatedCostUSD: z.number().min(0),
  estimatedDurationMs: z.number().int().min(0),
  actualCostUSD: z.number().min(0).optional(),
  actualDurationMs: z.number().int().min(0).optional(),
  deliverables: z.array(z.string()),
  capabilityId: z.string().optional(),
  workflowId: z.string().optional(),
  avatarId: z.string().optional(),
  workspaceId: z.string().optional(),
  departmentId: z.string().optional(),
});

// ─── Deliverable ────────────────────────────────────────────────────────

export const deliverableKind = z.enum([
  "document",
  "email_draft",
  "message_draft",
  "code",
  "data_artifact",
  "design_asset",
  "audio_artifact",
  "database_record",
  "configuration",
  "meeting_artifact",
  "report",
  "forecast",
]);

export const deliverableStatus = z.enum([
  "draft",
  "in_review",
  "approved",
  "rejected",
  "published",
]);

export const taskRef = z.object({
  id: z.string(),
  title: z.string(),
  status: taskStatus,
});

export const kpiRef = z.object({ id: z.string(), name: z.string() });

export const deliverableRef = z.object({
  id: z.string(),
  title: z.string(),
  kind: deliverableKind,
});

export const deliverable = z.object({
  id: z.string(),
  instanceId: z.string(),
  taskId: z.string(),
  producedByNodeId: z.string(),
  producedAt: z.string(),
  kind: deliverableKind,
  diskPath: z.string(),
  relPath: z.string(),
  sizeBytes: z.number().int().min(0),
  contentHash: z.string(),
  title: z.string(),
  description: z.string(),
  previewText: z.string().optional(),
  mimeType: z.string(),
  inputsRef: z.array(z.string()).optional(),
  templateUsed: z.string().optional(),
  promptUsedRef: z.string().optional(),
  status: deliverableStatus,
  reviewedByNodeId: z.string().optional(),
  reviewedAt: z.string().optional(),
  reviewNotes: z.string().optional(),
  taskRef,
  expectedKpiImpactRef: z.string().optional(),
});

// ─── ExpectedKpiImpact ──────────────────────────────────────────────────

export const expectedKpiImpact = z.object({
  id: z.string(),
  taskId: z.string(),
  kpiId: z.string(),
  scopeNodeId: z.string(),
  direction: z.enum(["increase", "decrease", "maintain"]),
  estimatedDelta: z.number(),
  unit: z.string(),
  timeHorizon: z.enum(["immediate", "hours", "days", "weeks"]),
  confidence: z.number().min(0).max(1),
  rationale: z.string(),
  basedOnPriorTasks: z.array(z.string()).optional(),
  measureAt: z.string(),
  actualDelta: z.number().optional(),
  measurementMethod: z.enum(["auto_kpi_query", "manual_input", "inferred"]),
  measurementCompletedAt: z.string().optional(),
  variance: z.number().optional(),
});

// ─── KPI ────────────────────────────────────────────────────────────────

export const kpiSource = z.object({
  kind: z.enum(["auto_metric", "manual_input", "external_api", "inferred"]),
  queryRef: z.string().optional(),
  externalProviderId: z.string().optional(),
  refreshIntervalMinutes: z.number().int().min(1).optional(),
});

export const kpiDataPoint = z.object({
  at: z.string(),
  value: z.number(),
  source: z.enum(["measurement", "rollup", "manual", "imported"]),
});

export const kpi = z.object({
  id: z.string(),
  instanceId: z.string(),
  name: z.string(),
  type: z.enum(["output", "quality", "outcome"]),
  unit: z.string(),
  target: z.number(),
  window: z.enum(["day", "week", "month", "quarter"]),
  source: kpiSource,
  ownerNodeIds: z.array(z.string()),
  rollupParentKpiId: z.string().optional(),
  current: z.number().optional(),
  history: z.array(kpiDataPoint),
});

// ─── ActivityEvent ──────────────────────────────────────────────────────

export const activityEventKind = z.enum([
  "task_originated",
  "task_assigned",
  "task_accepted",
  "task_delegated",
  "task_awaiting_review",
  "task_approved",
  "task_rejected",
  "task_completed",
  "task_failed",
  "task_cancelled",
  "deliverable_produced",
  "deliverable_revised",
  "deliverable_approved",
  "deliverable_published",
  "node_paused",
  "node_resumed",
  "node_corrected",
  "node_flagged",
  "node_promoted",
  "node_added",
  "node_archived",
  "kpi_measurement_taken",
  "kpi_target_hit",
  "kpi_target_missed",
  "kpi_variance_detected",
  "kpi_trend_alert",
  "chief_pattern_detected",
  "chief_origination_blocked",
  "chief_rebalance_recommended",
  "cost_threshold_crossed",
  "integrity_warning_shown",
  "integrity_warning_overridden",
  "mode_changed",
  "workspace_member_added",
  "department_added",
]);

/** Subject ref is loose by design — different event kinds carry different
 *  payload fields. Schema preserves known keys + allows passthrough so
 *  renderers can pull e.g. `subjectRef.toNodeId` without an exhaustive
 *  discriminated union. */
export const subjectRef = z
  .object({
    kind: z.string(),
    id: z.string().optional(),
    title: z.string().optional(),
    toNodeId: z.string().optional(),
    reason: z.string().optional(),
    patternDescription: z.string().optional(),
    memberId: z.string().optional(),
    departmentId: z.string().optional(),
  })
  .catchall(z.unknown());

export const activityEvent = z.object({
  id: z.string(),
  instanceId: z.string(),
  at: z.string(),
  kind: activityEventKind,
  modeContext: paperclipMode,
  scopeChain: z.array(z.string()),
  actorNodeId: z.string(),
  action: z.string(),
  subjectRef,
  taskRef: taskRef.optional(),
  kpiRef: kpiRef.optional(),
  deliverableRef: deliverableRef.optional(),
  costUSD: z.number().min(0).optional(),
  expectedImpact: z.string().optional(),
  plainLanguageSentence: z.string(),
  severity: z.enum(["info", "notable", "warning", "critical"]),
  detailUrl: z.string(),
  visibleToScopeNodeIds: z.array(z.string()).optional(),
});

// ─── Chief of Staff config ──────────────────────────────────────────────

export const chiefResponsibility = z.enum([
  "route_inbound",
  "daily_briefing",
  "conflict_resolution",
  "kpi_monitoring",
  "capacity_planning",
  "cross_node_orchestration",
  "pattern_detection",
  "rebalancing_recommendations",
]);

export const chiefOriginationRule = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  triggerKind: z.enum([
    "kpi_threshold",
    "kpi_variance",
    "schedule",
    "pattern",
    "capacity_imbalance",
  ]),
  triggerConfig: z.record(z.unknown()),
  taskTemplate: z.object({
    title: z.string(),
    description: z.string(),
    expectedKpiImpactTemplate: expectedKpiImpact.partial().optional(),
    assigneeStrategy: z.enum([
      "best_performer_for_kpi",
      "least_loaded_in_scope",
      "explicit_node_id",
    ]),
    explicitAssigneeNodeId: z.string().optional(),
  }),
  enabled: z.boolean(),
});

export const scopeOfAuthority = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("avatar_roster"),
    avatarIds: z.array(z.string()),
  }),
  z.object({
    kind: z.literal("whole_org"),
    departmentIds: z.array(z.string()),
  }),
  z.object({
    kind: z.literal("workspace"),
    workspaceId: z.string(),
    teamIds: z.array(z.string()),
    humanMembersInScope: z.enum([
      "observe_only",
      "can_delegate_to_with_consent",
    ]),
  }),
]);

export const chiefOfStaffConfig = z.object({
  instanceId: z.string(),
  enabled: z.boolean(),
  mode: paperclipMode,
  responsibilities: z.array(chiefResponsibility),
  originationRules: z.array(chiefOriginationRule),
  scopeOfAuthority,
  dailyBudgetUSD: z.number().min(0),
  cooldownMinutes: z.number().int().min(0),
  maxOriginationsPerDay: z.number().int().min(0),
});
