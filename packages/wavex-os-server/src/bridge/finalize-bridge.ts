/** Finalize → DB bridge (Slice 1: agents, Slice 2: KPIs).
 *
 *  Translates a signed company.manifest.json into runtime DB state. Idempotent
 *  via deterministic agent ids + ON CONFLICT DO UPDATE. Slice 1 writes:
 *    - 1 row in `companies` (state flips to 'active')
 *    - N rows in `agents` (one per swarm_manifest.agents.* slot)
 *
 *  Slice 2 writes:
 *    - 4 rows in `company_kpis` (canonical unit-economics definitions)
 *    - 4 rows in `kpi_snapshots` (value=0 baselines; real measurement in WAVAAAA-118)
 *
 *  Out of scope (later slices): cost_events, heartbeat_runs, issues,
 *  task_outcome_attributions, credentials sanity. */

import type { CompanyManifest } from "@wavex-os/plugin-onboarding";
import { sql } from "drizzle-orm";
import { agents, companies, companyKpis, kpiSnapshots, type Db } from "@wavex-os/db";
import {
  agentIdForSlot, modelForTier, slotToHumanName, templateIdForSlot, tierForSlot,
} from "./catalog.js";
import { selectTemplatesForManifest } from "../selection/scorer.js";

interface ManifestWithOverlays extends CompanyManifest {
  template_overlays?: Record<string, string>;
  template_additions?: Array<{
    slot: string;
    parent_slot: string;
    template_id: string;
    added_at: string;
  }>;
  template_selections?: Record<string, {
    chosenTemplateId: string;
    defaultTemplateId: string;
    diverged: boolean;
    score: number;
    rationale: string;
  }>;
  /** Slots the operator has muted via the redundancy review. The bridge
   *  skips them when writing agents to DB; the manifest still records them
   *  so a future un-mute can restore the slot without re-running phases. */
  template_mutes?: string[];
}

export interface BridgeReport {
  companies: number;
  agents: number;
  kpis: number;
  warnings: string[];
}

