/**
 * Final aggregate — company.manifest.yaml (OPΩ-ONB-002 §G).
 *
 * Embeds all four prior manifests verbatim, adds MC winner + imprint
 * summary + dry-run state + signatures. This is the contract the running
 * flywheel executes against.
 */

import type { StrategyId, MonteCarloReport } from "@wavex-os/plugin-flywheel-kernel";
import type { PillarResponses } from "./pillar-responses.js";
import type { ConnectorManifest } from "./connector-manifest.js";
import type { SwarmManifest } from "./swarm-manifest.js";
import type { WorkflowManifest } from "./workflow-manifest.js";

export const COMPANY_MANIFEST_SCHEMA_VERSION = "1.0";

export interface MonteCarloWinner {
  strategy_id: StrategyId;
  sharpe: number;
  mean_mrr_growth: number;
  mean_burn_multiple: number;
  p_auto_catalytic: number;
  p_ruin: number;
  mean_cycles_to_critical: number | null;
  /** Pre-scale mode holds MRR flat BY DESIGN — activation growth is the
   *  stage-appropriate headline stat there. Optional for back-compat with
   *  manifests written before 2026-06-10. */
  mean_activation_growth?: number;
  /** Which simulator mode produced these stats (pre_scale | growth | scale). */
  model_mode?: string;
  rationale: string;
  /** Horizon + n_runs + seed, for reproducibility. */
  run_params: {
    horizon_cycles: number;
    n_runs: number;
    seed: number;
  };
}

export interface DryRunState {
  enabled: boolean;
  expires_at: string;
  post_expiration_action: "require_board_approval_to_go_live";
}

export interface CompanyManifestSignatures {
  generated_by_operator: string;
  generated_by_system: string;
  /** sha256 of the full manifest with signatures zeroed out. */
  manifest_hash: string;
}

/**
 * Credential collection summary · Credential Concierge integration.
 *
 * Plaintext NEVER leaks into the manifest — this is metadata only. The vault
 * (`credentials` table, encrypted at rest) is the canonical store.
 */
export interface CompanyManifestCredentials {
  /**
   * Credentials the Phase 2 decision matrix said this company would need,
   * with their final concierge state.
   */
  required: Array<{
    credential_key: string;
    status: "valid" | "skipped" | "invalid" | "unvalidated";
    written_by: string;
    last_validated_at: string | null;
    rotation_policy_days: number | null;
  }>;
  /**
   * Operator-recorded unknown credentials (those without a registry entry).
   * Tracked here so `coo.credentials` can flag them for registry promotion.
   */
  unknown: Array<{
    credential_key: string;
    label: string;
    purpose: string;
    written_at: string;
  }>;
  /** Bootstrap credential — Composio API key. Required if any Composio-handled toolkit is recommended. */
  composio_bootstrap: {
    status: "valid" | "skipped" | "invalid" | "unvalidated" | "not_required";
    last_validated_at: string | null;
  };
}

export interface PhaseTimings {
  phase_1_onboard_ms?: number;
  phase_2_connector_ms?: number;
  phase_3_swarm_ms?: number;
  phase_4_workflow_ms?: number;
  finalize_ms: number;
}

export interface CompanyManifest {
  schema_version: typeof COMPANY_MANIFEST_SCHEMA_VERSION;
  org_id: string;
  finalized_at: string;
  phase_timings: PhaseTimings;
  pillar_responses: PillarResponses;
  connector_manifest: ConnectorManifest;
  swarm_manifest: SwarmManifest;
  workflow_manifest: WorkflowManifest;
  mc_winner: MonteCarloWinner;
  /** Full MC report is a separate artifact; this is the summary embedded in the manifest. */
  mc_report_ref: string;
  imprint_summary: string;
  dry_run: DryRunState;
  /**
   * Credential summary populated by the Credential Concierge during onboarding.
   * Optional for backward-compatibility — manifests assembled before the concierge
   * integration parse without this field.
   */
  credentials?: CompanyManifestCredentials;
  signatures: CompanyManifestSignatures;
}

export type { MonteCarloReport };
