/**
 * Supabase Realtime worker — Mac rendezvous half.
 *
 * Pairs with `packages/cloud-client/`. The operator Mac connects OUTWARD to
 * Supabase Realtime (no public HTTPS endpoint required), wildcard-subscribes
 * to `wavex-inference-request:<user_id>` channels, validates the device JWT
 * inside each request, calls Anthropic via the OAuth path, then broadcasts
 * the response on `wavex-inference-response:<user_id>`. Also records each
 * call in `wavex_os.usage_ledger`.
 *
 * Why this exists alongside `routes/os-paid.ts`:
 *   Both implement the same auth + Anthropic + ledger flow. HTTP route is
 *   kept for local smoke + fallback; Realtime is the production transport
 *   that sidesteps NAT-traversal (no Cloudflare/ngrok needed pointing at
 *   the Mac).
 *
 * Channel naming (frozen contract — cloud-client subagent reads the same):
 *   wavex-inference-request:<user_id>   ← customer publishes; Mac subscribes
 *   wavex-inference-response:<user_id>  ← Mac publishes; customer subscribes
 *
 * Realtime broadcast event name: `wavex-inference`.
 *
 * Topic discovery:
 *   Supabase Realtime channels are joined by exact topic; there's no native
 *   wildcard. We resolve the set of user_ids to subscribe to by:
 *     1. WAVEX_OS_REALTIME_USER_IDS env (comma-separated, takes precedence)
 *     2. RPC `wavex_os_active_user_ids` if it exists (graceful fallback)
 *   Periodic refresh (60s) picks up newly-paired users without a restart.
 *
 * Skip env hooks (for smoke + tests):
 *   WAVEX_OS_INFERENCE_SKIP_SUB=1   bypass subscription gating
 *   WAVEX_OS_INFERENCE_MOCK=1       short-circuit Anthropic call (returns
 *                                    a canned response; ledger row still
 *                                    written but with zero cost)
 *   WAVEX_OS_REALTIME_DISABLED=1    do not start the worker at all
 */
import { createClient, type SupabaseClient, type RealtimeChannel } from "@supabase/supabase-js";
import { verifyDeviceJwt } from "@wavex-os/auth-shim";
import {
  callAnthropicOAuthRaw,
  inferenceBackend,
  type AnthropicMessagesResponse,
} from "../lib/anthropic-oauth.js";
import { runPoolBPromptCoverage } from "../lib/pool-b-prompt-coverage.js";
import { prefetchUrlsInPrompt } from "../lib/url-prefetch.js";
import { incrementCounter, setIfAbsent, setAdd } from "../lib/rate-limit.js";
import {
  appendPoolBAuditEvent,
  isPoolBEnabled,
  poolBDisabledMessage,
  poolBIdempotencyTtlSec,
  poolBProviderMode,
  poolBRateLimitMaxRequests,
  poolBRateLimitWindowSec,
} from "../lib/pool-b-control.js";
import {
  buildInferenceAuditRpcBody,
  parseInferenceRequestMeta,
  sha256Hex,
  sha256Json,
  serializedCharCount,
  type PoolBRemoteAuditEvent,
} from "../lib/inference-audit.js";

const REQUEST_TOPIC_PREFIX = "wavex-inference-request:";
const RESPONSE_TOPIC_PREFIX = "wavex-inference-response:";
const BROADCAST_EVENT = "wavex-inference";

// Anthropic-Messages-API variant — used by the customer-side proxy that
// fronts Claude Code. Same auth + ledger contract as BROADCAST_EVENT, but
// the payload is the FULL Messages API shape (messages[], tools, system).
//
// DEPRECATED (2026-05-17): This handler was the Mac half of the
// claude-code-proxy round-trip. WaveX OS pivoted to BYOC (Bring Your
// Own Claude) for customer-side inference — the customer's local claude
// CLI handles wizard suggestions + doctor fixes using their OWN Anthropic
// account. The handler stays subscribed (no functional change) in case
// the proxy comes back under a tighter trust model, but no current
// customer install publishes to these channels. See
// packages/claude-code-proxy/README.md for the deprecation rationale.
const ANTHROPIC_REQUEST_TOPIC_PREFIX = "wavex-anthropic-messages-request:";
const ANTHROPIC_RESPONSE_TOPIC_PREFIX = "wavex-anthropic-messages-response:";
const ANTHROPIC_BROADCAST_EVENT = "anthropic-messages";
const REFRESH_INTERVAL_MS = 60_000;
const DEFAULT_MODEL = process.env.WAVEX_OS_INFERENCE_MODEL ?? "claude-sonnet-4-6";
const MAX_OUTPUT_TOKENS_HARD = 8000;
const ACTIVE_STATUSES = new Set(["trialing", "active", "past_due"]);

// ── Anonymous onboarding lane (Pool A) ──────────────────────────────────
// ONE shared channel (no user_id suffix, no device_jwt) for the pre-auth
// onboarding wizard. Customers publish here; we serve the call with the
// operator's rotating Claude Max OAuth (callAnthropicOAuth) and reply on
// `wavex-onboarding-response:<request_id>`. Realtime gives us no caller IP,
// so the global hourly cap + the Pool A daily $ kill-switch are the abuse
// backstops.
const ONBOARDING_REQUEST_TOPIC = "wavex-onboarding-request";
const ONBOARDING_RESPONSE_TOPIC_PREFIX = "wavex-onboarding-response:";
const ONBOARDING_MODEL = process.env.WAVEX_ONBOARDING_MODEL ?? "claude-haiku-4-5-20251001";
const ONBOARDING_MAX_OUTPUT_TOKENS = 1500;
const ONBOARDING_RATE_WINDOW_SEC = 3600;
const ONBOARDING_LIFETIME_WINDOW_SEC = 30 * 24 * 3600; // 30 days
const ONBOARDING_GLOBAL_RATE_MAX = parseInt(process.env.WAVEX_ONBOARDING_RATE_MAX ?? "400", 10);
// Per-install caps tuned so a full wizard run (~8-9 calls) plus retries fits.
const ONBOARDING_PER_INSTALL_HR_MAX = parseInt(process.env.WAVEX_ONBOARDING_PER_INSTALL_HR_MAX ?? "40", 10);
const ONBOARDING_PER_INSTALL_LIFETIME_MAX = parseInt(process.env.WAVEX_ONBOARDING_PER_INSTALL_LIFETIME_MAX ?? "150", 10);
const ONBOARDING_INSTALLS_PER_EMAIL_MAX = parseInt(process.env.WAVEX_ONBOARDING_INSTALLS_PER_EMAIL_MAX ?? "5", 10);
const POOL_A_DAILY_CAP_CENTS = parseInt(process.env.POOL_A_DAILY_CAP_CENTS ?? "1000", 10);

// ── Connector lane (Composio OAuth + manifest, from the published domain) ─
// A thin, allowlisted HTTP-over-Realtime proxy to the local wavex-os-server
// (:3101). The published SPA can't reach the Mac directly, so it publishes on
// the shared `wavex-connector-request` channel; we relay the call to the
// server's connector routes (initiate OAuth, list connections, generate
// manifest) and reply on `wavex-connector-response:<request_id>`. Path is
// allowlisted so this can't be used to hit arbitrary :3101 routes.
const CONNECTOR_REQUEST_TOPIC = "wavex-connector-request";
const CONNECTOR_RESPONSE_TOPIC_PREFIX = "wavex-connector-response:";
const CONNECTOR_SERVER_URL = (process.env.WAVEX_CONNECTOR_SERVER_URL ?? "http://127.0.0.1:3101").replace(/\/+$/, "");
const CONNECTOR_ALLOWED_PREFIXES = [
  "/wavex-os/onboarding/connectors",
  "/wavex-os/onboarding/connector-manifest",
  "/wavex-os/onboarding/connector-recommendations",
];
const CONNECTOR_RATE_WINDOW_SEC = 3600;
const CONNECTOR_GLOBAL_RATE_MAX = parseInt(process.env.WAVEX_CONNECTOR_RATE_MAX ?? "600", 10);

