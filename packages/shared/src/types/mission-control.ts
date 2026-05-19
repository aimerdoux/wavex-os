/** Mission Control — universal accountability + observability model.
 *
 *  This file is the source of truth for the data shapes exchanged between
 *  the wavex server (`@wavex-os/op-omega-server`), the Paperclip plugin
 *  (`@wavex-os/paperclip-plugin-wavex`), and any future consumer. All types
 *  are read-only on disk; runtime validators live in `../schemas/mission-control.ts`.
 *
 *  Naming convention: camelCase across the wire (JSON payloads + JSONL log
 *  rows). Drizzle column names (snake_case) are mapped in the table
 *  definitions in `@wavex-os/db`, not here.
 *
 *  Mode reality (per investigation): Paperclip lands users on one of two
 *  effective dashboards — Avatar (`/avatar/:id`) or Company (`/?companyId=X`,
 *  whether Solo Founder or Hybrid). The `PaperclipMode` enum keeps all three
 *  for spec compliance; the `RootScope` discriminator captures the actual
 *  data shape. Hybrid is Solo Founder + a `scope.json` filter + optional
 *  workspace.members[].
 */

// ─── Mode + root scope ──────────────────────────────────────────────────

export type PaperclipMode = "avatar" | "solo_founder" | "hybrid";

export interface PaperclipInstance {
  instanceId: string;
  mode: PaperclipMode;
  rootScope: RootScope;
  createdAt: string;
}

export type RootScope =
  | { kind: "avatar_roster"; ownerId: string }
  | { kind: "simulated_org"; ownerId: string; orgName: string }
  | { kind: "workspace"; workspaceId: string; name: string };

// ─── Scope tree (mode-aware grouping) ───────────────────────────────────

export interface ScopeNode {
  id: string;
  kind: ScopeKind;
  name: string;
  /** Stable 8-char short id derived from `id` (last 8 chars of a UUID,
   *  or the part after the last `:` for slot-namespaced ids). Always
   *  populated by the ScopeTree builder so widgets never need to fall
   *  back to the raw UUID for display. */
  shortId: string;
  /** Kebab-case form of `name`. Useful for URL-safe deep links + as a
   *  stable display tag. Always populated by the builder. */
  slug: string;
  parentId?: string;
  childIds: string[];
  metadata: ScopeMetadata;
  /** Optional cross-store alias: the Paperclip `agents` table primary
   *  key when this node mirrors a real agent. Widgets may use this to
   *  fetch the agent profile via the host's plugin bridge. */
  paperclipAgentId?: string;
}

export type ScopeKind =
  // Avatar mode
  | "user"
  | "avatar_roster"
  | "avatar"
  // Solo Founder mode
  | "org"
  | "department"
  | "role"
  | "simulated_agent"
  // Hybrid mode
  | "workspace"
  | "team"
  | "human_member"
  | "workspace_agent"
  // Universal
  | "chief_of_staff";

export interface ScopeMetadata {
  iconRef?: string;
  colorHint?: string;
  capacityScore?: number;
  activeTaskCount: number;
  kpisOwned: string[];
  costThisPeriodUSD: number;
}

// ─── Task (universal) ──────────────────────────────────────────────────

export interface Task {
  id: string;
  instanceId: string;
  modeContext: PaperclipMode;
  parentTaskId?: string;
  rootTaskId: string;

  // Origination
  originatedBy: TaskOriginator;
  originatedAt: string;
  originationReason: string;

  // Assignment
  currentAssigneeNodeId: string;
  assignmentChain: AssignmentLink[];

  // Definition
  title: string;
  description: string;
  successCriteria: string[];

  // KPI linkage
  expectedKpiImpacts: string[]; // ExpectedKpiImpact.id refs
  kpiImpactJustifiedAsNone?: string;

  // Execution
  status: TaskStatus;
  startedAt?: string;
  completedAt?: string;
  estimatedCostUSD: number;
  estimatedDurationMs: number;
  actualCostUSD?: number;
  actualDurationMs?: number;

  // Output
  deliverables: string[]; // Deliverable.id refs

  // Linkage
  capabilityId?: string;
  workflowId?: string;
  avatarId?: string;
  workspaceId?: string;
  departmentId?: string;
}

