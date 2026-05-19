/** Pool B inference fallback — called by the browser-side cloudInference()
 *  helper after the 60s Realtime timeout when the operator's Mac is
 *  offline or rate-limited.
 *
 *  Flow:
 *    1. Browser publishes on `wavex-inference-request:<uid>` Realtime
 *       channel and subscribes to the response channel.
 *    2. If no response in 60s (operator Mac maxed out / offline), the
 *       browser POSTs the same payload here.
 *    3. This function validates the caller's JWT, calls Anthropic with
 *       the operator-owned ANTHROPIC_API_KEY (Supabase secret), and
 *       returns the response JSON directly — no Realtime round-trip.
 *    4. Logs to `wavex_os.usage_ledger` with `pool='B'` and
 *       `device_id=NULL` so operators can attribute fallback usage
 *       separately from Mac-served usage in the Pool B Health widget.
 *
 *  Why an HTTP function vs a long-running Realtime listener:
 *  Edge Functions don't run persistently — they spin up per request and
 *  exit. They can't subscribe to a Realtime channel and wait. The
 *  browser is the right place to detect "operator's Mac didn't answer"
 *  because it owns the timeout clock.
 *
 *  Cost shape: defaults to claude-haiku-4-5 for cheap onboarding-grade
 *  fallback. Each call costs operator <$0.005 for typical pillar-suggest
 *  size (~500 input tokens, ~200 output). If the operator wants the
 *  fallback to also serve Sonnet/Opus requests, they can extend the
 *  model whitelist below — but the fallback should generally degrade to
 *  cheaper models since the customer's flow is already in a recovery
 *  path.
 *
 *  Deploy:
 *    1. Create an Anthropic API key at console.anthropic.com (NOT the
 *       CLI session token — a dedicated API key for backend use).
 *    2. Add it to Supabase project secrets:
 *         supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
 *    3. Deploy:
 *         supabase functions deploy wavex-inference-fallback
 *    4. Update the consumer's cloudInference.ts to call this on timeout
 *       (follow-up PR in wavex-experience-architect).
 *
 *  If ANTHROPIC_API_KEY is not set, every call returns 503 with a
 *  structured error — the browser side falls back gracefully (existing
 *  60s timeout path), so a missing key degrades silently. */