type Logger = {
  info: (msg: Record<string, unknown> | string, ...args: unknown[]) => void;
  warn: (msg: Record<string, unknown> | string, ...args: unknown[]) => void;
  error: (msg: Record<string, unknown> | string, ...args: unknown[]) => void;
};

interface RequestPayload {
  request_id?: unknown;
  device_jwt?: unknown;
  prompt?: unknown;
  model?: unknown;
  max_output_tokens?: unknown;
  purpose?: unknown;
  session_id?: unknown;
  conversation_id?: unknown;
  trace_id?: unknown;
  client_name?: unknown;
  client_version?: unknown;
  source?: unknown;
  context_input_tokens?: unknown;
  message_count?: unknown;
}

interface SubscriptionRow {
  id: string;
  status: string;
  tier?: string;
}

interface DeviceRow {
  id: string;
  user_id: string;
  status: string;
  name?: string | null;
  last_seen_at?: string | null;
}

// USD per 1M tokens — public list-price table keyed by model id.
// Source: anthropic.com/pricing as of 2026-05.
const ANTHROPIC_PRICING: Record<
  string,
  { input: number; output: number; cached_input: number; cache_creation: number }
> = {
  "claude-sonnet-4-6": { input: 3, output: 15, cached_input: 0.3, cache_creation: 3.75 },
  "claude-sonnet-4-5": { input: 3, output: 15, cached_input: 0.3, cache_creation: 3.75 },
  "claude-opus-4-7": { input: 15, output: 75, cached_input: 1.5, cache_creation: 18.75 },
  "claude-haiku-4-5": { input: 0.8, output: 4, cached_input: 0.08, cache_creation: 1 },
};

function calcCostUsd(
  model: string,
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  },
): number {
  // Resolve pricing by exact id, then prefix-match fallback (e.g. "claude-haiku-…").
  const p =
    ANTHROPIC_PRICING[model] ??
    Object.entries(ANTHROPIC_PRICING).find(([k]) => model.startsWith(k))?.[1] ??
    ANTHROPIC_PRICING["claude-sonnet-4-6"];
  return (
    (usage.input_tokens * p.input +
      usage.output_tokens * p.output +
      (usage.cache_read_input_tokens ?? 0) * p.cached_input +
      (usage.cache_creation_input_tokens ?? 0) * p.cache_creation) /
    1_000_000
  );
}

async function lookupActiveSubscription(
  supabase: SupabaseClient,
  subjectId: string,
): Promise<{ ok: true; row: SubscriptionRow } | { ok: false; error: string }> {
  // Resolve subscription via user_id (JWT's sub-claim). Uses the
  // wavex_os_subscription_lookup_by_user RPC which returns the most recent
  // active/trialing/past_due row for the given user_id.
  const { data, error } = await supabase.rpc("wavex_os_subscription_lookup_by_user", {
    p_user_id: subjectId,
  });
  if (error) return { ok: false, error: "subscription_lookup_failed" };
  const rows = data as SubscriptionRow[] | null;
  const row = rows?.[0];
  if (!row) return { ok: false, error: "subscription_not_found" };
  if (!ACTIVE_STATUSES.has(row.status)) return { ok: false, error: "subscription_expired" };
  return { ok: true, row };
}

async function writeLedger(
  supabase: SupabaseClient,
  row: {
    pool: "B";
    subscription_id: string;
    request_id: string;
    model: string;
    prompt_tokens: number;
    completion_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    cost_cents: number;
    status: "ok" | "error" | "rate_limited" | "cap_hit";
    device_id?: string;
    error_class?: string;
  },
  log: Logger,
): Promise<void> {
  // Routes through public.wavex_os_record_usage (SECURITY DEFINER RPC) because
  // `wavex_os` is not in PostgREST's db-schemas list, so a direct
  // .schema('wavex_os').from('usage_ledger').insert() returns PGRST106.
  const result = await supabase.rpc("wavex_os_record_usage", {
      p_pool: row.pool,
      p_subscription_id: row.subscription_id,
      p_request_id: row.request_id,
      p_model: row.model,
      p_prompt_tokens: row.prompt_tokens,
      p_completion_tokens: row.completion_tokens,
      p_cache_read_tokens: row.cache_read_tokens,
      p_cache_creation_tokens: row.cache_creation_tokens,
      p_cost_cents: row.cost_cents,
      p_status: row.status,
      p_device_id: row.device_id ?? null,
      p_error_class: row.error_class ?? null,
    });
  if (result.error) {
    log.warn({ err: result.error, request_id: row.request_id }, "usage_ledger insert failed");
  }
}

async function writeInferenceAudit(
  supabase: SupabaseClient,
  row: PoolBRemoteAuditEvent,
  log: Logger,
): Promise<void> {
  const result = await supabase.rpc(
    "wavex_os_record_inference_audit",
    buildInferenceAuditRpcBody(row),
  );
  if (result.error) {
    log.warn({ err: result.error, request_id: row.request_id, attempt_no: row.attempt_no }, "inference audit insert failed");
  }
}

async function lookupDevice(
  supabase: SupabaseClient,
  subjectId: string,
  deviceId: string,
): Promise<{ ok: true; row: DeviceRow } | { ok: false; error: string }> {
  const { data, error } = await supabase.rpc("wavex_os_device_lookup", {
    p_user_id: subjectId,
    p_device_id: deviceId,
  });
  if (error) return { ok: false, error: "device_lookup_failed" };
  const rows = data as DeviceRow[] | null;
  const row = rows?.[0];
  if (!row) return { ok: false, error: "device_not_found" };
  if (row.status === "revoked") return { ok: false, error: "device_revoked" };
  return { ok: true, row };
}

async function enforcePoolBControls(args: {
  route: "realtime" | "anthropic-messages";
  requestId: string;
  userId: string;
  deviceId: string;
  model: string;
  started: number;
}): Promise<{ ok: true } | { ok: false; status: "disabled" | "duplicate" | "rate_limited"; detail: string }> {
  const { route, requestId, userId, deviceId, model, started } = args;

  if (!isPoolBEnabled()) {
    await appendPoolBAuditEvent({
      route,
      request_id: requestId,
      user_id: userId,
      device_id: deviceId,
      status: "disabled",
      outcome: "streaming_inference_disabled",
      duration_ms: Date.now() - started,
      model,
      error_class: "maintenance",
    });
    return { ok: false, status: "disabled", detail: poolBDisabledMessage() };
  }

  const duplicateKey = `pool-b:${route}:idempotency:${userId}:${requestId}`;
  const firstSeen = await setIfAbsent(duplicateKey, poolBIdempotencyTtlSec());
  if (!firstSeen) {
    await appendPoolBAuditEvent({
      route,
      request_id: requestId,
      user_id: userId,
      device_id: deviceId,
      status: "duplicate",
      outcome: "duplicate_request",
      duration_ms: Date.now() - started,
      model,
      error_class: "idempotency",
    });
    return { ok: false, status: "duplicate", detail: "duplicate_request" };
  }

  const bucket = Math.floor(Date.now() / (poolBRateLimitWindowSec() * 1000));
  const rateKey = `pool-b:${route}:rate:${userId}:${deviceId}:${bucket}`;
  const count = await incrementCounter(rateKey, poolBRateLimitWindowSec() + 60);
  if (count > poolBRateLimitMaxRequests()) {
    await appendPoolBAuditEvent({
      route,
      request_id: requestId,
      user_id: userId,
      device_id: deviceId,
      status: "rate_limited",
      outcome: "rate_limited",
      duration_ms: Date.now() - started,
      model,
      error_class: "rate_limit",
      detail: `count=${count}`,
    });
    return { ok: false, status: "rate_limited", detail: "rate_limited" };
  }

  return { ok: true };
}

