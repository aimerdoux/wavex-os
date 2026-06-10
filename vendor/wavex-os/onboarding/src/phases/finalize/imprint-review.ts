/**
 * Finalize step — generates the plain-language imprint summary (OPΩ-ONB-002
 * §G). One T2 call with the full manifest context; returns 3-4 paragraphs.
 */

import { route } from "@wavex-os/plugin-tier-router";
import type { PillarResponses } from "../../schema/pillar-responses.js";
import type { ConnectorManifest } from "../../schema/connector-manifest.js";
import type { SwarmManifest } from "../../schema/swarm-manifest.js";
import type { WorkflowManifest } from "../../schema/workflow-manifest.js";
import type { MonteCarloWinner } from "../../schema/company-manifest.js";

function buildPrompt(
  responses: PillarResponses,
  connectors: ConnectorManifest,
  swarm: SwarmManifest,
  workflows: WorkflowManifest,
  mcWinner: MonteCarloWinner,
  operatorGuidance?: string,
): string {
  const activeAgentCount = Object.values(swarm.agents).filter((a) => a.status === "active").length;
  const parkedAgentCount = Object.values(swarm.agents).filter((a) => a.status === "parked").length;
  const disabledAgentCount = Object.values(swarm.agents).filter((a) => a.status === "disabled").length;

  const guidanceBlock = operatorGuidance && operatorGuidance.trim().length > 0
    ? `\n\nOPERATOR GUIDANCE (apply these adjustments to the output)\n${operatorGuidance.trim()}\n`
    : "";

  return `You are generating an Imprint Review — a plain-language summary of an organization's complete Operator Ω manifest. Write 3–4 paragraphs, max 400 words total. Use the operator's own vocabulary. Be specific and concrete about company facts (products, prices, geography, MRR tier, agent counts). Do not use marketing language, do not say "I'm excited", do not use exclamation marks. Professional, plain, operational.

OPERATOR IDENTITY — IMPORTANT
The Pillar 1 enrichment may name founders, executives, or other people associated with the organization (e.g. "founded by Jane Doe", "President Bob Smith"). Those names are **company facts**, not the identity of the person reading this imprint. The operator using this onboarding may be the founder, an employee, a contractor, an investor doing diligence, or someone evaluating the company.

- DO NOT address the imprint to a specific person by name. NEVER write "Frank approves each gated task" or "Jane will need to review."
- DO refer to the reader generically: "the operator", "you", "whoever is operating this instance".
- DO mention founder/executive names when describing what the company is (e.g. "founded by Frank Ma" is fine in the company description), but DO NOT carry that name forward into operational instructions.
- The dry-run gates require **operator approval** (not "Frank's approval"). Phrase accordingly.${guidanceBlock}

FULL CONTEXT
Organization: ${responses.pillar_1?.org_name}
One-liner: ${responses.pillar_1?.company_context?.slice(0, 400) /* @tunable finalize.imprint_context_slices */}
Product state: ${responses.pillar_3?.product_state} (${responses.pillar_3?.stage})
GTM profile: ${responses.pillar_4?.gtm_profile_enum}
Board comms: ${responses.pillar_5?.comm_channel}${responses.pillar_5?.urgency_routing ? ` (${responses.pillar_5.urgency_routing})` : ""}
Claude Code: ${responses.pillar_2?.claude_plan} (verified)

Swarm: ${activeAgentCount} of ${swarm.topology.total_base_roster} active, ${parkedAgentCount} parked, ${disabledAgentCount} disabled.
Parked agents: ${Object.entries(swarm.agents).filter(([, a]) => a.status === "parked").map(([id]) => id).join(", ") || "none"}
Disabled agents: ${Object.entries(swarm.agents).filter(([, a]) => a.status === "disabled").map(([id]) => id).join(", ") || "none"}

Connectors required: ${connectors.required.map((c) => c.id).join(", ")}
Connectors suggested: ${connectors.suggested.map((c) => c.id).join(", ") || "none"}

Dry-run window: 14 days from ${connectors.dry_run_expires_at}.
Dry-run gates (tasks held dry): ${workflows.dry_run_gates.length} tasks across the swarm.

MC winner: ${mcWinner.strategy_id}
  model mode: ${mcWinner.model_mode ?? "growth"}
  sharpe: ${mcWinner.sharpe.toFixed(2)}
  mean MRR growth (${mcWinner.run_params.horizon_cycles} cycles): ${(mcWinner.mean_mrr_growth * 100).toFixed(0)}%
  mean activation growth: ${typeof mcWinner.mean_activation_growth === "number" ? `${(mcWinner.mean_activation_growth * 100).toFixed(1)}%` : "—"}
  mean burn multiple: ${mcWinner.mean_burn_multiple.toFixed(2)}
  p(auto-catalytic): ${(mcWinner.p_auto_catalytic * 100).toFixed(0)}%
  p(ruin): ${(mcWinner.p_ruin * 100).toFixed(0)}%
  cycles-to-critical: ${mcWinner.mean_cycles_to_critical ?? "—"}
  IMPORTANT: when model mode is pre_scale, MRR is HELD FLAT by design — never
  present 0% MRR growth / Sharpe 0.00 as a finding; the ranking is driven by
  activation growth and burn multiple. Cite THOSE numbers in ¶3.

PARAGRAPH STRUCTURE
¶1 (who + current state): name the org, describe what it does, where it is on product + revenue, what the GTM motion looks like.
¶2 (deployed system): agent counts, notable parks/disables and why, connector stack, how Board gets notified.
¶3 (MC strategy): name the winning strategy in plain terms, expected cycles to criticality, the Sharpe read.
¶4 (dry-run expectations): 14 days, which tasks are gated, what the operator needs to approve before writes go live.

OUTPUT
Return ONLY the summary text. No JSON, no markdown headers, no salutations. Just 3–4 paragraphs.`;
}