import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.57.2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { ...corsHeaders, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

/** Model whitelist. Anything not on this list gets remapped to Haiku to
 *  keep fallback cost bounded. Operators can extend by editing this
 *  array + redeploying the function. */
const FALLBACK_ALLOWED_MODELS = new Set<string>([
  "claude-haiku-4-5-20251001",
  "claude-haiku-4-5",
  "claude-sonnet-4-6",
]);
const DEFAULT_FALLBACK_MODEL = "claude-haiku-4-5-20251001";

interface InferenceRequest {
  request_id?: string;
  prompt?: string;
  max_output_tokens?: number;
  purpose?: string;
  model?: string;
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "method_not_allowed" }, { status: 405 });
  }

  // Caller auth — must be a logged-in user (or device JWT) so we don't
  // serve anonymous Anthropic calls on the operator's dime.
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return jsonResponse({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const supabaseAnon = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const service = createClient(
    supabaseUrl,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

  // Verify the JWT via supabase-js so we get the caller's user_id.
  const userClient = createClient(supabaseUrl, supabaseAnon, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user?.id) {
    return jsonResponse({ ok: false, error: "invalid_token" }, { status: 401 });
  }
  const userId = userData.user.id;

  // The fallback API key. Deliberately not throwing if absent — log and
  // return 503 so the browser falls back to its existing failure mode
  // (empty pillar suggestions, hardcoded narration copy).
  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!anthropicKey) {
    return jsonResponse({
      ok: false,
      error: "fallback_unavailable",
      detail: "ANTHROPIC_API_KEY is not configured on the Supabase project.",
    }, { status: 503 });
  }

  let body: InferenceRequest;
  try {
    body = await req.json() as InferenceRequest;
  } catch {
    return jsonResponse({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  if (!body.prompt || body.prompt.length === 0) {
    return jsonResponse({ ok: false, error: "missing_prompt" }, { status: 400 });
  }

  const requestedModel = body.model ?? DEFAULT_FALLBACK_MODEL;
  const model = FALLBACK_ALLOWED_MODELS.has(requestedModel) ? requestedModel : DEFAULT_FALLBACK_MODEL;
  const maxTokens = Math.min(Math.max(body.max_output_tokens ?? 1500, 1), 4096);
  const purpose = body.purpose ?? "fallback";
  const requestId = body.request_id ?? crypto.randomUUID();

  // Subscription gate: only paying customers get fallback inference.
  // Free tier hitting the fallback would be free service on the
  // operator's Anthropic bill — kill that immediately.
  const { data: subData } = await service.rpc("wavex_os_subscription_lookup_by_user", { p_user_id: userId });
  const subRow = Array.isArray(subData) ? subData[0] : subData;
  const subStatus = subRow ? String((subRow as { status?: string }).status ?? "") : "";
  if (!["active", "trialing"].includes(subStatus)) {
    return jsonResponse({
      ok: false,
      error: "subscription_required",
      detail: "Pool B fallback inference requires an active or trialing subscription.",
    }, { status: 402 });
  }

  // Call Anthropic. Single-turn user message, no streaming (the browser
  // is awaiting a single response after its Realtime timeout).
  const startMs = Date.now();
  let anthropicResp: Response;
  try {
    anthropicResp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: body.prompt } as AnthropicMessage],
      }),
    });
  } catch (err) {
    return jsonResponse({
      ok: false,
      error: "anthropic_request_failed",
      detail: err instanceof Error ? err.message : String(err),
    }, { status: 502 });
  }

  const durationMs = Date.now() - startMs;

  if (!anthropicResp.ok) {
    const errorBody = await anthropicResp.text();
    return jsonResponse({
      ok: false,
      error: "anthropic_error",
      status: anthropicResp.status,
      detail: errorBody.slice(0, 500),
    }, { status: anthropicResp.status >= 500 ? 502 : 400 });
  }

  const result = await anthropicResp.json() as {
    content?: Array<{ type: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
    model?: string;
  };
  const content = (result.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("");

  // Audit ledger row — operator can see fallback usage in the Pool B
  // Health widget. device_id=NULL distinguishes fallback from
  // Mac-served calls; subscription_id ties spend to the caller for the
  // daily-spend roll-up.
  const inputTokens = result.usage?.input_tokens ?? 0;
  const outputTokens = result.usage?.output_tokens ?? 0;
  const cacheReadTokens = result.usage?.cache_read_input_tokens ?? 0;
  // Rough cost model: pull from the same pricing table the Mac worker
  // uses. Hardcoded here to keep the edge function dependency-free;
  // amounts in $/MTok input, $/MTok output.
  const PRICING: Record<string, { input: number; output: number }> = {
    "claude-haiku-4-5-20251001": { input: 0.8, output: 4 },
    "claude-haiku-4-5":          { input: 0.8, output: 4 },
    "claude-sonnet-4-6":         { input: 3, output: 15 },
  };
  const p = PRICING[result.model ?? model] ?? PRICING[DEFAULT_FALLBACK_MODEL];
  const costCents = Math.round(
    ((inputTokens * p.input) + (outputTokens * p.output)) / 1000 * 100,
  );

  // Fire-and-forget ledger write. Falls through if the RPC is missing —
  // never blocks the response.
  await service.rpc("wavex_os_record_usage", {
    p_pool: "B",
    p_subscription_id: subRow ? (subRow as { id?: string }).id ?? null : null,
    p_request_id: requestId,
    p_model: result.model ?? model,
    p_prompt_tokens: inputTokens,
    p_completion_tokens: outputTokens,
    p_cache_read_tokens: cacheReadTokens,
    p_cache_creation_tokens: 0,
    p_cost_cents: costCents,
    p_status: "ok",
    p_device_id: null,
    p_error_class: null,
    p_install_id: null,
    p_email: null,
    p_ip_24: null,
    p_deliverable_id: null,
    p_agent_id: null,
  }).then((r: { error: unknown }) => {
    if (r.error) console.error("wavex_os_record_usage (fallback) failed", r.error);
  }).catch(() => { /* swallow */ });

  return jsonResponse({
    ok: true,
    content,
    request_id: requestId,
    model: result.model ?? model,
    duration_ms: durationMs,
    source: "fallback",
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cache_read_tokens: cacheReadTokens,
      cost_cents: costCents,
    },
  });
});