export type TaskOriginator =
  | { kind: "user"; userId: string }
  | { kind: "workspace_member"; memberId: string; workspaceId: string }
  | { kind: "chief_of_staff"; chiefId: string; triggeringPattern: string }
  | { kind: "agent_delegation"; parentTaskId: string; delegatingNodeId: string }
  | { kind: "department_head_delegation"; parentTaskId: string; departmentId: string }
  | { kind: "scheduled"; cronExpression: string }
  | { kind: "event_triggered"; eventSource: string; eventId: string };

export interface AssignmentLink {
  fromNodeId: string;
  toNodeId: string;
  assignedAt: string;
  reason: string;
  acceptedAt?: string;
  rejectedAt?: string;
  rejectionReason?: string;
}

export type TaskStatus =
  | "originated"
  | "assigned"
  | "accepted"
  | "delegated"
  | "awaiting_review"
  | "approved"
  | "rejected"
  | "completed"
  | "failed"
  | "cancelled";

// ─── Deliverable (universal) ────────────────────────────────────────────

export interface Deliverable {
  id: string;
  instanceId: string;
  taskId: string;
  producedByNodeId: string;
  producedAt: string;
  kind: DeliverableKind;

  // Where it lives
  diskPath: string;
  relPath: string;
  sizeBytes: number;
  contentHash: string;

  // What it is
  title: string;
  description: string;
  previewText?: string;
  mimeType: string;

  // Provenance
  inputsRef?: string[];
  templateUsed?: string;
  promptUsedRef?: string;

  // Status
  status: DeliverableStatus;
  reviewedByNodeId?: string;
  reviewedAt?: string;
  reviewNotes?: string;

  // Linkage
  taskRef: TaskRef;
  expectedKpiImpactRef?: string;
}

export type DeliverableStatus =
  | "draft"
  | "in_review"
  | "approved"
  | "rejected"
  | "published";

export type DeliverableKind =
  | "document"
  | "email_draft"
  | "message_draft"
  | "code"
  | "data_artifact"
  | "design_asset"
  | "audio_artifact"
  | "database_record"
  | "configuration"
  | "meeting_artifact"
  | "report"
  | "forecast";

export interface TaskRef {
  id: string;
  title: string;
  status: TaskStatus;
}

export interface KpiRef {
  id: string;
  name: string;
}

export interface DeliverableRef {
  id: string;
  title: string;
  kind: DeliverableKind;
}

// ─── ExpectedKpiImpact (universal) ──────────────────────────────────────

export interface ExpectedKpiImpact {
  id: string;
  taskId: string;
  kpiId: string;
  scopeNodeId: string;

  direction: "increase" | "decrease" | "maintain";
  estimatedDelta: number;
  unit: string;
  timeHorizon: "immediate" | "hours" | "days" | "weeks";
  confidence: number;

  rationale: string;
  basedOnPriorTasks?: string[];

  measureAt: string;
  actualDelta?: number;
  measurementMethod: "auto_kpi_query" | "manual_input" | "inferred";
  measurementCompletedAt?: string;
  variance?: number;
}

// ─── KPI (universal, mode-scoped) ───────────────────────────────────────

export interface KPI {
  id: string;
  instanceId: string;
  name: string;
  type: "output" | "quality" | "outcome";
  unit: string;
  target: number;
  window: "day" | "week" | "month" | "quarter";
  source: KPISource;

  // Ownership (mode-aware)
  ownerNodeIds: string[];
  rollupParentKpiId?: string;

  // Values
  current?: number;
  history: KPIDataPoint[];
}

export interface KPISource {
  kind: "auto_metric" | "manual_input" | "external_api" | "inferred";
  queryRef?: string;
  externalProviderId?: string;
  refreshIntervalMinutes?: number;
}

export interface KPIDataPoint {
  at: string;
  value: number;
  source: "measurement" | "rollup" | "manual" | "imported";
}

// ─── ActivityEvent (universal — the bus) ────────────────────────────────

export interface ActivityEvent {
  id: string;
  instanceId: string;
  at: string;
  kind: ActivityEventKind;

  // Mode context
  modeContext: PaperclipMode;
  scopeChain: string[];