export async function bridgeAgents(
  manifest: CompanyManifest,
  companyId: string,
  db: Db,
): Promise<BridgeReport> {
  const warnings: string[] = [];

  // 1. UPSERT companies
  await db.insert(companies).values({
    id: companyId,
    name: manifest.org_id || companyId,
    state: "active",
    pillarResponses: manifest.pillar_responses as unknown as Record<string, unknown>,
    updatedAt: new Date(),
  }).onConflictDoUpdate({
    target: companies.id,
    set: {
      name: manifest.org_id || companyId,
      state: "active",
      pillarResponses: manifest.pillar_responses as unknown as Record<string, unknown>,
      updatedAt: new Date(),
    },
  });

  // 2. UPSERT agents — pass 1: insert without reports_to_agent_id
  // Operator additions (manifest.template_additions) merge in here as
  // pseudo-base-roster entries with synthesized AgentManifestEntry shape.
  // They inherit the parent's status semantics (default active).
  const additions = (manifest as ManifestWithOverlays).template_additions ?? [];
  const baseEntries = Object.entries(manifest.swarm_manifest.agents);
  const addedEntries: Array<[string, typeof baseEntries[0][1]]> = additions.map((a) => {
    const parentEntry = manifest.swarm_manifest.agents[a.parent_slot];
    return [a.slot, {
      status: "active" as const,
      adapter: parentEntry?.adapter ?? "claude-code",
      heartbeat: parentEntry?.heartbeat ?? "2h",
      budget_monthly_usd: parentEntry?.budget_monthly_usd ?? 60,
      skill_overlay: null,
      department: parentEntry?.department ?? "ops",
      level: "L·IV" as const,
      reports_to: a.parent_slot,
      spawnable: true,
    }];
  });
  const slotEntries = [...baseEntries, ...addedEntries];
  if (additions.length > 0) {
    warnings.push(`${additions.length} operator-added agent${additions.length === 1 ? "" : "s"} merged into roster`);
  }
  let warnedOnOwnedKpis = false;

  // Resolution order per slot:
  //   1. operator overlay (manual swap)  → highest priority
  //   2. matrix selection (deterministic scorer)
  //   3. catalog default (SLOT_TO_TEMPLATE)
  //
  // The scorer reads pillar 1/3/4 + connector_manifest.required and picks the
  // strongest-fit template from a curated candidate list per slot. Slots
  // without per-company variation just return the catalog default.
  const overlays = (manifest as ManifestWithOverlays).template_overlays ?? {};
  const selections = selectTemplatesForManifest(manifest);

  // Persist selections back onto the manifest so the dashboard / swap UI can
  // surface the rationale and so refinement loops carry it through.
  (manifest as ManifestWithOverlays).template_selections = Object.fromEntries(
    [...selections.entries()].map(([slot, sel]) => [slot, {
      chosenTemplateId: sel.chosenTemplateId,
      defaultTemplateId: sel.defaultTemplateId,
      diverged: sel.diverged,
      score: sel.score,
      rationale: sel.rationale,
    }]),
  );

  // Index additions by slot so we can resolve their explicit template_id
  // without going through SLOT_TO_TEMPLATE (which doesn't know about them).
  const additionBySlot = new Map(additions.map((a) => [a.slot, a]));

  // Operator mutes from the redundancy review — skip these slots entirely.
  // Persisting them on the manifest (rather than deleting the slot) keeps
  // the un-mute path cheap and doesn't lose the matrix's original choice.
  const mutes = new Set((manifest as ManifestWithOverlays).template_mutes ?? []);
  if (mutes.size > 0) {
    warnings.push(`${mutes.size} slot${mutes.size === 1 ? "" : "s"} muted by operator: ${[...mutes].join(", ")}`);
  }

  for (const [slot, entry] of slotEntries) {
    if (mutes.has(slot)) continue;
    const tier = tierForSlot(slot);
    const overlayTemplate = overlays[slot];
    const addition = additionBySlot.get(slot);
    const selection = selections.get(slot);
    // Resolution order for added agents: overlay > addition.template_id > selection > default.
    // Resolution order for base roster: overlay > selection > default.
    const templateId = overlayTemplate
      ?? addition?.template_id
      ?? selection?.chosenTemplateId
      ?? templateIdForSlot(slot);
    if (!addition && templateId === slot && !slot.match(/^(ceo\.orchestrator|cpo|cmo|cro|cfo|cdo|coo)$/)) {
      warnings.push(`no template mapping for slot "${slot}" — using slot as templateId fallback`);
    }
    if (overlayTemplate) {
      warnings.push(`slot "${slot}" using operator-chosen overlay template "${overlayTemplate}" (default was "${templateIdForSlot(slot)}")`);
    } else if (addition) {
      warnings.push(`slot "${slot}" is an operator-added agent (template "${addition.template_id}", added ${addition.added_at})`);
    } else if (selection?.diverged) {
      warnings.push(`slot "${slot}" matrix-selected "${selection.chosenTemplateId}" (default was "${selection.defaultTemplateId}") — ${selection.rationale}`);
    }

    // owned_kpi_ids isn't on the upstream AgentManifestEntry type — defaults to []
    // until a later slice surfaces KPI ownership in the manifest. Warn once.
    if (!warnedOnOwnedKpis) {
      warnings.push("owned_kpi_ids defaulted to [] for all agents (manifest does not yet expose per-agent KPI ownership)");
      warnedOnOwnedKpis = true;
    }

    const role = slot.split(".")[0]!;

    await db.insert(agents).values({
      id: agentIdForSlot(companyId, slot),
      companyId,
      name: slotToHumanName(slot),
      role,
      slot,
      templateId,
      reportsToAgentId: null, // resolved in pass 2
      reportsToSlot: entry.reports_to,
      tier,
      status: entry.status,
      adapter: entry.adapter,
      model: modelForTier(tier),
      heartbeat: entry.heartbeat,
      spawnable: entry.spawnable,
      ownedKpiIds: [],
      spawnedAt: new Date(),
    }).onConflictDoUpdate({
      target: agents.id,
      set: {
        name: slotToHumanName(slot),
        role,
        templateId,
        reportsToSlot: entry.reports_to,
        tier,
        status: entry.status,
        adapter: entry.adapter,
        model: modelForTier(tier),
        heartbeat: entry.heartbeat,
        spawnable: entry.spawnable,
      },
    });
  }

  // 3. Pass 2 — resolve reports_to_agent_id now that all rows exist.
  //    Skip muted slots (their row was never inserted) and re-parent any
  //    children whose direct parent was muted to that parent's grandparent.
  //    Walks both base roster + operator additions so additions can be
  //    chained through too (rare but possible).
  const slotEntryMap = new Map(slotEntries);
  function effectiveParent(slot: string): string | null {
    let next: string | null = slot;
    while (next && mutes.has(next)) {
      const entry = slotEntryMap.get(next);
      next = entry?.reports_to ?? null;
    }
    return next;
  }
  for (const [slot, entry] of slotEntries) {
    if (mutes.has(slot)) continue;
    if (!entry.reports_to) continue;
    const parent = effectiveParent(entry.reports_to);
    if (!parent) continue;
    const agentId = agentIdForSlot(companyId, slot);
    const reportsToId = agentIdForSlot(companyId, parent);
    await db.update(agents)
      .set({ reportsToAgentId: reportsToId })
      .where(sql`${agents.id} = ${agentId}`);
  }

  const insertedCount = slotEntries.length - mutes.size;
  return {
    companies: 1,
    agents: insertedCount,
    kpis: 0,
    warnings,
  };
}

