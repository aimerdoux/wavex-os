import { describe, expect, it } from "vitest";
import {
  createDeliverableMissingWatchdogRule,
  createQuotaAndCostWatchdogRule,
  createRunLivenessWatchdogRule,
} from "./defaults.js";
import { createWatchdogRegistry, snapshotWatchdogRegistry } from "./registry.js";
import type { BudgetThresholdCrossedSignal, ExecutionContract, ExecutionProfile, RunSilentSignal, WatchdogSignal } from "./types.js";

const primaryProfile: ExecutionProfile = {
  id: "claude-stable",
  displayName: "Claude Stable",
  targets: [{ adapterType: "claude_local", model: "sonnet", cliChannel: "stable" }],
  fallbackPolicy: "manual",
};

const fallbackProfile: ExecutionProfile = {
  id: "codex-backup",
  displayName: "Codex Backup",
  targets: [{ adapterType: "codex_local", model: "codex" }],
  fallbackPolicy: "on_quota",
};

function makeContract(overrides?: Partial<ExecutionContract>): ExecutionContract {
  return {
    id: "contract-1",
    scope: { kind: "issue", refId: "issue-1" },
    allowedProfileIds: [primaryProfile.id],
    fallbackProfileId: fallbackProfile.id,
    expectedDeliverables: [{ kind: "patch", required: true, minCount: 1 }],
    escalation: {
      wakeReason: "watchdog_issue",
      maxAutomaticRetries: 1,
      createEvaluationIssue: true,
    },
    ...overrides,
  };
}

function makeRunSilentSignal(overrides?: Partial<RunSilentSignal>): RunSilentSignal {
  return {
    type: "run.silent",
    companyId: "company-1",
    occurredAt: new Date("2026-05-28T12:00:00Z"),
    issueId: "issue-1",
    agentId: "agent-1",
    runId: "run-1",
    silenceAgeMs: 31_000,
    suspicionThresholdMs: 30_000,
    criticalThresholdMs: 60_000,
    ...overrides,
  };
}

function makeBudgetSignal(overrides?: Partial<BudgetThresholdCrossedSignal>): BudgetThresholdCrossedSignal {
  return {
    type: "budget.threshold_crossed",
    companyId: "company-1",
    occurredAt: new Date("2026-05-28T12:00:00Z"),
    issueId: "issue-1",
    agentId: "agent-1",
    runId: "run-1",
    provider: "anthropic",
    threshold: "soft",
    utilizationPct: 92,
    ...overrides,
  };
}

describe("watchdog registry", () => {
  it("resolves workflow step contracts from signal metadata", () => {
    const registry = createWatchdogRegistry({
      contracts: [makeContract({ scope: { kind: "workflow_step", refId: "step-7" } })],
    });

    const contract = registry.resolveContract({
      type: "deliverable.missing",
      companyId: "company-1",
      occurredAt: new Date("2026-05-28T12:00:00Z"),
      metadata: { workflowStepId: "step-7" },
      missingKinds: ["patch"],
    });

    expect(contract?.id).toBe("contract-1");
  });

  it("resolves goal contracts from signal metadata", () => {
    const registry = createWatchdogRegistry({
      contracts: [makeContract({ scope: { kind: "goal", refId: "goal-9" } })],
    });

    const contract = registry.resolveContract({
      type: "deliverable.missing",
      companyId: "company-1",
      occurredAt: new Date("2026-05-28T12:00:00Z"),
      metadata: { goal_id: "goal-9" },
      missingKinds: ["report"],
    });

    expect(contract?.id).toBe("contract-1");
  });

  it("resolves cost anomaly contracts from explicit scope references", () => {
    const registry = createWatchdogRegistry({
      contracts: [makeContract({ scope: { kind: "conversation", refId: "conv-4" } })],
    });

    const contract = registry.resolveContract({
      type: "cost.anomaly",
      companyId: "company-1",
      occurredAt: new Date("2026-05-28T12:00:00Z"),
      scopeKind: "conversation",
      scopeRef: "conv-4",
      observedCostCents: 4500,
      baselineCostCents: 900,
      deviationPct: 400,
    });

    expect(contract?.id).toBe("contract-1");
  });

  it("captures snapshot counts for configured registry state", () => {
    const registry = createWatchdogRegistry({
      profiles: [primaryProfile, fallbackProfile],
      contracts: [makeContract()],
      rules: [createRunLivenessWatchdogRule()],
    });

    expect(snapshotWatchdogRegistry(registry)).toEqual({
      profiles: 2,
      contracts: 1,
      rules: 1,
    });
  });
});

describe("default watchdog rules", () => {
  it("emits a wakeup for critical silent runs", () => {
    const rule = createRunLivenessWatchdogRule();

    const [decision] = rule.evaluate({
      now: new Date("2026-05-28T12:05:00Z"),
      signal: makeRunSilentSignal({ silenceAgeMs: 65_000 }),
      contract: null,
      profiles: new Map(),
    });

    expect(decision.severity).toBe("crit");
    expect(decision.actions.map((action) => action.type)).toEqual([
      "create_evaluation_issue",
      "request_issue_wakeup",
    ]);
  });

  it("includes the resolved contract id for deliverable gaps", () => {
    const rule = createDeliverableMissingWatchdogRule();
    const contract = makeContract();

    const [decision] = rule.evaluate({
      now: new Date("2026-05-28T12:05:00Z"),
      signal: {
        type: "deliverable.missing",
        companyId: "company-1",
        occurredAt: new Date("2026-05-28T12:00:00Z"),
        issueId: "issue-1",
        runId: "run-1",
        missingKinds: ["patch"],
      },
      contract,
      profiles: new Map(),
    });

    expect(decision.contractId).toBe("contract-1");
    expect(decision.actions.map((action) => action.type)).toEqual([
      "create_evaluation_issue",
      "request_issue_wakeup",
    ]);
  });

  it("switches to the fallback profile on a soft budget threshold", () => {
    const registry = createWatchdogRegistry({
      profiles: [primaryProfile, fallbackProfile],
      contracts: [makeContract()],
      rules: [createQuotaAndCostWatchdogRule()],
    });

    const [decision] = registry.evaluateSignal(makeBudgetSignal());

    expect(decision.reason).toContain("codex-backup");
    expect(decision.actions).toEqual([
      {
        type: "switch_execution_profile",
        payload: {
          issueId: "issue-1",
          runId: "run-1",
          profileId: "codex-backup",
          provider: "anthropic",
        },
      },
    ]);
  });

  it("pauses the agent and creates recovery work on a hard threshold without fallback", () => {
    const registry = createWatchdogRegistry({
      profiles: [primaryProfile],
      contracts: [makeContract({ fallbackProfileId: null })],
      rules: [createQuotaAndCostWatchdogRule()],
    });

    const [decision] = registry.evaluateSignal(makeBudgetSignal({ threshold: "hard" }));

    expect(decision.severity).toBe("crit");
    expect(decision.actions.map((action) => action.type)).toEqual([
      "pause_agent",
      "create_evaluation_issue",
    ]);
  });

  it("ignores unrelated signals for rules that do not subscribe", () => {
    const rule = createQuotaAndCostWatchdogRule();

    expect(
      rule.evaluate({
        now: new Date("2026-05-28T12:05:00Z"),
        signal: {
          type: "run.failed",
          companyId: "company-1",
          occurredAt: new Date("2026-05-28T12:00:00Z"),
          errorCode: "boom",
        } satisfies WatchdogSignal,
        contract: null,
        profiles: new Map(),
      }),
    ).toEqual([]);
  });
});
