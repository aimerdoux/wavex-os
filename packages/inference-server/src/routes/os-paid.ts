/**
 * Device-JWT-gated paid endpoints.
 *
 * Replaces the never-deployed `os-inference` / `os-spend-intent` Supabase
 * Edge Functions. The operator's cloud-client (running on the customer's
 * Mac) holds a device JWT minted by the wavexcard.com console and signed
 * with WAVEX_DEVICE_JWT_SECRET. We verify that signature here, then
 * check the subscription is ACTIVE via the same Supabase RPC the Pool C
 * optimizer route uses, then forward to Anthropic.
 *
 * Endpoints:
 *   POST /v1/os/inference
 *     headers: Authorization: Bearer <device JWT>
 *     body:    { prompt, model?, max_output_tokens?, purpose? }
 *     returns: { ok: true, content, model, request_id, usage }
 *              | { ok: false, error, message }
 *
 *   POST /v1/os/spend-intent
 *     headers: Authorization: Bearer <device JWT>
 *              Idempotency-Key: <uuid>
 *     body:    { kind, amount_cents, recipient, reason, idempotency_key, ... }
 *     returns: { ok: false, error: "internal", message: "not yet wired" }
 *              Stub until the bridge/Stripe execution path lands; matches
 *              the cloud-client's discriminated-union contract so the
 *              caller-side error handling already in place still works.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { verifyDeviceJwt } from "@wavex-os/auth-shim";
import { runPoolBPromptCoverage } from "../lib/pool-b-prompt-coverage.js";
import { incrementCounter, setIfAbsent } from "../lib/rate-limit.js";
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
  type PoolBRemoteAuditEvent,
} from "../lib/inference-audit.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SVC = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ACTIVE_STATUSES = new Set(["trialing", "active", "past_due"]);
const DEFAULT_MODEL = process.env.WAVEX_OS_INFERENCE_MODEL ?? "claude-sonnet-4-6";
const MAX_OUTPUT_TOKENS_HARD = 8000;

interface InferenceBody {
  request_id?: string;
  prompt?: string;
  model?: string;
  max_output_tokens?: number;
  purpose?: string;
  session_id?: string;
  conversation_id?: string;
  trace_id?: string;
  client_name?: string;
  client_version?: string;
  source?: string;
  context_input_tokens?: number;
  message_count?: number;
}

interface SpendIntentBody {
  kind?: string;
  amount_cents?: number;
  recipient?: string;
  reason?: string;
  source_issue_id?: string;
  idempotency_key?: string;
}

interface SubscriptionRow {
  id: string;
  status: string;
  tier: string;
}

interface DeviceRow {
  id: string;
  user_id: string;
  status: string;
  name?: string | null;
  last_seen_at?: string | null;
}

interface UsageRow {
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
}

interface RemoteAuditRow extends PoolBRemoteAuditEvent {}

async function callServiceRpc<T>(name: string, body: Record<string, unknown>): Promise<{ ok: true; data: T } | { ok: false; status: number; error: string }> {
  if (!SUPABASE_URL || !SUPABASE_SVC) {
    return { ok: false, status: 503, error: "supabase_not_configured" };
  }
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_SVC,
      Authorization: `Bearer ${SUPABASE_SVC}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    return { ok: false, status: resp.status, error: `${name}_failed` };
  }
  return { ok: true, data: (await resp.json()) as T };
}

/** Subscription lookup by device.user_id — the JWT carries `sub` (user_id),
 *  so we resolve via the wavex_os_subscription_lookup_by_user RPC which
 *  returns the most recent active/trialing/past_due row for that user_id. */
async function lookupActiveSubscription(
  subjectId: string,
): Promise<{ ok: true; row: SubscriptionRow } | { ok: false; status: number; error: string }> {
  const resp = await callServiceRpc<SubscriptionRow[]>("wavex_os_subscription_lookup_by_user", {
    p_user_id: subjectId,
  });
  if (!resp.ok) return { ok: false, status: resp.status, error: "subscription_lookup_failed" };
  const rows = resp.data;
  const row = rows[0];
  if (!row) return { ok: false, status: 404, error: "subscription_not_found" };
  if (!ACTIVE_STATUSES.has(row.status)) {
    return { ok: false, status: 402, error: "subscription_expired" };
  }
  return { ok: true, row };
}

async function lookupDevice(subjectId: string, deviceId: string): Promise<{ ok: true; row: DeviceRow } | { ok: false; status: number; error: string }> {
  const resp = await callServiceRpc<DeviceRow[]>("wavex_os_device_lookup", {
    p_user_id: subjectId,
    p_device_id: deviceId,
  });
  if (!resp.ok) return { ok: false, status: resp.status, error: "device_lookup_failed" };
  const row = resp.data[0];
  if (!row) return { ok: false, status: 404, error: "device_not_found" };
  if (row.status === "revoked") return { ok: false, status: 403, error: "device_revoked" };
  return { ok: true, row };
}

