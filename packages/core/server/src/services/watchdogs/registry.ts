import type {
  CostAnomalySignal,
  ExecutionContract,
  ExecutionProfile,
  ExecutionProfileTarget,
  WatchdogDecision,
  WatchdogEvaluationContext,
  WatchdogRule,
  WatchdogSignal,
} from "./types.js";

function uniqueById<T extends { id: string }>(items: Iterable<T>): Map<string, T> {
  const out = new Map<string, T>();
  for (const item of items) out.set(item.id, item);
  return out;
}

function readSignalMetadataId(signal: WatchdogSignal, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = signal.metadata?.[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function matchesCostAnomalyScope(contract: ExecutionContract, signal: CostAnomalySignal): boolean {
  return contract.scope.kind === signal.scopeKind && contract.scope.refId === signal.scopeRef;
}

function contractMatchesSignal(contract: ExecutionContract, signal: WatchdogSignal): boolean {
  if (signal.type === "cost.anomaly" && matchesCostAnomalyScope(contract, signal)) return true;
  switch (contract.scope.kind) {
    case "issue":
      return contract.scope.refId === signal.issueId;
    case "agent":
      return contract.scope.refId === signal.agentId;
    case "workflow_step":
      return contract.scope.refId === readSignalMetadataId(signal, "workflowStepId", "workflow_step_id");
    case "goal":
      return contract.scope.refId === readSignalMetadataId(signal, "goalId", "goal_id");
    case "conversation":
      return contract.scope.refId === signal.conversationId;
    default:
      return false;
  }
}

export interface EvaluateWatchdogSignalOptions {
  now?: Date;
}

export class WatchdogRegistry {
  private readonly profiles = new Map<string, ExecutionProfile>();
  private readonly contracts = new Map<string, ExecutionContract>();
  private readonly rules = new Map<string, WatchdogRule>();

  registerProfile(profile: ExecutionProfile): this {
    this.profiles.set(profile.id, profile);
    return this;
  }

  registerProfiles(profiles: Iterable<ExecutionProfile>): this {
    for (const profile of profiles) this.registerProfile(profile);
    return this;
  }

  registerContract(contract: ExecutionContract): this {
    this.contracts.set(contract.id, contract);
    return this;
  }

  registerContracts(contracts: Iterable<ExecutionContract>): this {
    for (const contract of contracts) this.registerContract(contract);
    return this;
  }

  registerRule(rule: WatchdogRule): this {
    this.rules.set(rule.id, rule);
    return this;
  }

  registerRules(rules: Iterable<WatchdogRule>): this {
    for (const rule of rules) this.registerRule(rule);
    return this;
  }

  listProfiles(): ExecutionProfile[] {
    return [...this.profiles.values()];
  }

  listContracts(): ExecutionContract[] {
    return [...this.contracts.values()];
  }

  listRules(): WatchdogRule[] {
    return [...this.rules.values()];
  }

  resolveContract(signal: WatchdogSignal): ExecutionContract | null {
    const exact = this.listContracts().find((contract) => contractMatchesSignal(contract, signal));
    if (exact) return exact;
    return null;
  }

  resolveProfile(profileId: string | null | undefined): ExecutionProfile | null {
    if (!profileId) return null;
    return this.profiles.get(profileId) ?? null;
  }

  resolveFallbackTarget(contract: ExecutionContract | null): ExecutionProfileTarget | null {
    if (!contract?.fallbackProfileId) return null;
    const profile = this.resolveProfile(contract.fallbackProfileId);
    return profile?.targets[0] ?? null;
  }

  evaluateSignal(signal: WatchdogSignal, options?: EvaluateWatchdogSignalOptions): WatchdogDecision[] {
    const contract = this.resolveContract(signal);
    const ctx: WatchdogEvaluationContext = {
      now: options?.now ?? new Date(),
      signal,
      contract,
      profiles: this.profiles,
    };
    const decisions: WatchdogDecision[] = [];
    for (const rule of this.rules.values()) {
      if (!rule.subscribesTo.includes(signal.type)) continue;
      decisions.push(...rule.evaluate(ctx));
    }
    return decisions;
  }
}

export function createWatchdogRegistry(input?: {
  profiles?: Iterable<ExecutionProfile>;
  contracts?: Iterable<ExecutionContract>;
  rules?: Iterable<WatchdogRule>;
}): WatchdogRegistry {
  const registry = new WatchdogRegistry();
  if (input?.profiles) registry.registerProfiles(input.profiles);
  if (input?.contracts) registry.registerContracts(input.contracts);
  if (input?.rules) registry.registerRules(input.rules);
  return registry;
}

export function snapshotWatchdogRegistry(registry: WatchdogRegistry) {
  return {
    profiles: uniqueById(registry.listProfiles()).size,
    contracts: uniqueById(registry.listContracts()).size,
    rules: uniqueById(registry.listRules()).size,
  };
}