/** Discover user_ids whose channels we should subscribe to. */
async function discoverUserIds(supabase: SupabaseClient, log: Logger): Promise<string[]> {
  const envIds = (process.env.WAVEX_OS_REALTIME_USER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (envIds.length > 0) return envIds;

  // Optional RPC — graceful fallback if it doesn't exist on the cloud side.
  try {
    const { data, error } = await supabase.rpc("wavex_os_active_user_ids");
    if (!error && Array.isArray(data)) {
      const ids = (data as Array<string | { user_id?: string }>)
        .map((r) => (typeof r === "string" ? r : r?.user_id ?? ""))
        .filter(Boolean);
      if (ids.length > 0) return ids;
    }
  } catch (e) {
    log.warn({ err: (e as Error).message }, "active_user_ids RPC unavailable; relying on env");
  }
  return [];
}

async function handleRequest(args: {
  supabase: SupabaseClient;
  topicUserId: string;
  payload: RequestPayload;
  log: Logger;
}): Promise<void> {
  const { supabase, topicUserId, payload, log } = args;
  const started = Date.now();
  const meta = parseInferenceRequestMeta(payload as Record<string, unknown>, {
    source: "realtime",
    client_name: "cloud-client",
  });

  // Parse + shape-validate. Anything malformed gets a warn + ignore so a
  // garbage publish can't crash the worker.
  const request_id = typeof payload.request_id === "string" ? payload.request_id : null;
  const device_jwt = typeof payload.device_jwt === "string" ? payload.device_jwt : null;
  const prompt = typeof payload.prompt === "string" ? payload.prompt : null;
  const model = typeof payload.model === "string" ? payload.model : DEFAULT_MODEL;
  const maxOut = Math.min(
    typeof payload.max_output_tokens === "number" && payload.max_output_tokens > 0
      ? payload.max_output_tokens
      : 1024,
    MAX_OUTPUT_TOKENS_HARD,
  );

  if (!request_id || !device_jwt || !prompt) {
    log.warn({ topicUserId, hasReqId: !!request_id }, "ignoring malformed realtime request");
    return;
  }
  const promptHash = sha256Hex(prompt);

  // Default response topic is the topic the request arrived on. If the JWT
  // verifies and carries a different sub, prefer that — keeps the response
  // routed to the actual user even if a wrong-channel publish happens.
  let responseUserId = topicUserId;
  const respond = async (body: Record<string, unknown>): Promise<void> => {
    try {
      const ch = supabase.channel(`${RESPONSE_TOPIC_PREFIX}${responseUserId}`);
      await new Promise<void>((resolve) => {
        ch.subscribe((status) => {
          if (status === "SUBSCRIBED" || status === "CHANNEL_ERROR" || status === "TIMED_OUT") resolve();
        });
        // Belt-and-suspenders: don't hang forever on broken realtime
        setTimeout(resolve, 5_000);
      });
      await ch.send({ type: "broadcast", event: BROADCAST_EVENT, payload: body });
      await supabase.removeChannel(ch);
    } catch (e) {
      log.error({ err: (e as Error).message, request_id }, "response broadcast failed");
    }
  };

  // JWT verify
  const v = verifyDeviceJwt(device_jwt);
  if (!v.ok || !v.payload) {
    log.warn({ topicUserId, request_id, reason: v.reason }, "device JWT verify failed");
    await appendPoolBAuditEvent({
      route: "realtime",
      request_id,
      user_id: null,
      device_id: null,
      status: "rejected",
      outcome: "device_jwt_invalid",
      duration_ms: Date.now() - started,
      model,
      error_class: v.reason ?? "auth",
    });
    await writeInferenceAudit(
      supabase,
      {
        pool: "B",
        route: "realtime",
        request_id,
        attempt_no: 0,
        provider: "control-plane",
        fallback_mode: poolBProviderMode(),
        status: "rejected",
        outcome: "device_jwt_invalid",
        error_class: v.reason ?? "auth",
        duration_ms: Date.now() - started,
        prompt_chars: prompt.length,
        prompt_sha256: promptHash,
        ...meta,
      },
      log,
    );
    await respond({
      request_id,
      ok: false,
      error: "no_paired_device",
      message: `device JWT invalid: ${v.reason ?? "unknown"}`,
    });
    return;
  }
  responseUserId = v.payload.sub;

  const poolBControl = await enforcePoolBControls({
    route: "realtime",
    requestId: request_id,
    userId: v.payload.sub,
    deviceId: v.payload.device_id,
    model,
    started,
  });
  if (!poolBControl.ok) {
    await writeInferenceAudit(
      supabase,
      {
        pool: "B",
        route: "realtime",
        request_id,
        attempt_no: 0,
        user_id: v.payload.sub,
        device_id: v.payload.device_id,
        provider: "control-plane",
        fallback_mode: poolBProviderMode(),
        model,
        status:
          poolBControl.status === "disabled"
            ? "disabled"
            : poolBControl.status === "duplicate"
              ? "duplicate"
              : "rate_limited",
        outcome: poolBControl.detail,
        error_class:
          poolBControl.status === "disabled"
            ? "maintenance"
            : poolBControl.status === "duplicate"
              ? "idempotency"
              : "rate_limit",
        duration_ms: Date.now() - started,
        prompt_chars: prompt.length,
        prompt_sha256: promptHash,
        ...meta,
      },
      log,
    );
    await respond({
      request_id,
      ok: false,
      error: poolBControl.status === "disabled" ? "internal" : "rate_limited",
      message: poolBControl.detail,
    });
    return;
  }

  const device = await lookupDevice(supabase, v.payload.sub, v.payload.device_id);
  if (!device.ok) {
    await appendPoolBAuditEvent({
      route: "realtime",
      request_id,
      user_id: v.payload.sub,
      device_id: v.payload.device_id,
      status: "rejected",
      outcome: device.error,
      duration_ms: Date.now() - started,
      model,
      error_class: "auth",
    });
    await writeInferenceAudit(
      supabase,
      {
        pool: "B",
        route: "realtime",
        request_id,
        attempt_no: 0,
        user_id: v.payload.sub,
        device_id: v.payload.device_id,
        provider: "control-plane",
        fallback_mode: poolBProviderMode(),
        model,
        status: "rejected",
        outcome: device.error,
        error_class: "auth",
        duration_ms: Date.now() - started,
        prompt_chars: prompt.length,
        prompt_sha256: promptHash,
        ...meta,
      },
      log,
    );
    await respond({
      request_id,
      ok: false,
      error: "no_paired_device",
      message: device.error,
    });
    return;
  }

  // Subscription gating. We capture subscriptionId here regardless of the
  // SKIP_SUB hook so the ledger row can attribute cost to the right sub.
  // (If SKIP_SUB=1 there's no active sub to attribute to → leave undefined
  // and skip the insert below; we don't have a subscription_id NOT NULL
  // requirement but FK integrity matters more than a synthetic row.)
  let subscriptionId: string | null = null;
  if (process.env.WAVEX_OS_INFERENCE_SKIP_SUB !== "1") {
    const sub = await lookupActiveSubscription(supabase, v.payload.sub);
    if (!sub.ok) {
      const errorCode =
        sub.error === "subscription_expired"
          ? "no_active_subscription"
          : sub.error === "subscription_not_found"
            ? "no_active_subscription"
            : "internal";
      await respond({
        request_id,
        ok: false,
        error: errorCode,
        message: sub.error,
      });
      log.info(
        { request_id, user_id: v.payload.sub, outcome: errorCode, duration_ms: Date.now() - started },
        "realtime request rejected",
      );
      await appendPoolBAuditEvent({
        route: "realtime",
        request_id,
        user_id: v.payload.sub,
        device_id: v.payload.device_id,
        status: "rejected",
        outcome: errorCode,
        duration_ms: Date.now() - started,
        model,
        error_class: "auth",
      });
      await writeInferenceAudit(
        supabase,
        {
          pool: "B",
          route: "realtime",
          request_id,
          attempt_no: 0,
          user_id: v.payload.sub,
          device_id: v.payload.device_id,
          provider: "control-plane",
          fallback_mode: poolBProviderMode(),
          model,
          status: "rejected",
          outcome: sub.error,
          error_class: "auth",
          duration_ms: Date.now() - started,
          prompt_chars: prompt.length,
          prompt_sha256: promptHash,
          ...meta,
        },
        log,
      );
      return;
    }
    subscriptionId = sub.row.id;
  }

  if (process.env.WAVEX_OS_INFERENCE_MOCK === "1") {
    const usageInput = Math.max(1, Math.ceil(prompt.length / 4));
    const usageOutput = 2;
    const durationMs = Date.now() - started;
    await respond({
      request_id,
      ok: true,
      content: "[MOCK] ok",
      model,
      provider: "mock",
      provider_response_id: `mock_${request_id}`,
      fallback_used: false,
      usage: {
        input_tokens: usageInput,
        output_tokens: usageOutput,
        cached_input_tokens: 0,
        cost_usd: 0,
        duration_ms: durationMs,
      },
    });
    await writeInferenceAudit(
      supabase,
      {
        pool: "B",
        route: "realtime",
        request_id,
        attempt_no: 1,
        user_id: v.payload.sub,
        subscription_id: subscriptionId,
        device_id: device.row.id,
        provider: "mock",
        fallback_mode: poolBProviderMode(),
        model,
        status: "accepted",
        outcome: "ok",
        duration_ms: durationMs,
        prompt_chars: prompt.length,
        prompt_sha256: promptHash,
        prompt_tokens: usageInput,
        completion_tokens: usageOutput,
        cost_cents: 0,
        ...meta,
      },
      log,
    );
    await appendPoolBAuditEvent({
      route: "realtime",
      request_id,
      user_id: v.payload.sub,
      device_id: device.row.id,
      status: "accepted",
      outcome: "ok",
      duration_ms: durationMs,
      model,
      cost_cents: 0,
    });
    log.info(
      { request_id, user_id: v.payload.sub, outcome: "ok", duration_ms: durationMs, cost_cents: 0 },
      "realtime request served",
    );
    return;
  }

  const result = await runPoolBPromptCoverage({
    prompt,
    requestedModel: model,
    maxTokens: maxOut,
    metadata: {
      wavex_request_id: request_id,
      wavex_route: "realtime",
      wavex_session_id: meta.session_id ?? "",
    },
  });

  for (const attempt of result.attempts) {
    await writeInferenceAudit(
      supabase,
      {
        pool: "B",
        route: "realtime",
        request_id,
        attempt_no: attempt.attempt_no,
        user_id: v.payload.sub,
        subscription_id: subscriptionId,
        device_id: device.row.id,
        provider: attempt.provider,
        fallback_mode: result.provider_mode,
        fallback_used: attempt.attempt_no > 1,
        provider_response_id: attempt.provider_response_id,
        model: attempt.provider_model,
        status: attempt.ok ? "accepted" : "failed",
        outcome: attempt.ok ? "ok" : "upstream_error",
        error_class: attempt.ok
          ? null
          : (typeof attempt.error?.status === "number" ? `http_${attempt.error.status}` : attempt.error?.code ?? "upstream"),
        duration_ms: Date.now() - started,
        prompt_chars: prompt.length,
        prompt_sha256: promptHash,
        prompt_tokens: attempt.usage?.input_tokens ?? null,
        completion_tokens: attempt.usage?.output_tokens ?? null,
        cache_read_tokens: attempt.usage?.cache_read_input_tokens ?? 0,
        cache_creation_tokens: attempt.usage?.cache_creation_input_tokens ?? 0,
        cost_cents: attempt.cost_cents ?? null,
        metadata: attempt.ok ? undefined : { error_message: attempt.error?.message ?? "provider_call_failed" },
        ...meta,
      },
      log,
    );
  }

  if (!result.ok) {
    const err = result.last_error;
    await appendPoolBAuditEvent({
      route: "realtime",
      request_id,
      user_id: v.payload.sub,
      device_id: device.row.id,
      status: "failed",
      outcome: "upstream_error",
      duration_ms: Date.now() - started,
      model,
      error_class: typeof err.status === "number" ? `http_${err.status}` : err.code ?? "upstream",
      detail: err.message ?? "provider_call_failed",
    });
    await respond({
      request_id,
      ok: false,
      error: "upstream_error",
      message: err.message ?? "provider_call_failed",
    });
    log.error(
      { err: err.message, request_id, user_id: v.payload.sub, duration_ms: Date.now() - started },
      "realtime request failed",
    );
    return;
  }

  const success = result.success;
  const durationMs = Date.now() - started;
  const costUsd = success.cost_cents === null ? 0 : success.cost_cents / 100;

  await respond({
    request_id,
    ok: true,
    content: success.content,
    model: success.model,
    provider: success.provider,
    provider_response_id: success.provider_response_id,
    fallback_used: success.fallback_used,
    usage: {
      input_tokens: success.usage.input_tokens,
      output_tokens: success.usage.output_tokens,
      cached_input_tokens: success.usage.cache_read_input_tokens,
      cost_usd: costUsd,
      duration_ms: durationMs,
    },
  });

  if (subscriptionId && success.provider === "anthropic_oauth" && success.cost_cents !== null) {
    await writeLedger(
      supabase,
      {
        pool: "B",
        subscription_id: subscriptionId,
        request_id,
        model: success.model,
        prompt_tokens: success.usage.input_tokens,
        completion_tokens: success.usage.output_tokens,
        cache_read_tokens: success.usage.cache_read_input_tokens,
        cache_creation_tokens: success.usage.cache_creation_input_tokens,
        cost_cents: success.cost_cents,
        status: "ok",
        device_id: device.row.id,
      },
      log,
    );
  }

  await appendPoolBAuditEvent({
    route: "realtime",
    request_id,
    user_id: v.payload.sub,
    device_id: device.row.id,
    status: "accepted",
    outcome: success.fallback_used ? "ok_via_fallback" : "ok",
    duration_ms: durationMs,
    model: success.model,
    cost_cents: success.cost_cents ?? undefined,
  });
  log.info(
    {
      request_id,
      user_id: v.payload.sub,
      outcome: success.fallback_used ? "ok_via_fallback" : "ok",
      duration_ms: durationMs,
      cost_cents: success.cost_cents ?? 0,
      provider: success.provider,
    },
    "realtime request served",
  );
}

interface AnthropicRequestPayload {
  request_id?: unknown;
  device_jwt?: unknown;
  anthropic_request?: unknown;
  purpose?: unknown;
  session_id?: unknown;
  conversation_id?: unknown;
  trace_id?: unknown;
  client_name?: unknown;
  client_version?: unknown;
  source?: unknown;
  context_input_tokens?: unknown;
  message_count?: unknown;
}

/** Handle a wavex-anthropic-messages-request:<user_id> broadcast.
 *  Same auth + ledger contract as handleRequest, but the payload IS the
 *  Anthropic Messages API request body (passed through callAnthropicOAuthRaw)
 *  and the response IS the Anthropic Messages API response body. Used by
 *  the customer-side claude-code-proxy package. */
async function handleAnthropicRequest(args: {
  supabase: SupabaseClient;
  topicUserId: string;
  payload: AnthropicRequestPayload;
  log: Logger;
}): Promise<void> {
  const { supabase, topicUserId, payload, log } = args;
  const started = Date.now();
  const meta = parseInferenceRequestMeta(payload as Record<string, unknown>, {
    source: "anthropic-messages",
    client_name: "claude-code-proxy",
  });

  const request_id = typeof payload.request_id === "string" ? payload.request_id : null;
  const device_jwt = typeof payload.device_jwt === "string" ? payload.device_jwt : null;
  const anthropic_request =
    payload.anthropic_request && typeof payload.anthropic_request === "object"
      ? (payload.anthropic_request as {
          model?: string;
          max_tokens?: number;
          messages?: Array<Record<string, unknown>>;
          system?: string | Array<Record<string, unknown>>;
          tools?: Array<Record<string, unknown>>;
          tool_choice?: Record<string, unknown>;
          temperature?: number;
          top_p?: number;
          top_k?: number;
          stop_sequences?: string[];
          metadata?: Record<string, unknown>;
        })
      : null;

  if (
    !request_id ||
    !device_jwt ||
    !anthropic_request ||
    typeof anthropic_request.model !== "string" ||
    typeof anthropic_request.max_tokens !== "number" ||
    !Array.isArray(anthropic_request.messages)
  ) {
    log.warn({ topicUserId, hasReqId: !!request_id }, "ignoring malformed anthropic-messages request");
    return;
  }
  const promptChars = serializedCharCount({
    system: anthropic_request.system ?? null,
    messages: anthropic_request.messages,
  });
  const promptHash = sha256Json({
    system: anthropic_request.system ?? null,
    messages: anthropic_request.messages,
  });
  const anthropicMeta = {
    ...meta,
    message_count: meta.message_count ?? anthropic_request.messages.length,
  };

  let responseUserId = topicUserId;
  const respond = async (body: Record<string, unknown>): Promise<void> => {
    try {
      const ch = supabase.channel(`${ANTHROPIC_RESPONSE_TOPIC_PREFIX}${responseUserId}`);
      await new Promise<void>((resolve) => {
        ch.subscribe((status) => {
          if (status === "SUBSCRIBED" || status === "CHANNEL_ERROR" || status === "TIMED_OUT") resolve();
        });
        setTimeout(resolve, 5_000);
      });
      await ch.send({ type: "broadcast", event: ANTHROPIC_BROADCAST_EVENT, payload: body });
      await supabase.removeChannel(ch);
    } catch (e) {
      log.error({ err: (e as Error).message, request_id }, "anthropic response broadcast failed");
    }
  };

  // JWT verify
  const v = verifyDeviceJwt(device_jwt);
  if (!v.ok || !v.payload) {
    log.warn({ topicUserId, request_id, reason: v.reason }, "device JWT verify failed (anthropic)");
    await appendPoolBAuditEvent({
      route: "anthropic-messages",
      request_id,
      user_id: null,
      device_id: null,
      status: "rejected",
      outcome: "device_jwt_invalid",
      duration_ms: Date.now() - started,
      model: anthropic_request.model,
      error_class: v.reason ?? "auth",
    });
    await writeInferenceAudit(
      supabase,
      {
        pool: "B",
        route: "anthropic-messages",
        request_id,
        attempt_no: 0,
        provider: "control-plane",
        fallback_mode: poolBProviderMode(),
        model: anthropic_request.model,
        status: "rejected",
        outcome: "device_jwt_invalid",
        error_class: v.reason ?? "auth",
        duration_ms: Date.now() - started,
        prompt_chars: promptChars,
        prompt_sha256: promptHash,
        ...anthropicMeta,
      },
      log,
    );
    await respond({
      request_id,
      ok: false,
      error: "no_paired_device",
      error_class: "auth",
      message: `device JWT invalid: ${v.reason ?? "unknown"}`,
    });
    return;
  }
  responseUserId = v.payload.sub;

  const poolBControl = await enforcePoolBControls({
    route: "anthropic-messages",
    requestId: request_id,
    userId: v.payload.sub,
    deviceId: v.payload.device_id,
    model: anthropic_request.model,
    started,
  });
  if (!poolBControl.ok) {
    await writeInferenceAudit(
      supabase,
      {
        pool: "B",
        route: "anthropic-messages",
        request_id,
        attempt_no: 0,
        user_id: v.payload.sub,
        device_id: v.payload.device_id,
        provider: "control-plane",
        fallback_mode: poolBProviderMode(),
        model: anthropic_request.model,
        status:
          poolBControl.status === "disabled"
            ? "disabled"
            : poolBControl.status === "duplicate"
              ? "duplicate"
              : "rate_limited",
        outcome: poolBControl.detail,
        error_class:
          poolBControl.status === "disabled"
            ? "maintenance"
            : poolBControl.status === "duplicate"
              ? "idempotency"
              : "rate_limit",
        duration_ms: Date.now() - started,
        prompt_chars: promptChars,
        prompt_sha256: promptHash,
        ...anthropicMeta,
      },
      log,
    );
    await respond({
      request_id,
      ok: false,
      error: poolBControl.status === "disabled" ? "internal" : "rate_limited",
      error_class: poolBControl.status === "disabled" ? "maintenance" : "rate_limit",
      message: poolBControl.detail,
    });
    return;
  }

  const device = await lookupDevice(supabase, v.payload.sub, v.payload.device_id);
  if (!device.ok) {
    await appendPoolBAuditEvent({
      route: "anthropic-messages",
      request_id,
      user_id: v.payload.sub,
      device_id: v.payload.device_id,
      status: "rejected",
      outcome: device.error,
      duration_ms: Date.now() - started,
      model: anthropic_request.model,
      error_class: "auth",
    });
    await writeInferenceAudit(
      supabase,
      {
        pool: "B",
        route: "anthropic-messages",
        request_id,
        attempt_no: 0,
        user_id: v.payload.sub,
        device_id: v.payload.device_id,
        provider: "control-plane",
        fallback_mode: poolBProviderMode(),
        model: anthropic_request.model,
        status: "rejected",
        outcome: device.error,
        error_class: "auth",
        duration_ms: Date.now() - started,
        prompt_chars: promptChars,
        prompt_sha256: promptHash,
        ...anthropicMeta,
      },
      log,
    );
    await respond({
      request_id,
      ok: false,
      error: "no_paired_device",
      error_class: "auth",
      message: device.error,
    });
    return;
  }

  // Subscription gating (same as simple-prompt path).
  let subscriptionId: string | null = null;
  if (process.env.WAVEX_OS_INFERENCE_SKIP_SUB !== "1") {
    const sub = await lookupActiveSubscription(supabase, v.payload.sub);
    if (!sub.ok) {
      await respond({
        request_id,
        ok: false,
        error: "no_active_subscription",
        error_class: "auth",
        message: sub.error,
      });
      log.info(
        {
          request_id,
          user_id: v.payload.sub,
          outcome: "no_active_subscription",
          duration_ms: Date.now() - started,
        },
        "anthropic-messages request rejected",
      );
      await appendPoolBAuditEvent({
        route: "anthropic-messages",
        request_id,
        user_id: v.payload.sub,
        device_id: v.payload.device_id,
        status: "rejected",
        outcome: "no_active_subscription",
        duration_ms: Date.now() - started,
        model: anthropic_request.model,
        error_class: "auth",
      });
      await writeInferenceAudit(
        supabase,
        {
          pool: "B",
          route: "anthropic-messages",
          request_id,
          attempt_no: 0,
          user_id: v.payload.sub,
          device_id: v.payload.device_id,
          provider: "control-plane",
          fallback_mode: poolBProviderMode(),
          model: anthropic_request.model,
          status: "rejected",
          outcome: "no_active_subscription",
          error_class: "auth",
          duration_ms: Date.now() - started,
          prompt_chars: promptChars,
          prompt_sha256: promptHash,
          ...anthropicMeta,
        },
        log,
      );
      return;
    }
    subscriptionId = sub.row.id;
  }

  // Clamp max_tokens defensively.
  const clampedMaxTokens = Math.min(
    Math.max(anthropic_request.max_tokens, 1),
    MAX_OUTPUT_TOKENS_HARD,
  );

  try {
    let anthropicResponse: AnthropicMessagesResponse;

    if (process.env.WAVEX_OS_INFERENCE_MOCK === "1") {
      anthropicResponse = {
        id: `msg_mock_${request_id}`,
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "[MOCK] ok" }],
        model: anthropic_request.model,
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 2 },
      };
    } else {
      if (inferenceBackend() !== "oauth") {
        await respond({
          request_id,
          ok: false,
          error: "internal",
          error_class: "other",
          message: "WAVEX_INFERENCE_BACKEND must be oauth for realtime path",
        });
        return;
      }
      anthropicResponse = await callAnthropicOAuthRaw({
        model: anthropic_request.model,
        max_tokens: clampedMaxTokens,
        messages: anthropic_request.messages,
        system: anthropic_request.system,
        tools: anthropic_request.tools,
        tool_choice: anthropic_request.tool_choice,
        temperature: anthropic_request.temperature,
        top_p: anthropic_request.top_p,
        top_k: anthropic_request.top_k,
        stop_sequences: anthropic_request.stop_sequences,
        metadata: anthropic_request.metadata,
      });
    }

    const durationMs = Date.now() - started;
    const u = anthropicResponse.usage;
    const costUsd = calcCostUsd(anthropic_request.model, {
      input_tokens: u.input_tokens,
      output_tokens: u.output_tokens,
      cache_read_input_tokens: u.cache_read_input_tokens,
      cache_creation_input_tokens: u.cache_creation_input_tokens,
    });
    const costCents = Math.round(costUsd * 100);

    await respond({
      request_id,
      ok: true,
      anthropic_response: anthropicResponse,
    });

    if (subscriptionId) {
      await writeLedger(
        supabase,
        {
          pool: "B",
          subscription_id: subscriptionId,
          request_id,
          model: anthropic_request.model,
          prompt_tokens: u.input_tokens,
          completion_tokens: u.output_tokens,
          cache_read_tokens: u.cache_read_input_tokens ?? 0,
          cache_creation_tokens: u.cache_creation_input_tokens ?? 0,
          cost_cents: costCents,
          status: "ok",
          device_id: device.row.id,
        },
        log,
      );
    }

    await writeInferenceAudit(
      supabase,
      {
        pool: "B",
        route: "anthropic-messages",
        request_id,
        attempt_no: 1,
        user_id: v.payload.sub,
        subscription_id: subscriptionId,
        device_id: device.row.id,
        provider: "anthropic_oauth",
        fallback_mode: poolBProviderMode(),
        provider_response_id: anthropicResponse.id,
        model: anthropicResponse.model,
        status: "accepted",
        outcome: "ok",
        error_class: null,
        duration_ms: durationMs,
        prompt_chars: promptChars,
        prompt_sha256: promptHash,
        prompt_tokens: u.input_tokens,
        completion_tokens: u.output_tokens,
        cache_read_tokens: u.cache_read_input_tokens ?? 0,
        cache_creation_tokens: u.cache_creation_input_tokens ?? 0,
        cost_cents: costCents,
        ...anthropicMeta,
      },
      log,
    );

    await appendPoolBAuditEvent({
      route: "anthropic-messages",
      request_id,
      user_id: v.payload.sub,
      device_id: device.row.id,
      status: "accepted",
      outcome: "ok",
      duration_ms: durationMs,
      model: anthropic_request.model,
      cost_cents: costCents,
    });
    log.info(
      {
        request_id,
        user_id: v.payload.sub,
        outcome: "ok",
        duration_ms: durationMs,
        cost_cents: costCents,
        kind: "anthropic-messages",
      },
      "anthropic-messages request served",
    );
  } catch (e) {
    const err = e as { status?: number; message?: string };
    const status = err.status;
    const error_class =
      status === 429
        ? "rate_limit"
        : status === 401 || status === 403
          ? "auth"
          : typeof status === "number" && status >= 400 && status < 600
            ? "upstream"
            : "other";
    await appendPoolBAuditEvent({
      route: "anthropic-messages",
      request_id,
      user_id: v.payload.sub,
      device_id: device.row.id,
      status: "failed",
      outcome: "upstream_error",
      duration_ms: Date.now() - started,
      model: anthropic_request.model,
      error_class,
      detail: err.message ?? "anthropic_call_failed",
    });
    await writeInferenceAudit(
      supabase,
      {
        pool: "B",
        route: "anthropic-messages",
        request_id,
        attempt_no: 1,
        user_id: v.payload.sub,
        subscription_id: subscriptionId,
        device_id: device.row.id,
        provider: "anthropic_oauth",
        fallback_mode: poolBProviderMode(),
        model: anthropic_request.model,
        status: "failed",
        outcome: "upstream_error",
        error_class,
        duration_ms: Date.now() - started,
        prompt_chars: promptChars,
        prompt_sha256: promptHash,
        metadata: { error_message: err.message ?? "anthropic_call_failed" },
        ...anthropicMeta,
      },
      log,
    );
    await respond({
      request_id,
      ok: false,
      error: "upstream_error",
      error_class,
      message: err.message ?? "anthropic_call_failed",
    });
    log.error(
      {
        err: err.message,
        request_id,
        user_id: v.payload.sub,
        duration_ms: Date.now() - started,
        kind: "anthropic-messages",
      },
      "anthropic-messages request failed",
    );
  }
}

