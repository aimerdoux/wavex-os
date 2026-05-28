import type {
  BudgetThresholdCrossedSignal,
  DeliverableMissingSignal,
  ExecutionProfile,
  RunSilentSignal,
  WatchdogDecision,
  WatchdogRule,
} from "./types.js";

function fallbackDecisionReason(profile: ExecutionProfile | null): string {
  if (!profile) return "Fallback requested but no fallback profile is configured";
  return `Switch execution to fallback profile ${profile.id}`;
}

function buildRunLivenessDecision(signal: RunSilentSignal): WatchdogDecision {
  const critical = signal.silenceAgeMs >= signal.criticalThresholdMs;
  return {
    ruleId: "run-liveness",
    severity: critical ? "crit" : "warn",
    reason: critical
      ? `Run ${signal.runId ?? "unknown"} has been silent for ${signal.silenceAgeMs}ms, above the critical threshold`
      : `Run ${signal.runId ?? "unknown"} has been silent for ${signal.silenceAgeMs}ms`,
    actions: [
      {
        type: "create_evaluation_issue",
        payload: {
          runId: signal.runId ?? null,
          issueId: signal.issueId ?? null,
          agentId: signal.agentId ?? null,
          silenceAgeMs: signal.silenceAgeMs,
        },
      },
      ...(critical
        ? [{
            type: "request_issue_wakeup" as const,
            payload: {
              issueId: signal.issueId ?? null,
              reason: "watchdog_run_silent",
            },
          }]
        : []),
    ],
    evidence: {
      silenceAgeMs: signal.silenceAgeMs,
      suspicionThresholdMs: signal.suspicionThresholdMs,
      criticalThresholdMs: signal.criticalThresholdMs,
    },
  };
}

function buildDeliverableMissingDecision(signal: DeliverableMissingSignal, contractId: string | null): WatchdogDecision {
  return {
    ruleId: "deliverable-missing",
    severity: "warn",
    contractId,
    reason: `Expected deliverables are missing for issue ${signal.issueId ?? "unknown"}`,
    actions: [
      {
        type: "create_evaluation_issue",
        payload: {
          issueId: signal.issueId ?? null,
          runId: signal.runId ?? null,
          missingKinds: signal.missingKinds,
        },
      },
      {
        type: "request_issue_wakeup",
        payload: {
          issueId: signal.issueId ?? null,
          reason: "watchdog_deliverable_gap",
        },
      },
    ],
    evidence: {
      missingKinds: signal.missingKinds,
    },
  };
}

function buildQuotaAndCostDecision(
  signal: BudgetThresholdCrossedSignal,
  fallbackProfile: ExecutionProfile | null,
  contractId: string | null,
): WatchdogDecision {
  if (signal.threshold === "soft" && fallbackProfile) {
    return {
      ruleId: "quota-and-cost",
      severity: "warn",
      contractId,
      reason: fallbackDecisionReason(fallbackProfile),
      actions: [
        {
          type: "switch_execution_profile",
          payload: {
            issueId: signal.issueId ?? null,
            runId: signal.runId ?? null,
            profileId: fallbackProfile.id,
            provider: signal.provider ?? null,
          },
        },
      ],
      evidence: {
        threshold: signal.threshold,
        utilizationPct: signal.utilizationPct,
      },
    };
  }

  return {
    ruleId: "quota-and-cost",
    severity: "crit",
    contractId,
    reason: `Budget threshold crossed for provider ${signal.provider ?? "unknown"}`,
    actions: [
      {
        type: signal.issueId || signal.agentId ? "pause_agent" : "pause_fleet",
        payload: {
          issueId: signal.issueId ?? null,
          agentId: signal.agentId ?? null,
          provider: signal.provider ?? null,
          threshold: signal.threshold,
          utilizationPct: signal.utilizationPct,
        },
      },
      {
        type: "create_evaluation_issue",
        payload: {
          issueId: signal.issueId ?? null,
          runId: signal.runId ?? null,
          provider: signal.provider ?? null,
          threshold: signal.threshold,
        },
      },
    ],
    evidence: {
      threshold: signal.threshold,
      utilizationPct: signal.utilizationPct,
      fallbackProfileId: fallbackProfile?.id ?? null,
    },
  };
}

export function createRunLivenessWatchdogRule(): WatchdogRule {
  return {
    id: "run-liveness",
    displayName: "Run Liveness Watchdog",
    description: "Detect active runs that have gone silent and create bounded recovery work.",
    subscribesTo: ["run.silent"],
    severity: "warn",
    evaluate: ({ signal }) => signal.type === "run.silent" ? [buildRunLivenessDecision(signal)] : [],
  };
}

export function createDeliverableMissingWatchdogRule(): WatchdogRule {
  return {
    id: "deliverable-missing",
    displayName: "Deliverable Missing Watchdog",
    description: "Catch completed work that lacks the proof artifact required by its execution contract.",
    subscribesTo: ["deliverable.missing"],
    severity: "warn",
    evaluate: ({ signal, contract }) =>
      signal.type === "deliverable.missing"
        ? [buildDeliverableMissingDecision(signal, contract?.id ?? null)]
        : [],
  };
}

export function createQuotaAndCostWatchdogRule(): WatchdogRule {
  return {
    id: "quota-and-cost",
    displayName: "Quota And Cost Watchdog",
    description: "Switch to backup profiles or pause work when quota or burn pressure breaches policy.",
    subscribesTo: ["budget.threshold_crossed"],
    severity: "crit",
    evaluate: ({ signal, contract, profiles }) => {
      if (signal.type !== "budget.threshold_crossed") return [];
      const fallbackProfile = contract?.fallbackProfileId
        ? profiles.get(contract.fallbackProfileId) ?? null
        : null;
      return [buildQuotaAndCostDecision(signal, fallbackProfile, contract?.id ?? null)];
    },
  };
}

export function defaultWatchdogRules(): WatchdogRule[] {
  return [
    createRunLivenessWatchdogRule(),
    createDeliverableMissingWatchdogRule(),
    createQuotaAndCostWatchdogRule(),
  ];
}
