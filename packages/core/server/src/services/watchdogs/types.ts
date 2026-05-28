export type ExecutionProfileFallbackPolicy =
  | "manual"
  | "on_quota"
  | "on_provider_error"
  | "on_watchdog_trigger";

export interface ExecutionProfileTarget {
  adapterType: string;
  model: string;
  cliChannel?: string | null;
  versionTag?: string | null;
  maxAttempts?: number | null;
  metadata?: Record<string, unknown>;
}

export interface ExecutionProfile {
  id: string;
  displayName: string;
  description?: string;
  targets: ExecutionProfileTarget[];
  fallbackPolicy: ExecutionProfileFallbackPolicy;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export type ExecutionContractScopeKind =
  | "issue"
  | "agent"
  | "workflow_step"
  | "goal"
  | "conversation";

export interface ExecutionContractScope {
  kind: ExecutionContractScopeKind;
  refId: string;
}

export interface DeliverableExpectation {
  kind: string;
  required: boolean;
  minCount?: number;
  validatorIds?: string[];
  description?: string;
}

export interface ExecutionEscalationPolicy {
  ownerRole?: string | null;
  wakeReason: string;
  maxAutomaticRetries: number;
  createEvaluationIssue: boolean;
}

export interface ExecutionContract {
  id: string;
  companyId?: string | null;
  scope: ExecutionContractScope;
  allowedProfileIds: string[];
  fallbackProfileId?: string | null;
  expectedDeliverables: DeliverableExpectation[];
  freshnessSlaMs?: number | null;
  validatorIds?: string[];
  escalation: ExecutionEscalationPolicy;
  metadata?: Record<string, unknown>;
}

export type WatchdogSeverity = "info" | "warn" | "crit";

export type WatchdogSignalType =
  | "run.silent"
  | "run.completed"
  | "run.failed"
  | "deliverable.missing"
  | "deliverable.validation_failed"
  | "budget.threshold_crossed"
  | "cost.anomaly";

interface WatchdogSignalBase {
  type: WatchdogSignalType;
  companyId: string;
  occurredAt: Date;
  issueId?: string | null;
  agentId?: string | null;
  runId?: string | null;
  conversationId?: string | null;
  profileId?: string | null;
  provider?: string | null;
  metadata?: Record<string, unknown>;
}

export interface RunSilentSignal extends WatchdogSignalBase {
  type: "run.silent";
  silenceAgeMs: number;
  suspicionThresholdMs: number;
  criticalThresholdMs: number;
}

export interface RunCompletedSignal extends WatchdogSignalBase {
  type: "run.completed";
  outcome: "succeeded" | "failed" | "cancelled" | "timed_out";
  producedDeliverableKinds?: string[];
}

export interface RunFailedSignal extends WatchdogSignalBase {
  type: "run.failed";
  errorCode?: string | null;
  errorMessage?: string | null;
}

export interface DeliverableMissingSignal extends WatchdogSignalBase {
  type: "deliverable.missing";
  missingKinds: string[];
}

export interface DeliverableValidationFailedSignal extends WatchdogSignalBase {
  type: "deliverable.validation_failed";
  deliverableKind: string;
  validatorId?: string | null;
  failureReason: string;
}

export interface BudgetThresholdCrossedSignal extends WatchdogSignalBase {
  type: "budget.threshold_crossed";
  threshold: "soft" | "hard";
  utilizationPct: number;
}

export interface CostAnomalySignal extends WatchdogSignalBase {
  type: "cost.anomaly";
  scopeKind: ExecutionContractScopeKind | "fleet";
  scopeRef: string;
  observedCostCents: number;
  baselineCostCents: number;
  deviationPct: number;
}

export type WatchdogSignal =
  | RunSilentSignal
  | RunCompletedSignal
  | RunFailedSignal
  | DeliverableMissingSignal
  | DeliverableValidationFailedSignal
  | BudgetThresholdCrossedSignal
  | CostAnomalySignal;

export type WatchdogActionType =
  | "create_evaluation_issue"
  | "request_issue_wakeup"
  | "switch_execution_profile"
  | "pause_agent"
  | "pause_fleet"
  | "escalate_to_role"
  | "snooze_rule";

export interface WatchdogAction {
  type: WatchdogActionType;
  payload?: Record<string, unknown>;
}

export interface WatchdogDecision {
  ruleId: string;
  severity: WatchdogSeverity;
  reason: string;
  contractId?: string | null;
  actions: WatchdogAction[];
  evidence?: Record<string, unknown>;
}

export interface WatchdogEvaluationContext {
  now: Date;
  signal: WatchdogSignal;
  contract: ExecutionContract | null;
  profiles: ReadonlyMap<string, ExecutionProfile>;
}

export interface WatchdogRule {
  id: string;
  displayName: string;
  description: string;
  subscribesTo: WatchdogSignalType[];
  severity: WatchdogSeverity;
  evaluate(ctx: WatchdogEvaluationContext): WatchdogDecision[];
}