interface OnboardingRequestPayload {
  request_id?: unknown;
  prompt?: unknown;
  max_output_tokens?: unknown;
  purpose?: unknown;
  email?: unknown;
  install_id?: unknown;
  company_id?: unknown;
  model?: unknown;
}

/** Pool A — anonymous onboarding inference over Realtime.
 *
 *  The onboarding wizard runs before sign-in and before device pairing, so
 *  there is no device_jwt and no per-user channel. Customers publish on the
 *  shared ONBOARDING_REQUEST_TOPIC; we serve the call with the operator's
 *  rotating Claude Max OAuth (Pool A) and reply on
 *  `wavex-onboarding-response:<request_id>`.
 *
 *  Guards: purpose must be `onboarding:*`; a global hourly request cap; an
 *  optional per-company cap; the Pool A daily spend kill-switch; an output
 *  token clamp. Everything degrades to a structured { ok:false } so the
 *  wizard never blocks. */
async function handleOnboardingRequest(args: {
  supabase: SupabaseClient;
  payload: OnboardingRequestPayload;
  log: Logger;
}): Promise<void> {
  const { supabase, payload, log } = args;
  const started = Date.now();

  const request_id = typeof payload.request_id === "string" ? payload.request_id : null;
  const prompt = typeof payload.prompt === "string" ? payload.prompt : null;
  const purpose = typeof payload.purpose === "string" ? payload.purpose : "";
  const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : null;
  const installId =
    typeof payload.install_id === "string"
      ? payload.install_id
      : typeof payload.company_id === "string"
        ? payload.company_id
        : null;
  const model = typeof payload.model === "string" ? payload.model : ONBOARDING_MODEL;
  const maxOut = Math.min(
    typeof payload.max_output_tokens === "number" && payload.max_output_tokens > 0
      ? payload.max_output_tokens
      : 1024,
    ONBOARDING_MAX_OUTPUT_TOKENS,
  );

  if (!request_id || !prompt) {
    log.warn({ hasReqId: !!request_id }, "ignoring malformed onboarding request");
    return;
  }

  const respond = async (body: Record<string, unknown>): Promise<void> => {
    try {
      const ch = supabase.channel(`${ONBOARDING_RESPONSE_TOPIC_PREFIX}${request_id}`);
      await new Promise<void>((resolve) => {
        ch.subscribe((status) => {
          if (status === "SUBSCRIBED" || status === "CHANNEL_ERROR" || status === "TIMED_OUT") resolve();
        });
        setTimeout(resolve, 5_000);
      });
      await ch.send({ type: "broadcast", event: BROADCAST_EVENT, payload: body });
      await supabase.removeChannel(ch);
    } catch (e) {
      log.error({ err: (e as Error).message, request_id }, "onboarding response broadcast failed");
    }
  };

  // Purpose gate — this lane exists only for the onboarding wizard.
  if (!purpose.startsWith("onboarding:")) {
    await respond({ request_id, ok: false, error: "purpose_not_allowed" });
    return;
  }

  // Global hourly request cap (Realtime gives us no client IP; this plus the
  // daily $ cap below are the abuse backstops).
  const globalCount = await incrementCounter("onb:rate:global", ONBOARDING_RATE_WINDOW_SEC);
  if (globalCount > ONBOARDING_GLOBAL_RATE_MAX) {
    await respond({ request_id, ok: false, error: "rate_limited", message: "onboarding inference is busy; try again shortly" });
    return;
  }
  // Per-install caps (soft UX guard; the global + daily $ caps are the hard
  // backstops since Realtime can't see the caller IP and install_id/email are
  // client-provided).
  if (installId) {
    const hr = await incrementCounter(`onb:install:${installId}:hr`, ONBOARDING_RATE_WINDOW_SEC);
    const life = await incrementCounter(`onb:install:${installId}:life`, ONBOARDING_LIFETIME_WINDOW_SEC);
    if (hr > ONBOARDING_PER_INSTALL_HR_MAX || life > ONBOARDING_PER_INSTALL_LIFETIME_MAX) {
      await respond({ request_id, ok: false, error: "rate_limited", message: "onboarding inference limit reached for this session" });
      return;
    }
  }
  // Distinct installs per email — blunts a single email spinning up endless
  // fresh installs to dodge the per-install caps.
  if (email) {
    const { size } = await setAdd(`onb:email-installs:${email}`, installId ?? "unknown", ONBOARDING_LIFETIME_WINDOW_SEC);
    if (size > ONBOARDING_INSTALLS_PER_EMAIL_MAX) {
      await respond({ request_id, ok: false, error: "rate_limited", message: "too many onboarding sessions for this email" });
      return;
    }
  }

  // Pool A daily spend kill-switch. Fail-open on lookup error — a metrics
  // hiccup shouldn't block onboarding.
  try {
    const { data: burn } = await supabase.rpc("wavex_os_pool_a_burn_today");
    if (typeof burn === "number" && burn >= POOL_A_DAILY_CAP_CENTS) {
      await respond({ request_id, ok: false, error: "cap_hit", message: "daily onboarding inference cap reached" });
      return;
    }
  } catch {
    /* fail open */
  }

  try {
    // URL-prefetch: when the prompt contains a URL (e.g. the operator pasted
    // their site at Pillar 1), fetch the page content and inject it as
    // grounding so the model infers from the real site, not just the domain
    // string. Idempotent + no-ops when there's no URL. Best-effort: a prefetch
    // failure must not block inference, so fall back to the raw prompt.
    let groundedPrompt = prompt;
    try {
      groundedPrompt = (await prefetchUrlsInPrompt(prompt)).prompt;
    } catch (pfErr) {
      log.warn({ request_id, err: (pfErr as Error).message }, "url prefetch failed; using raw prompt");
    }
    const resp = await callAnthropicOAuthRaw({
      model,
      max_tokens: maxOut,
      messages: [{ role: "user", content: groundedPrompt }],
    });
    const content = (resp.content ?? [])
      .map((c) => ((c as { type?: string; text?: string }).type === "text" ? (c as { text?: string }).text ?? "" : ""))
      .join("");
    const usage = resp.usage ?? { input_tokens: 0, output_tokens: 0 };
    const costCents = Math.round(calcCostUsd(resp.model ?? model, usage) * 100);

    await respond({
      request_id,
      ok: true,
      content,
      model: resp.model ?? model,
      usage: {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        duration_ms: Date.now() - started,
      },
    });

    // Fire-and-forget Pool A ledger row (anonymous onboarding spend). No
    // subscription/device/IP; install_id carries the company slug when present.
    void supabase
      .rpc("wavex_os_record_usage", {
        p_pool: "A",
        p_subscription_id: null,
        p_request_id: request_id,
        p_model: resp.model ?? model,
        p_prompt_tokens: usage.input_tokens,
        p_completion_tokens: usage.output_tokens,
        p_cache_read_tokens: usage.cache_read_input_tokens ?? 0,
        p_cache_creation_tokens: usage.cache_creation_input_tokens ?? 0,
        p_cost_cents: costCents,
        p_status: "ok",
        p_device_id: null,
        p_error_class: null,
        p_install_id: installId ?? "onboarding-anon",
        p_email: email,
        p_ip_24: null,
        p_deliverable_id: null,
        p_agent_id: null,
      })
      .then((r: { error: unknown }) => {
        if (r.error) log.error({ err: r.error, request_id }, "onboarding usage_ledger insert failed");
      });

    log.info(
      { request_id, purpose, model: resp.model ?? model, out_tokens: usage.output_tokens, duration_ms: Date.now() - started },
      "onboarding inference ok",
    );
  } catch (e) {
    const err = e as { status?: number; message?: string };
    log.error({ request_id, status: err.status, err: err.message }, "onboarding inference failed");
    await respond({ request_id, ok: false, error: "upstream_error", message: err.message ?? "inference failed" });
  }
}