export async function generateImprintReview(args: {
  companyId: string;
  responses: PillarResponses;
  connectors: ConnectorManifest;
  swarm: SwarmManifest;
  workflows: WorkflowManifest;
  mcWinner: MonteCarloWinner;
  skipInference?: boolean;
  /** Wavex-os 2026-05: free-form operator guidance injected into the prompt
   *  (e.g. "remove all references to specific people", "focus more on the
   *  international distribution motion"). Re-generation flow uses this. */
  operatorGuidance?: string;
}): Promise<{ summary: string; source: "t2" | "fallback"; warnings: string[] }> {
  if (args.skipInference) {
    return {
      summary: fallbackSummary(args.responses, args.swarm, args.connectors, args.workflows, args.mcWinner),
      source: "fallback",
      warnings: [],
    };
  }

  const warnings: string[] = [];
  try {
    const resp = await route({
      agent_id: "onboarding.finalize.imprint",
      prompt: buildPrompt(args.responses, args.connectors, args.swarm, args.workflows, args.mcWinner, args.operatorGuidance),
      task_metadata: {
        creativity_required: true,
        customer_facing: true,
        reasoning_depth: "deep",
        priority: "high",
      },
      companyId: args.companyId,
      outputFormat: "text",
      // wavex-os patch: bumped 120_000 → 300_000 (see vendor/wavex-os/VENDOR.md).
      // The deep+creative imprint pass routinely exceeds 2 min; the deterministic
      // fallback was firing too often and degrading manifest quality.
      timeout_ms: 300_000,
    });
    if (resp.warnings) warnings.push(...resp.warnings);
    const text = resp.output.trim();
    if (text.length < 120) {
      warnings.push("T2 imprint too short; kept fallback");
      return {
        summary: fallbackSummary(args.responses, args.swarm, args.connectors, args.workflows, args.mcWinner),
        source: "fallback",
        warnings,
      };
    }
    return { summary: text, source: "t2", warnings };
  } catch (err) {
    warnings.push(`T2 imprint generation failed: ${err instanceof Error ? err.message : String(err)}`);
    return {
      summary: fallbackSummary(args.responses, args.swarm, args.connectors, args.workflows, args.mcWinner),
      source: "fallback",
      warnings,
    };
  }
}

function fallbackSummary(
  r: PillarResponses,
  s: SwarmManifest,
  c: ConnectorManifest,
  w: WorkflowManifest,
  mc: MonteCarloWinner,
): string {
  const parked = Object.entries(s.agents).filter(([, a]) => a.status === "parked").map(([id]) => id);
  const disabled = Object.entries(s.agents).filter(([, a]) => a.status === "disabled").map(([id]) => id);
  return [
    `${r.pillar_1?.org_name ?? "The organization"} is ${r.pillar_1?.company_context?.slice(0, 180) ?? "operating without a current company context on file"}. It is in the ${r.pillar_3?.product_state ?? "unknown"} stage (${r.pillar_3?.stage ?? "—"}) with a ${r.pillar_4?.gtm_profile_enum ?? "unclassified"} GTM motion. Board notifications route via ${r.pillar_5?.comm_channel ?? "email_only"}.`,
    `${s.topology.active_count} of ${s.topology.total_base_roster} agents are active. Parked: ${parked.join(", ") || "none"}. Disabled: ${disabled.join(", ") || "none"}. Connectors required at launch: ${c.required.map((x) => x.id).join(", ")}. ${c.suggested.length > 0 ? `Suggested but optional: ${c.suggested.map((x) => x.id).join(", ")}.` : ""}`,
    // Pre-scale runs hold MRR flat BY DESIGN, so MRR-based stats read as
    // all-zero placeholders and the imprint looked fake (operator QA,
    // 2026-06-10). Lead with the stat that actually drove the ranking.
    mc.model_mode === "pre_scale" && typeof mc.mean_activation_growth === "number"
      ? `Monte Carlo over ${mc.run_params.n_runs} runs × ${mc.run_params.horizon_cycles} cycles (pre-scale model: MRR held flat by design; activation is the lever that compounds at this stage) recommends the ${mc.strategy_id} strategy on a projected activation lift of ${(mc.mean_activation_growth * 100).toFixed(1)}% at a mean burn multiple of ${mc.mean_burn_multiple.toFixed(2)}. ${mc.rationale}`
      : `Monte Carlo over ${mc.run_params.n_runs} runs × ${mc.run_params.horizon_cycles} cycles recommends the ${mc.strategy_id} strategy (Sharpe ${mc.sharpe.toFixed(2)}, mean MRR growth ${(mc.mean_mrr_growth * 100).toFixed(0)}% over horizon, p(auto-catalytic) ${(mc.p_auto_catalytic * 100).toFixed(0)}%${mc.mean_cycles_to_critical !== null ? `, expected ${mc.mean_cycles_to_critical.toFixed(1)} cycles to criticality` : ""}).`,
    `The system runs dry until ${c.dry_run_expires_at} — ${w.dry_run_gates.length} tasks across the swarm are gated and will log intended output without writing externally. Review the first round of proposals via ${r.pillar_5?.comm_channel ?? "your configured channel"} before flipping dry_run off.`,
  ].join("\n\n");
}
