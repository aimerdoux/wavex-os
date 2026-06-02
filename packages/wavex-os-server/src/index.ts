/** Wavex-os wavex-os Fastify route registrar. Mounts all wavex-os
 *  onboarding endpoints under /wavex-os/onboarding/* against an existing
 *  Fastify instance.
 *
 *  Boundary side-effects applied at registration time:
 *  - PAPERCLIP_DATA_DIR points at $HOME/.wavex-os so plugin state lands
 *    inside the wavex root
 *  - WAVEX_OS_CLAUDE_BIN is set so tier-router T2 calls reach the operator's
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
import { registerPoolBHealthRoutes } from "./routes/pool-b-health.js";
import { registerDevicePairingRoutes } from "./routes/device-pairing.js";
import { registerPillar5TestSendRoute } from "./routes/pillar5-test-send.js";
import { registerCredentialRoutes } from "./routes/credentials.js";
import { registerRegenerateImprintRoute } from "./routes/regenerate-imprint.js";
import { registerRefinementRoutes } from "./routes/refinement.js";
import { registerActivateRoute } from "./routes/activate.js";
import { registerResetRoute } from "./routes/reset.js";
import { registerSwapTemplateRoute } from "./routes/swap-template.js";
import { registerInferenceStatusRoute } from "./routes/inference-status.js";
import { registerDeviceStatusRoute } from "./routes/device-status.js";
import { registerSystemHealthRoute } from "./routes/system-health.js";
import { registerSystemActionsRoute } from "./routes/system-actions.js";
import { registerPillarSuggestPoolBRoute } from "./routes/pillar-suggest-pool-b.js";
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
import { registerConnectorsMarketplaceRoute } from "./routes/connectors-marketplace.js";
import { registerMcNarrateRoute } from "./routes/mc-narrate.js";
import { registerActivationEventsRoute } from "./routes/activation-events.js";
import { registerUserRoutes } from "./routes/users.js";
import { registerPartnerEventsRoutes } from "./routes/partner-events.js";
import { registerPartnerChecklistRoutes } from "./routes/partner-checklist.js";
import { registerUpsellSignalsRoutes } from "./routes/upsell-signals.js";
import { registerAuthEventsRoute } from "./routes/auth-events.js";
import { registerSmokeTestEventsRoute } from "./routes/smoke-test-events.js";
import { registerSmokeTestTriggerRoute } from "./routes/smoke-test-trigger.js";
import { registerWizardEventsRoute } from "./routes/wizard-events.js";
import { registerReferralRoutes } from "./routes/referrals.js";
import { registerGitHubReposRoute } from "./routes/github-repos.js";
import { registerMissionControlRoutes } from "./routes/mission-control.js";
import { startReferralEmailBScheduler } from "./jobs/referral-email-b.js";
import { startProfessionalReengagementScheduler } from "./jobs/professional-reengagement.js";
import { registerReengagementRoutes } from "./routes/reengagement.js";

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

export function registerWavexOsRoutes(app: FastifyInstance): void {
  bootstrap();
  registerPillarRoutes(app);
  registerPhaseRoutes(app);
  registerProbeRoutes(app);
  registerInstanceRoutes(app);
  registerInferenceAllocationRoute(app);
  registerObservabilityRoutes(app);
  registerPoolBHealthRoutes(app);
  registerDevicePairingRoutes(app);
  registerPillar5TestSendRoute(app);
  registerCredentialRoutes(app);
  registerRegenerateImprintRoute(app);
  registerRefinementRoutes(app);
  registerActivateRoute(app);
  registerResetRoute(app);
  registerSwapTemplateRoute(app);
  registerInferenceStatusRoute(app);
  registerDeviceStatusRoute(app);
  registerSystemHealthRoute(app);
  registerSystemActionsRoute(app);
  registerPillarSuggestPoolBRoute(app);
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
  registerConnectorsMarketplaceRoute(app);
  registerMcNarrateRoute(app);
  registerActivationEventsRoute(app);
  registerUserRoutes(app);
  registerPartnerEventsRoutes(app);
  registerPartnerChecklistRoutes(app);
  registerUpsellSignalsRoutes(app);
  registerAuthEventsRoute(app);
  registerSmokeTestEventsRoute(app);
  registerSmokeTestTriggerRoute(app);
  registerWizardEventsRoute(app);
  registerReferralRoutes(app);
  registerGitHubReposRoute(app);
  registerMissionControlRoutes(app);
  registerReengagementRoutes(app);
  startReferralEmailBScheduler();
  startProfessionalReengagementScheduler();
}

export { applyStateBridge, getInstanceDir, getOnboardingDir, getWavexDataRoot } from "./state-bridge.js";