interface ConnectorRequestPayload {
  request_id?: unknown;
  method?: unknown;
  path?: unknown;
  body?: unknown;
}

/** Connector lane — allowlisted HTTP proxy to the local wavex-os-server.
 *
 *  Lets the published SPA (wavexcard.com), which can't reach the Mac
 *  directly, drive the phase-2 connector flow (Composio OAuth + manifest)
 *  over Supabase Realtime. We relay `{method, path, body}` to
 *  CONNECTOR_SERVER_URL only if `path` matches the connector allowlist, then
 *  reply with the server's JSON on `wavex-connector-response:<request_id>`.
 *
 *  Degrades to { ok:false } on any failure; the vendored UI surfaces the
 *  ApiError. Path allowlist + global rate cap are the guards (no IP over
 *  Realtime). */
async function handleConnectorRequest(args: {
  supabase: SupabaseClient;
  payload: ConnectorRequestPayload;
  log: Logger;
}): Promise<void> {
  const { supabase, payload, log } = args;
  const request_id = typeof payload.request_id === "string" ? payload.request_id : null;
  const method = payload.method === "POST" ? "POST" : "GET";
  const path = typeof payload.path === "string" ? payload.path : null;

  if (!request_id || !path) {
    log.warn({ hasReqId: !!request_id }, "ignoring malformed connector request");
    return;
  }

  const respond = async (body: Record<string, unknown>): Promise<void> => {
    try {
      const ch = supabase.channel(`${CONNECTOR_RESPONSE_TOPIC_PREFIX}${request_id}`);
      await new Promise<void>((resolve) => {
        ch.subscribe((status) => {
          if (status === "SUBSCRIBED" || status === "CHANNEL_ERROR" || status === "TIMED_OUT") resolve();
        });
        setTimeout(resolve, 5_000);
      });
      await ch.send({ type: "broadcast", event: BROADCAST_EVENT, payload: body });
      await supabase.removeChannel(ch);
    } catch (e) {
      log.error({ err: (e as Error).message, request_id }, "connector response broadcast failed");
    }
  };

  // Allowlist: only connector routes, no path traversal.
  const pathname = path.split("?")[0] ?? "";
  const allowed = !path.includes("..") && CONNECTOR_ALLOWED_PREFIXES.some((p) => pathname.startsWith(p));
  if (!allowed) {
    await respond({ request_id, ok: false, error: "path_not_allowed" });
    return;
  }

  const globalCount = await incrementCounter("conn:rate:global", CONNECTOR_RATE_WINDOW_SEC);
  if (globalCount > CONNECTOR_GLOBAL_RATE_MAX) {
    await respond({ request_id, ok: false, error: "rate_limited" });
    return;
  }

  try {
    const init: RequestInit = { method, headers: { "Content-Type": "application/json" } };
    if (method === "POST") init.body = JSON.stringify(payload.body ?? {});
    const resp = await fetch(`${CONNECTOR_SERVER_URL}${path}`, init);
    const text = await resp.text();
    let data: unknown;
    try { data = JSON.parse(text); } catch { data = text; }
    await respond({ request_id, ok: resp.ok, status: resp.status, data });
    log.info({ request_id, method, path: pathname, status: resp.status }, "connector proxy ok");
  } catch (e) {
    const err = e as { message?: string };
    log.error({ request_id, path: pathname, err: err.message }, "connector proxy failed");
    await respond({ request_id, ok: false, error: "upstream_error", message: err.message ?? "proxy failed" });
  }
}