/** Canonical KPI definitions seeded for every company at activation time.
 *  Directions: "up" = higher is better, "down" = lower is better. */
const CANONICAL_KPIS = [
  { kpiId: "burn_multiple", label: "Burn Multiple", direction: "down" },
  { kpiId: "cac", label: "Customer Acquisition Cost (USD)", direction: "down" },
  { kpiId: "cac_payback_months", label: "CAC Payback Months", direction: "down" },
  { kpiId: "monthly_recurring_revenue", label: "Monthly Recurring Revenue (USD)", direction: "up" },
] as const;

/** Slice 2 — writes KPI definitions + baseline snapshots.
 *
 *  Idempotent: deletes then re-inserts company_kpis for this company.
 *  kpi_snapshots are append-only; each call inserts a fresh value=0 baseline
 *  row (real measurements follow in WAVAAAA-118). */
export async function bridgeKpis(
  manifest: CompanyManifest,
  companyId: string,
  db: Db,
): Promise<{ kpis: number }> {
  // Delete existing KPI definitions so re-running activate is idempotent.
  await db.delete(companyKpis).where(sql`${companyKpis.companyId} = ${companyId}`);

  // Use mc_winner.mean_burn_multiple as initial target for burn_multiple (micros = value × 1e6).
  const burnMultipleTargetMicros =
    typeof manifest.mc_winner?.mean_burn_multiple === "number"
      ? BigInt(Math.round(manifest.mc_winner.mean_burn_multiple * 1_000_000))
      : null;

  const now = new Date();

  for (const kpi of CANONICAL_KPIS) {
    await db.insert(companyKpis).values({
      companyId,
      kpiId: kpi.kpiId,
      label: kpi.label,
      direction: kpi.direction,
      targetMicros: kpi.kpiId === "burn_multiple" ? burnMultipleTargetMicros : null,
      windowDays: "30",
      kpiOwnerAgentId: null,
      ownerRole: null,
      createdAt: now,
    });

    // Baseline snapshot: value = 0. Real snapshots written by observability layer.
    await db.insert(kpiSnapshots).values({
      companyId,
      kpiName: kpi.kpiId,
      value: BigInt(0),
      measuredAt: now,
      metadata: { source: "activate_baseline" },
    });
  }

  // Slice 2b — the user's PRIMARY GOAL from onboarding becomes a first-class
  // scoreboard KPI with its real baseline + target. Without this, Mission
  // Control only observes generic unit economics and the mission the user
  // actually typed during onboarding never reaches the observer interface.
  // (Same defensive manifest cast as bridge/paperclip-handoff.ts — `goal` is
  // not yet on the upstream CompanyManifest type.)
  const withGoal = manifest as CompanyManifest & {
    goal?: { kpiId?: string; current?: number; target?: number; days?: number };
    meta_goal?: string;
  };
  const goal = withGoal.goal ?? {};
  let extraKpis = 0;
  if (goal.kpiId) {
    const toMicros = (v: number) => BigInt(Math.round(v * 1_000_000));
    const isCanonical = CANONICAL_KPIS.some((k) => k.kpiId === goal.kpiId);
    if (isCanonical) {
      // Goal targets a canonical KPI (e.g. monthly_recurring_revenue):
      // stamp the user's target + window onto the canonical row.
      await db
        .update(companyKpis)
        .set({
          targetMicros: typeof goal.target === "number" ? toMicros(goal.target) : null,
          windowDays: String(goal.days ?? 30),
          ownerRole: "ceo",
        })
        .where(
          sql`${companyKpis.companyId} = ${companyId} and ${companyKpis.kpiId} = ${goal.kpiId}`,
        );
    } else {
      await db.insert(companyKpis).values({
        companyId,
        kpiId: goal.kpiId,
        label: withGoal.meta_goal
          ? `Primary goal — ${withGoal.meta_goal.slice(0, 80)}`
          : `Primary goal (${goal.kpiId})`,
        direction: "up",
        targetMicros: typeof goal.target === "number" ? toMicros(goal.target) : null,
        windowDays: String(goal.days ?? 30),
        kpiOwnerAgentId: null,
        ownerRole: "ceo",
        createdAt: now,
      });
      extraKpis = 1;
    }
    // Baseline at the user's stated CURRENT value, not zero — progress on
    // the scoreboard is measured from where the business actually starts.
    await db.insert(kpiSnapshots).values({
      companyId,
      kpiName: goal.kpiId,
      value: typeof goal.current === "number" ? toMicros(goal.current) : BigInt(0),
      measuredAt: now,
      metadata: { source: "activate_primary_goal_baseline", days: goal.days ?? null },
    });
  }

  return { kpis: CANONICAL_KPIS.length + extraKpis };
}
