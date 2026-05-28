import { createHash } from "node:crypto";
import { hostname } from "node:os";

export type PoolBRoute = "http" | "realtime" | "anthropic-messages";
export type PoolBRemoteStatus =
  | "accepted"
  | "rejected"
  | "failed"
  | "disabled"
  | "rate_limited"
  | "duplicate";

export interface InferenceRequestMeta {
  purpose: string | null;
  session_id: string | null;
  conversation_id: string | null;
  trace_id: string | null;
  client_name: string | null;
  client_version: string | null;
  source: string | null;
  context_input_tokens: number | null;
  message_count: number | null;
}

export interface PoolBRemoteAuditEvent extends InferenceRequestMeta {
  pool: "B";
  route: PoolBRoute;
  request_id: string;
  attempt_no?: number | null;
  user_id?: string | null;
  subscription_id?: string | null;
  device_id?: string | null;
  provider?: string | null;
  fallback_mode?: string | null;
  fallback_used?: boolean | null;
  provider_response_id?: string | null;
  model?: string | null;
  status: PoolBRemoteStatus;
  outcome: string;
  error_class?: string | null;
  duration_ms?: number | null;
  prompt_chars?: number | null;
  prompt_sha256?: string | null;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  cache_read_tokens?: number | null;
  cache_creation_tokens?: number | null;
  cost_cents?: number | null;
  server_hostname?: string | null;
  server_pid?: number | null;
  metadata?: Record<string, unknown> | null;
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const floored = Math.floor(value);
  return floored >= 0 ? floored : null;
}

export function parseInferenceRequestMeta(
  payload: Record<string, unknown> | null | undefined,
  defaults?: { source?: string | null; client_name?: string | null },
): InferenceRequestMeta {
  return {
    purpose: normalizeString(payload?.purpose),
    session_id: normalizeString(payload?.session_id),
    conversation_id: normalizeString(payload?.conversation_id),
    trace_id: normalizeString(payload?.trace_id),
    client_name: normalizeString(payload?.client_name) ?? defaults?.client_name ?? null,
    client_version: normalizeString(payload?.client_version),
    source: normalizeString(payload?.source) ?? defaults?.source ?? null,
    context_input_tokens: normalizeNumber(payload?.context_input_tokens),
    message_count: normalizeNumber(payload?.message_count),
  };
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function sha256Json(value: unknown): string {
  return sha256Hex(JSON.stringify(value));
}

export function serializedCharCount(value: unknown): number {
  if (typeof value === "string") return value.length;
  return JSON.stringify(value).length;
}

export function currentServerHostname(): string {
  return hostname();
}

export function buildInferenceAuditRpcBody(event: PoolBRemoteAuditEvent): Record<string, unknown> {
  return {
    p_pool: event.pool,
    p_route: event.route,
    p_request_id: event.request_id,
    p_attempt_no: Math.max(0, Math.floor(event.attempt_no ?? 0)),
    p_user_id: event.user_id ?? null,
    p_subscription_id: event.subscription_id ?? null,
    p_device_id: event.device_id ?? null,
    p_purpose: event.purpose ?? null,
    p_client_name: event.client_name ?? null,
    p_client_version: event.client_version ?? null,
    p_source: event.source ?? null,
    p_session_id: event.session_id ?? null,
    p_conversation_id: event.conversation_id ?? null,
    p_trace_id: event.trace_id ?? null,
    p_provider: event.provider ?? "control-plane",
    p_fallback_mode: event.fallback_mode ?? "anthropic_only",
    p_fallback_used: event.fallback_used ?? false,
    p_provider_response_id: event.provider_response_id ?? null,
    p_model: event.model ?? null,
    p_status: event.status,
    p_outcome: event.outcome,
    p_error_class: event.error_class ?? null,
    p_duration_ms: event.duration_ms ?? null,
    p_prompt_chars: event.prompt_chars ?? null,
    p_message_count: event.message_count ?? null,
    p_context_input_tokens: event.context_input_tokens ?? null,
    p_prompt_sha256: event.prompt_sha256 ?? null,
    p_prompt_tokens: event.prompt_tokens ?? null,
    p_completion_tokens: event.completion_tokens ?? null,
    p_cache_read_tokens: event.cache_read_tokens ?? 0,
    p_cache_creation_tokens: event.cache_creation_tokens ?? 0,
    p_cost_cents: event.cost_cents ?? null,
    p_server_hostname: event.server_hostname ?? currentServerHostname(),
    p_server_pid: event.server_pid ?? process.pid,
    p_metadata: event.metadata ?? {},
  };
}