export interface RealtimeWorkerDeps {
  log: Logger;
  supabaseUrl?: string;
  supabaseServiceKey?: string;
}

export interface RealtimeWorkerHandle {
  stop: () => Promise<void>;
  subscribedTopics: () => string[];
}

/** Start the Realtime worker. Returns a handle for graceful shutdown.
 *  If required env is missing, logs a warning and returns a no-op handle —
 *  it MUST NOT throw, because the HTTP server should still come up. */
export async function startRealtimeWorker(deps: RealtimeWorkerDeps): Promise<RealtimeWorkerHandle> {
  const { log } = deps;
  if (process.env.WAVEX_OS_REALTIME_DISABLED === "1") {
    log.info("realtime worker disabled via WAVEX_OS_REALTIME_DISABLED=1");
    return { stop: async () => {}, subscribedTopics: () => [] };
  }
  const url = deps.supabaseUrl ?? process.env.SUPABASE_URL;
  const key = deps.supabaseServiceKey ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    log.warn("realtime worker: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing; skipping");
    return { stop: async () => {}, subscribedTopics: () => [] };
  }

  const supabase = createClient(url, key, { auth: { persistSession: false } });
  const channelsByUserId = new Map<string, RealtimeChannel>();
  const anthropicChannelsByUserId = new Map<string, RealtimeChannel>();

  // Shared anonymous lanes (onboarding Pool A + connector proxy). No user_id,
  // no device_jwt — the wizard runs before pairing/sign-in.
  //
  // CRITICAL RESILIENCE: Supabase Realtime channels drop on network blips /
  // token refresh (CHANNEL_ERROR / TIMED_OUT / CLOSED). Without re-subscribing
  // the lane goes SILENTLY DEAD — requests time out and onboarding shows blank
  // inference (no preselection) until the process restarts. So we auto-rejoin
  // on error with a short backoff. (Field incident 2026-06-02: the onboarding
  // + connector channels errored and stayed dead for ~hour → blank Pillar 1.)
  const sharedLanes: Array<{ topic: string; ch: RealtimeChannel | null }> = [];
  const subscribeShared = (
    topic: string,
    label: string,
    onPayload: (payload: Record<string, unknown>) => void,
  ): void => {
    const lane: { topic: string; ch: RealtimeChannel | null } = { topic, ch: null };
    sharedLanes.push(lane);
    const join = (): void => {
      const ch = supabase
        .channel(topic)
        .on("broadcast", { event: BROADCAST_EVENT }, (msg: { payload?: Record<string, unknown> }) => {
          onPayload(msg.payload ?? {});
        })
        .subscribe((status) => {
          if (status === "SUBSCRIBED") {
            log.info({ topic }, `${label} subscribed`);
          } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
            log.warn({ topic, status }, `${label} channel ${status} — rejoining in 3s`);
            const stale = lane.ch;
            setTimeout(() => {
              if (stale) void supabase.removeChannel(stale).catch(() => {});
              join();
            }, 3000);
          }
        });
      lane.ch = ch;
    };
    join();
  };

  subscribeShared(ONBOARDING_REQUEST_TOPIC, "onboarding lane", (payload) => {
    void handleOnboardingRequest({ supabase, payload: payload as OnboardingRequestPayload, log });
  });
  subscribeShared(CONNECTOR_REQUEST_TOPIC, "connector lane", (payload) => {
    void handleConnectorRequest({ supabase, payload: payload as ConnectorRequestPayload, log });
  });

  const subscribeUser = async (userId: string): Promise<void> => {
    // Same auto-rejoin resilience as the shared lanes: a dropped per-user
    // channel (CHANNEL_ERROR / TIMED_OUT / CLOSED) that never re-subscribes
    // leaves a paired customer's Pool B inference silently dead until restart.
    if (!channelsByUserId.has(userId)) {
      const topic = `${REQUEST_TOPIC_PREFIX}${userId}`;
      const joinReq = (): void => {
        const ch = supabase
          .channel(topic)
          .on("broadcast", { event: BROADCAST_EVENT }, (msg: { payload?: RequestPayload }) => {
            void handleRequest({ supabase, topicUserId: userId, payload: msg.payload ?? {}, log });
          })
          .subscribe((status) => {
            if (status === "SUBSCRIBED") {
              log.info({ topic, user_id: userId }, "realtime worker subscribed");
            } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
              log.warn({ topic, status }, "realtime channel status — rejoining in 3s");
              const stale = channelsByUserId.get(userId);
              setTimeout(() => {
                if (stale) void supabase.removeChannel(stale).catch(() => {});
                joinReq();
              }, 3000);
            }
          });
        channelsByUserId.set(userId, ch);
      };
      joinReq();
    }

    // Second channel: anthropic-messages variant for the Claude Code proxy.
    if (!anthropicChannelsByUserId.has(userId)) {
      const topic = `${ANTHROPIC_REQUEST_TOPIC_PREFIX}${userId}`;
      const joinAnthropic = (): void => {
        const ch = supabase
          .channel(topic)
          .on("broadcast", { event: ANTHROPIC_BROADCAST_EVENT }, (msg: { payload?: AnthropicRequestPayload }) => {
            void handleAnthropicRequest({ supabase, topicUserId: userId, payload: msg.payload ?? {}, log });
          })
          .subscribe((status) => {
            if (status === "SUBSCRIBED") {
              log.info({ topic, user_id: userId }, "anthropic-messages worker subscribed");
            } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
              log.warn({ topic, status }, "anthropic-messages channel status — rejoining in 3s");
              const stale = anthropicChannelsByUserId.get(userId);
              setTimeout(() => {
                if (stale) void supabase.removeChannel(stale).catch(() => {});
                joinAnthropic();
              }, 3000);
            }
          });
        anthropicChannelsByUserId.set(userId, ch);
      };
      joinAnthropic();
    }
  };

  const refresh = async (): Promise<void> => {
    try {
      const ids = await discoverUserIds(supabase, log);
      // Subscribe to any newly-discovered user_ids. We intentionally do NOT
      // unsubscribe disappeared user_ids — a customer mid-flight shouldn't
      // be dropped because of a transient discovery glitch.
      for (const id of ids) {
        await subscribeUser(id);
      }
      if (ids.length === 0 && channelsByUserId.size === 0) {
        log.info("realtime worker: no user_ids to subscribe to yet (set WAVEX_OS_REALTIME_USER_IDS to bind explicitly)");
      }
    } catch (e) {
      log.error({ err: (e as Error).message }, "realtime worker refresh failed");
    }
  };

  await refresh();
  const refreshTimer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
  refreshTimer.unref?.();

  log.info({ subscribed_count: channelsByUserId.size }, "realtime worker connected");
  if (!isPoolBEnabled()) {
    log.info("realtime worker is in observe-and-reject mode until WAVEX_OS_STREAMING_INFERENCE_ENABLED=1");
  }

  return {
    stop: async () => {
      clearInterval(refreshTimer);
      for (const ch of channelsByUserId.values()) {
        try {
          await supabase.removeChannel(ch);
        } catch {
          /* ignore */
        }
      }
      for (const ch of anthropicChannelsByUserId.values()) {
        try {
          await supabase.removeChannel(ch);
        } catch {
          /* ignore */
        }
      }
      for (const lane of sharedLanes) {
        if (lane.ch) {
          try {
            await supabase.removeChannel(lane.ch);
          } catch {
            /* ignore */
          }
        }
      }
      channelsByUserId.clear();
      anthropicChannelsByUserId.clear();
    },
    subscribedTopics: () => [
      ...Array.from(channelsByUserId.keys()).map((u) => `${REQUEST_TOPIC_PREFIX}${u}`),
      ...Array.from(anthropicChannelsByUserId.keys()).map((u) => `${ANTHROPIC_REQUEST_TOPIC_PREFIX}${u}`),
      ONBOARDING_REQUEST_TOPIC,
      CONNECTOR_REQUEST_TOPIC,
    ],
  };
}
