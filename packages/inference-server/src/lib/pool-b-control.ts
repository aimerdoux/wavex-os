import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export const POOL_B_ENABLED_ENV = "WAVEX_OS_STREAMING_INFERENCE_ENABLED";
const DEFAULT_DISABLED_MESSAGE =
  "streaming inference is temporarily disabled pending security hardening and observability rollout";
const DEFAULT_RATE_LIMIT_WINDOW_SEC = 300;
const DEFAULT_RATE_LIMIT_MAX_REQUESTS = 12;
const DEFAULT_IDEMPOTENCY_TTL_SEC = 6 * 60 * 60;
const DEFAULT_PROVIDER_MODE = "anthropic_only";
const DEFAULT_OPENAI_MODEL = "gpt-5";

export type PoolBProviderMode =
  | "anthropic_only"
  | "codex_only"
  | "anthropic_then_codex";

export type PoolBAuditStatus =
  | "accepted"
  | "disabled"
  | "rejected"
  | "failed"
  | "rate_limited"
  | "duplicate";

export interface PoolBAuditEvent {
  route: "http" | "realtime" | "anthropic-messages";
  request_id: string | null;
  user_id: string | null;
  device_id: string | null;
  status: PoolBAuditStatus;
  outcome: string;
  duration_ms?: number;
  model?: string | null;
  cost_cents?: number;
  error_class?: string | null;
  detail?: string | null;
}

function stateDir(): string {
  return process.env.STATE_DIR ?? join(homedir(), ".wavex-os", "state");
}

export function poolBAuditLogPath(): string {
  return join(stateDir(), "pool-b-audit.jsonl");
}

export function isPoolBEnabled(): boolean {
  return process.env[POOL_B_ENABLED_ENV] === "1";
}

export function poolBDisabledMessage(): string {
  return process.env.WAVEX_OS_STREAMING_INFERENCE_DISABLED_MESSAGE ?? DEFAULT_DISABLED_MESSAGE;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function poolBRateLimitWindowSec(): number {
  return parsePositiveInt(process.env.WAVEX_OS_POOL_B_RATE_LIMIT_WINDOW_SEC, DEFAULT_RATE_LIMIT_WINDOW_SEC);
}

export function poolBRateLimitMaxRequests(): number {
  return parsePositiveInt(process.env.WAVEX_OS_POOL_B_RATE_LIMIT_MAX_REQUESTS, DEFAULT_RATE_LIMIT_MAX_REQUESTS);
}

export function poolBIdempotencyTtlSec(): number {
  return parsePositiveInt(process.env.WAVEX_OS_POOL_B_IDEMPOTENCY_TTL_SEC, DEFAULT_IDEMPOTENCY_TTL_SEC);
}

export function poolBProviderMode(): PoolBProviderMode {
  const value = (process.env.WAVEX_OS_POOL_B_PROVIDER_MODE ?? DEFAULT_PROVIDER_MODE).trim();
  if (value === "codex_only" || value === "anthropic_then_codex") return value;
  return "anthropic_only";
}

export function poolBOpenAiModel(): string {
  return (process.env.WAVEX_OS_POOL_B_OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL).trim() || DEFAULT_OPENAI_MODEL;
}

export function hasPoolBOpenAiKey(): boolean {
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}

export async function appendPoolBAuditEvent(event: PoolBAuditEvent): Promise<void> {
  const row = {
    ts_iso: new Date().toISOString(),
    ...event,
  };
  try {
    await mkdir(stateDir(), { recursive: true });
    await appendFile(poolBAuditLogPath(), `${JSON.stringify(row)}\n`);
  } catch (err) {
    console.error("pool-b-audit append failed", err);
  }
}
