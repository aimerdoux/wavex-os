/** Wavex-os op-omega Fastify route registrar. Mounts all op-omega
 *  onboarding endpoints under /op-omega/onboarding/* against an existing
 *  Fastify instance.
 *
 *  Boundary side-effects applied at registration time:
 *  - PAPERCLIP_DATA_DIR points at $HOME/.wavex-os so plugin state lands
 *    inside the wavex root
 *  - OP_OMEGA_CLAUDE_BIN is set so tier-router T2 calls reach the operator's
 *    OAuth keychain (in dev) or the plain claude CLI (in prod) */

import type { FastifyInstance } from "fastify";
import { applyInferenceEnv } from "@wavex-os/inference-adapter";
import { applyStateBridge } from "./state-bridge.js";
import { detectAndConfigurePaperclip } from "./lib/paperclip-detect.js";
import { registerPillarRoutes } from "./routes/pillars.js";
import { registerPhaseRoutes } from "./routes/phases.js";
import { registerProbeRoutes } from "./routes/probe.js";
import { registerInstanceRoutes } from "./routes/instance.js";
import { registerInferenceAllocationRoute } from "./routes/inference-allocation.js";
import { registerObservabilityRoutes } from "./routes/observability.js";
import { registerPillar5TestSendRoute } from "./routes/pillar5-test-send.js";
import { registerCredentialRoutes } from "./routes/credentials.js";
import { registerRegenerateImprintRoute } from "./routes/regenerate-imprint.js";
import { registerRefinementRoutes } from "./routes/refinement.js";
import { registerActivateRoute } from "./routes/activate.js";
import { registerResetRoute } from "./routes/reset.js";
import { registerSwapTemplateRoute } from "./routes/swap-template.js";
import { registerInferenceStatusRoute } from "./routes/inference-status.js";
import { registerAddAgentRoute } from "./routes/add-agent.js";
import { registerRecommendAgentRoute } from "./routes/recommend-agent.js";
import { registerTokenUsageRoute } from "./routes/token-usage.js";
import { registerTokenBudgetRoute } from "./routes/token-budget.js";
import { registerRedundancyRoutes } from "./routes/redundancy.js";
import { registerHelpChatRoute } from "./routes/help-chat.js";
import { registerTiersRoutes } from "./routes/tiers.js";
import { registerBillingRoutes } from "./routes/billing.js";
import { registerAvatarRoutes } from "./routes/avatar.js";
import { registerConnectorRoutes } from "./routes/connectors.js";
import { registerMissionControlRoutes } from "./routes/mission-control.js";

let bootstrapped = false;
function bootstrap(): void {
  if (bootstrapped) return;
  applyInferenceEnv();
  applyStateBridge();
  // Fire-and-forget Paperclip detection — don't block route registration on
  // the network probe. If Paperclip comes up later, the operator can either
  // restart wavex or set PAPERCLIP_HANDOFF_URL by hand.
  void detectAndConfigurePaperclip();
  bootstrapped = true;
}

export function registerOpOmegaRoutes(app: FastifyInstance): void {
  bootstrap();
  registerPillarRoutes(app);
  registerPhaseRoutes(app);
  registerProbeRoutes(app);
  registerInstanceRoutes(app);
  registerInferenceAllocationRoute(app);
  registerObservabilityRoutes(app);
  registerPillar5TestSendRoute(app);
  registerCredentialRoutes(app);
  registerRegenerateImprintRoute(app);
  registerRefinementRoutes(app);
  registerActivateRoute(app);
  registerResetRoute(app);
  registerSwapTemplateRoute(app);
  registerInferenceStatusRoute(app);
  registerAddAgentRoute(app);
  registerRecommendAgentRoute(app);
  registerTokenUsageRoute(app);
  registerTokenBudgetRoute(app);
  registerRedundancyRoutes(app);
  registerHelpChatRoute(app);
  registerTiersRoutes(app);
  void registerBillingRoutes(app);
  registerAvatarRoutes(app);
  registerConnectorRoutes(app);
  registerMissionControlRoutes(app);
}

export { applyStateBridge, getInstanceDir, getOnboardingDir, getWavexDataRoot } from "./state-bridge.js";
