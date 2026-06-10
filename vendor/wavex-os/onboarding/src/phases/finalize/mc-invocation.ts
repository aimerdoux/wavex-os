/**
 * Finalize step — invoke the flywheel-kernel Monte Carlo simulator with the
 * operator's initial KPISnapshot + active strategies, and pick a winner.
 */

import {
  runMonteCarlo,
  selectMCModel,
  type KPISnapshot,
  type MonteCarloReport,
} from "@wavex-os/plugin-flywheel-kernel";
import type { PillarResponses } from "../../schema/pillar-responses.js";
import type { MonteCarloWinner } from "../../schema/company-manifest.js";

export interface McInvocationOptions {
  horizon_cycles?: number;
  n_runs?: number;
  seed?: number;
  noise_scale?: number;
}

export interface McInvocationResult {
  report: MonteCarloReport;
  winner: MonteCarloWinner;
  initial: KPISnapshot;
}

export function invokeMonteCarlo(
  responses: PillarResponses,
  options: McInvocationOptions = {},
): McInvocationResult {
  const horizon = options.horizon_cycles ?? 30;
  const n_runs = options.n_runs ?? 30;
  const seed = options.seed ?? 42;
  const noise = options.noise_scale;

  const snapshot = responses.pillar_3?.kpi_snapshot_initial;
  if (!snapshot) {
    throw new Error("kpi_snapshot_initial missing from pillar_3 — run Pillar 3 first");
  }
  // Strip the ai_estimated flag before passing to the simulator (not a KPI).
  const { ai_estimated: _ignored, ...initial } = snapshot;

  // Stage-aware model: pre-scale operators get a different coupling equation
  // + winner selection. Without this, sub-$10k MRR operators see degenerate
  // Sharpe/growth numbers because the compounding model isn't calibrated for
  // their regime (WaveX audit F7B).
  // @tunable finalize.mc_model_mode_map
  const mode = selectMCModel(responses.pillar_3?.stage);
  const report = runMonteCarlo(initial, horizon, n_runs, seed, noise, undefined, mode);

  // Sprint 2b · Lever E — friction-aware winner re-selection.
  // The base winner selection (Sharpe / p_ruin) is stage-aware but friction-
  // agnostic. Two operators in the same stage with similar KPIs produce
  // identical winners. Bias by Pillar 1's primary_friction_hypothesis so
  // operators diagnosed with different frictions route to different strategies.
  const friction = (responses.pillar_1?.primary_friction_hypothesis ?? "").toLowerCase();
  const strategies = report.strategies;

  let preferredStrategyId = report.winner.strategy_id;
  // @tunable finalize.friction_keywords
  // @tunable finalize.mc_strategy_ids
  if (friction) {
    const byId = (id: string) => strategies.find((s) => s.strategy_id === id);
    if (friction.includes("activation") || friction.includes("onboarding")) {
      // Activation-friction operators should favor strategies that build activation
      // trajectory. Pre-scale already does this; for other modes, nudge toward
      // strategies with highest mean_activation_growth that still pass p_ruin < 0.25.
      // @tunable finalize.p_ruin_activation_threshold
      const eligible = strategies.filter((s) => s.p_ruin < 0.25);
      const best = (eligible.length > 0 ? eligible : strategies).reduce((b, s) =>
        (s.mean_activation_growth ?? 0) > (b.mean_activation_growth ?? 0) ? s : b,
      );
      preferredStrategyId = best.strategy_id;
    } else if (friction.includes("procurement") || friction.includes("enterprise") || friction.includes("long sales cycle")) {
      preferredStrategyId = byId("RETENTION_FIRST")?.strategy_id ?? preferredStrategyId;
    } else if (friction.includes("pricing") || friction.includes("paywall") || friction.includes("conversion")) {
      preferredStrategyId = byId("BALANCED")?.strategy_id ?? preferredStrategyId;
    } else if (friction.includes("integration") || friction.includes("setup") || friction.includes("runway")) {
      preferredStrategyId = byId("CAPITAL_EFFICIENT")?.strategy_id ?? preferredStrategyId;
    }
  }

  // Re-point the winner to the friction-biased strategy only if that strategy
  // has p_ruin < 0.4 (don't pick an obviously-unsafe strategy just because
  // the friction suggests it).
  if (preferredStrategyId !== report.winner.strategy_id) {
    const candidate = strategies.find((s) => s.strategy_id === preferredStrategyId);
    // @tunable finalize.p_ruin_safety_cap
    if (candidate && candidate.p_ruin < 0.4) {
      report.winner = {
        strategy_id: preferredStrategyId,
        rationale: `${candidate.strategy_id} selected via friction bias (primary_friction_hypothesis: "${friction.slice(0, 80)}"): sharpe ${candidate.sharpe.toFixed(2)}, p(ruin) ${(candidate.p_ruin * 100).toFixed(0)}%.`,
      };
    }
  }

  const winnerStats = report.strategies.find((s) => s.strategy_id === report.winner.strategy_id);
  if (!winnerStats) {
    throw new Error("MC report malformed — winner strategy not present in strategies[]");
  }

  const winner: MonteCarloWinner = {
    strategy_id: report.winner.strategy_id,
    sharpe: winnerStats.sharpe,
    mean_mrr_growth: winnerStats.mean_mrr_growth,
    mean_burn_multiple: winnerStats.mean_burn_multiple,
    p_auto_catalytic: winnerStats.p_auto_catalytic,
    p_ruin: winnerStats.p_ruin,
    mean_cycles_to_critical: winnerStats.mean_cycles_to_critical,
    mean_activation_growth: winnerStats.mean_activation_growth,
    model_mode: mode,
    rationale: report.winner.rationale,
    run_params: { horizon_cycles: horizon, n_runs, seed },
  };

  return { report, winner, initial };
}