async function writeLedger(row: UsageRow): Promise<void> {
  const resp = await callServiceRpc<string>("wavex_os_record_usage", {
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
  if (!resp.ok) {
    throw new Error(resp.error);
  }
}

async function writeInferenceAudit(row: RemoteAuditRow): Promise<void> {
  const resp = await callServiceRpc<string>(
    "wavex_os_record_inference_audit",
    buildInferenceAuditRpcBody(row),
  );
  if (!resp.ok) {
    throw new Error(resp.error);
  }
}

function verifyBearer(
  req: FastifyRequest,
  reply: FastifyReply,
): { sub: string; device_id: string } | null {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) {
    reply.code(401).send({ ok: false, error: "no_paired_device", message: "missing bearer" });
    return null;
  }
  const v = verifyDeviceJwt(auth.slice(7));
  if (!v.ok || !v.payload) {
    reply
      .code(401)
      .send({ ok: false, error: "no_paired_device", message: `device JWT invalid: ${v.reason ?? "unknown"}` });
    return null;
  }
  return { sub: v.payload.sub, device_id: v.payload.device_id };
}

export async function registerOsPaid(app: FastifyInstance): Promise<void> {
  // ── POST /v1/os/inference ────────────────────────────────────────────
  app.post<{ Body: InferenceBody }>(
    "/v1/os/inference",
    async (req, reply) => {
      const started = Date.now();
      const meta = parseInferenceRequestMeta(req.body as Record<string, unknown> | undefined, {
        source: "http",
        client_name: "os-paid-http",
      });
      const claims = verifyBearer(req, reply);
      if (!claims) return;

      const { request_id, prompt, model, max_output_tokens } = req.body ?? {};
      if (!prompt || typeof prompt !== "string") {
        return reply.code(400).send({ ok: false, error: "internal", message: "missing_prompt" });
      }
      if (!request_id || typeof request_id !== "string") {
        return reply.code(400).send({ ok: false, error: "internal", message: "missing_request_id" });
      }
      const requestId = request_id;
      const promptText = prompt;

      const duplicateKey = `pool-b:http:idempotency:${claims.sub}:${requestId}`;
      const firstSeen = await setIfAbsent(duplicateKey, poolBIdempotencyTtlSec());
      if (!firstSeen) {
        await appendPoolBAuditEvent({
          route: "http",
          request_id: requestId,
          user_id: claims.sub,
          device_id: claims.device_id,
          status: "duplicate",
          outcome: "duplicate_request",
          duration_ms: Date.now() - started,
          model: model ?? DEFAULT_MODEL,
          error_class: "idempotency",
          detail: "request_id already processed recently",
        });
        try {
          await writeInferenceAudit({
            pool: "B",
            route: "http",
            request_id: requestId,
            attempt_no: 0,
            user_id: claims.sub,
            device_id: claims.device_id,
            provider: "control-plane",
            fallback_mode: poolBProviderMode(),
            model: model ?? DEFAULT_MODEL,
            status: "duplicate",
            outcome: "duplicate_request",
            error_class: "idempotency",
            duration_ms: Date.now() - started,
            prompt_chars: promptText.length,
            prompt_sha256: sha256Hex(promptText),
            metadata: {
              detail: "request_id already processed recently",
            },
            ...meta,
          });
        } catch (err) {
          app.log.warn({ err, request_id: requestId }, "pool-b http inference audit insert failed");
        }
        return reply.code(409).send({ ok: false, error: "rate_limited", message: "duplicate_request" });
      }

      if (!isPoolBEnabled()) {
        await appendPoolBAuditEvent({
          route: "http",
          request_id: requestId,
          user_id: claims.sub,
          device_id: claims.device_id,
          status: "disabled",
          outcome: "streaming_inference_disabled",
          duration_ms: Date.now() - started,
          model: model ?? DEFAULT_MODEL,
          error_class: "maintenance",
        });
        try {
          await writeInferenceAudit({
            pool: "B",
            route: "http",
            request_id: requestId,
            attempt_no: 0,
            user_id: claims.sub,
            device_id: claims.device_id,
            provider: "control-plane",
            fallback_mode: poolBProviderMode(),
            model: model ?? DEFAULT_MODEL,
            status: "disabled",
            outcome: "streaming_inference_disabled",
            error_class: "maintenance",
            duration_ms: Date.now() - started,
            prompt_chars: promptText.length,
            prompt_sha256: sha256Hex(promptText),
            ...meta,
          });
        } catch (err) {
          app.log.warn({ err, request_id: requestId }, "pool-b http inference audit insert failed");
        }
        return reply.code(503).send({
          ok: false,
          error: "internal",
          message: poolBDisabledMessage(),
        });
      }

      const device = await lookupDevice(claims.sub, claims.device_id);
      if (!device.ok) {
        await appendPoolBAuditEvent({
          route: "http",
          request_id: requestId,
          user_id: claims.sub,
          device_id: claims.device_id,
          status: "rejected",
          outcome: device.error,
          duration_ms: Date.now() - started,
          model: model ?? DEFAULT_MODEL,
          error_class: "auth",
        });
        try {
          await writeInferenceAudit({
            pool: "B",
            route: "http",
            request_id: requestId,
            attempt_no: 0,
            user_id: claims.sub,
            device_id: claims.device_id,
            provider: "control-plane",
            fallback_mode: poolBProviderMode(),
            model: model ?? DEFAULT_MODEL,
            status: "rejected",
            outcome: device.error,
            error_class: "auth",
            duration_ms: Date.now() - started,
            prompt_chars: promptText.length,
            prompt_sha256: sha256Hex(promptText),
            ...meta,
          });
        } catch (err) {
          app.log.warn({ err, request_id: requestId }, "pool-b http inference audit insert failed");
        }
        return reply.code(device.status).send({ ok: false, error: "no_paired_device", message: device.error });
      }

      const bucket = Math.floor(Date.now() / (poolBRateLimitWindowSec() * 1000));
      const rateKey = `pool-b:http:rate:${claims.sub}:${claims.device_id}:${bucket}`;
      const count = await incrementCounter(rateKey, poolBRateLimitWindowSec() + 60);
      if (count > poolBRateLimitMaxRequests()) {
        await appendPoolBAuditEvent({
          route: "http",
          request_id: requestId,
          user_id: claims.sub,
          device_id: claims.device_id,
          status: "rate_limited",
          outcome: "rate_limited",
          duration_ms: Date.now() - started,
          model: model ?? DEFAULT_MODEL,
          error_class: "rate_limit",
          detail: `count=${count}`,
        });
        try {
          await writeInferenceAudit({
            pool: "B",
            route: "http",
            request_id: requestId,
            attempt_no: 0,
            user_id: claims.sub,
            device_id: claims.device_id,
            provider: "control-plane",
            fallback_mode: poolBProviderMode(),
            model: model ?? DEFAULT_MODEL,
            status: "rate_limited",
            outcome: "rate_limited",
            error_class: "rate_limit",
            duration_ms: Date.now() - started,
            prompt_chars: promptText.length,
            prompt_sha256: sha256Hex(promptText),
            metadata: { count },
            ...meta,
          });
        } catch (err) {
          app.log.warn({ err, request_id: requestId }, "pool-b http inference audit insert failed");
        }
        return reply.code(429).send({ ok: false, error: "rate_limited", message: "rate_limited" });
      }

      // Subscription gating — skipped when WAVEX_OS_INFERENCE_SKIP_SUB=1
      // (local-loopback / smoke). In production this is the real gate.
      let subscriptionId: string | null = null;
      if (process.env.WAVEX_OS_INFERENCE_SKIP_SUB !== "1") {
        const sub = await lookupActiveSubscription(claims.sub);
        if (!sub.ok) {
          await appendPoolBAuditEvent({
            route: "http",
            request_id: requestId,
            user_id: claims.sub,
            device_id: claims.device_id,
            status: "rejected",
            outcome: sub.error,
            duration_ms: Date.now() - started,
            model: model ?? DEFAULT_MODEL,
            error_class: "auth",
          });
          const code =
            sub.error === "subscription_expired" ? 402 :
            sub.error === "subscription_not_found" ? 404 : 503;
          try {
              await writeInferenceAudit({
                pool: "B",
                route: "http",
                request_id: requestId,
                attempt_no: 0,
                user_id: claims.sub,
                device_id: claims.device_id,
              provider: "control-plane",
              fallback_mode: poolBProviderMode(),
              model: model ?? DEFAULT_MODEL,
              status: "rejected",
                outcome: sub.error,
                error_class: "auth",
                duration_ms: Date.now() - started,
                prompt_chars: promptText.length,
                prompt_sha256: sha256Hex(promptText),
                ...meta,
              });
            } catch (err) {
            app.log.warn({ err, request_id: requestId }, "pool-b http inference audit insert failed");
          }
          return reply.code(code).send({
            ok: false,
            error: sub.error === "subscription_expired" ? "subscription_expired" : "internal",
            message: sub.error,
          });
        }
        subscriptionId = sub.row.id;
      }

      const chosenModel = model ?? DEFAULT_MODEL;
      const maxOut = Math.min(max_output_tokens ?? 4000, MAX_OUTPUT_TOKENS_HARD);
      const promptHash = sha256Hex(promptText);
      const result = await runPoolBPromptCoverage({
        prompt: promptText,
        requestedModel: chosenModel,
        maxTokens: maxOut,
        metadata: {
          wavex_request_id: requestId,
          wavex_route: "http",
          wavex_session_id: meta.session_id ?? "",
        },
      });

      for (const attempt of result.attempts) {
        try {
          await writeInferenceAudit({
            pool: "B",
            route: "http",
            request_id: requestId,
            attempt_no: attempt.attempt_no,
            user_id: claims.sub,
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
            prompt_chars: promptText.length,
            prompt_sha256: promptHash,
            prompt_tokens: attempt.usage?.input_tokens ?? null,
            completion_tokens: attempt.usage?.output_tokens ?? null,
            cache_read_tokens: attempt.usage?.cache_read_input_tokens ?? 0,
            cache_creation_tokens: attempt.usage?.cache_creation_input_tokens ?? 0,
            cost_cents: attempt.cost_cents ?? null,
            metadata: attempt.ok ? undefined : { error_message: attempt.error?.message ?? "provider_call_failed" },
            ...meta,
          });
        } catch (err) {
          app.log.warn({ err, request_id: requestId, attempt_no: attempt.attempt_no }, "pool-b http inference audit insert failed");
        }
      }

      if (!result.ok) {
        const err = result.last_error;
        await appendPoolBAuditEvent({
          route: "http",
          request_id: requestId,
          user_id: claims.sub,
          device_id: claims.device_id,
          status: "failed",
          outcome: "upstream_error",
          duration_ms: Date.now() - started,
          model: chosenModel,
          error_class: typeof err.status === "number" ? `http_${err.status}` : err.code ?? "upstream",
          detail: err.message ?? "provider_call_failed",
        });
        return reply.code(err.status ?? 502).send({
          ok: false,
          error: "upstream_error",
          message: err.message ?? "provider_call_failed",
        });
      }

      const success = result.success;
      if (subscriptionId && success.provider === "anthropic_oauth" && success.cost_cents !== null) {
        try {
          await writeLedger({
            pool: "B",
            subscription_id: subscriptionId,
            request_id: requestId,
            model: success.model,
            prompt_tokens: success.usage.input_tokens,
            completion_tokens: success.usage.output_tokens,
            cache_read_tokens: success.usage.cache_read_input_tokens,
            cache_creation_tokens: success.usage.cache_creation_input_tokens,
            cost_cents: success.cost_cents,
            status: "ok",
            device_id: device.row.id,
          });
        } catch (err) {
          app.log.warn({ err, request_id: requestId }, "pool-b http ledger insert failed");
        }
      }

      await appendPoolBAuditEvent({
        route: "http",
        request_id: requestId,
        user_id: claims.sub,
        device_id: claims.device_id,
        status: "accepted",
        outcome: success.fallback_used ? "ok_via_fallback" : "ok",
        duration_ms: Date.now() - started,
        model: success.model,
        cost_cents: success.cost_cents ?? undefined,
      });
      return reply.send({
        ok: true,
        content: success.content,
        model: success.model,
        request_id: requestId,
        provider: success.provider,
        provider_response_id: success.provider_response_id,
        fallback_used: success.fallback_used,
        usage: {
          input_tokens: success.usage.input_tokens,
          output_tokens: success.usage.output_tokens,
          cache_read_input_tokens: success.usage.cache_read_input_tokens,
          cache_creation_input_tokens: success.usage.cache_creation_input_tokens,
        },
      });
    },
  );

  // ── POST /v1/os/spend-intent ─────────────────────────────────────────
  // Stub. The cloud-client expects the discriminated-union contract; we
  // honor it with a clean error so callers don't need to special-case
  // "endpoint missing" vs "endpoint says no". Real bridge/Stripe execution
  // path lands in a later phase.
  app.post<{ Body: SpendIntentBody }>(
    "/v1/os/spend-intent",
    async (req, reply) => {
      const claims = verifyBearer(req, reply);
      if (!claims) return;
      const idempotencyKey = req.headers["idempotency-key"] ?? req.body?.idempotency_key;
      if (!idempotencyKey) {
        return reply.code(400).send({ ok: false, error: "internal", message: "missing_idempotency_key" });
      }
      return reply.code(503).send({
        ok: false,
        error: "internal",
        message: "spend-intent execution path not yet wired on hub",
      });
    },
  );
}