  // What happened
  actorNodeId: string;
  action: string;
  subjectRef: SubjectRef;

  // Context
  taskRef?: TaskRef;
  kpiRef?: KpiRef;
  deliverableRef?: DeliverableRef;

  // Cost & impact
  costUSD?: number;
  expectedImpact?: string;

  // Display
  plainLanguageSentence: string;
  severity: "info" | "notable" | "warning" | "critical";

  // Drill-down
  detailUrl: string;

  // Permissions (for Hybrid mode)
  visibleToScopeNodeIds?: string[];
}

export type ActivityEventKind =
  // Task lifecycle
  | "task_originated"
  | "task_assigned"
  | "task_accepted"
  | "task_delegated"
  | "task_awaiting_review"
  | "task_approved"
  | "task_rejected"
  | "task_completed"
  | "task_failed"
  | "task_cancelled"
  // Deliverable lifecycle
  | "deliverable_produced"
  | "deliverable_revised"
  | "deliverable_approved"
  | "deliverable_published"
  // Node lifecycle
  | "node_paused"
  | "node_resumed"
  | "node_corrected"
  | "node_flagged"
  | "node_promoted"
  | "node_added"
  | "node_archived"
  // KPI events
  | "kpi_measurement_taken"
  | "kpi_target_hit"
  | "kpi_target_missed"
  | "kpi_variance_detected"
  | "kpi_trend_alert"
  // Chief events
  | "chief_pattern_detected"
  | "chief_origination_blocked"
  | "chief_rebalance_recommended"
  // System events
  | "cost_threshold_crossed"
  | "integrity_warning_shown"
  | "integrity_warning_overridden"
  | "mode_changed"
  | "workspace_member_added"
  | "department_added";

/** Discriminated subject reference — what the event is *about*. Loose by
 *  design so renderers can pull the right field per event kind without
 *  enforcing every event to have a structurally-typed payload. */
export interface SubjectRef {
  kind: string;
  id?: string;
  title?: string;
  toNodeId?: string;
  reason?: string;
  patternDescription?: string;
  memberId?: string;
  departmentId?: string;
  // Allow renderer-specific fields without losing type safety on known ones
  [key: string]: unknown;
}

// ─── Chief of Staff config ──────────────────────────────────────────────

export interface ChiefOfStaffConfig {
  instanceId: string;
  enabled: boolean;
  mode: PaperclipMode;

  responsibilities: ChiefResponsibility[];
  originationRules: ChiefOriginationRule[];
  scopeOfAuthority: ScopeOfAuthority;

  dailyBudgetUSD: number;
  cooldownMinutes: number;
  maxOriginationsPerDay: number;
}

export type ChiefResponsibility =
  | "route_inbound"
  | "daily_briefing"
  | "conflict_resolution"
  | "kpi_monitoring"
  | "capacity_planning"
  | "cross_node_orchestration"
  | "pattern_detection"
  | "rebalancing_recommendations";

export interface ChiefOriginationRule {
  id: string;
  name: string;
  description: string;
  triggerKind:
    | "kpi_threshold"
    | "kpi_variance"
    | "schedule"
    | "pattern"
    | "capacity_imbalance";
  triggerConfig: Record<string, unknown>;
  taskTemplate: {
    title: string;
    description: string;
    expectedKpiImpactTemplate?: Partial<ExpectedKpiImpact>;
    assigneeStrategy:
      | "best_performer_for_kpi"
      | "least_loaded_in_scope"
      | "explicit_node_id";
    explicitAssigneeNodeId?: string;
  };
  enabled: boolean;
}

/** Brief-compat alias. The Mission Control v2 spec calls these
 *  ChiefRule; the existing codebase calls them ChiefOriginationRule.
 *  Re-export both names so either import works. */
export type ChiefRule = ChiefOriginationRule;

export type ScopeOfAuthority =
  | { kind: "avatar_roster"; avatarIds: string[] }
  | { kind: "whole_org"; departmentIds: string[] }
  | {
      kind: "workspace";
      workspaceId: string;
      teamIds: string[];
      humanMembersInScope:
        | "observe_only"
        | "can_delegate_to_with_consent";
    };
