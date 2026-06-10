/** Fire-and-forget client for the Paperclip core inference-hook surface.
 *
 *  Onboarding/bridge/connector errors in THIS process (port 3101) post to
 *  POST :3100/api/hooks/emit so they land on the same surface as in-fleet
 *  events: activity-logged as inference_hook.* and, when configured, the
 *  middleware fixer agent is woken to diagnose. companyId may be a wavex
 *  slug ("wavexcard") — core resolves it to the Paperclip company UUID.
 *
 *  Never throws, never blocks the caller: an unreachable core or a 4xx is
 *  swallowed (the local console log remains the fallback signal).
 */

const CORE_BASE = process.env.PAPERCLIP_CORE_URL ?? "http://127.0.0.1:3100";

export function emitInferenceHookEvent(event: {
  type: "onboarding_error" | "connector_failed" | "run_failed";
  companyId: string;
  errorCode?: string;
  detail?: string;
}): void {
  void fetch(`${CORE_BASE}/api/hooks/emit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: event.type,
      companyId: event.companyId,
      errorCode: event.errorCode ?? null,
      detail: (event.detail ?? "").slice(0, 500),
    }),
  }).catch(() => {
    /* core unreachable — console logs remain the fallback */
  });
}
