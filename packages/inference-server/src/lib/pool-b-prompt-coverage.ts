import { callAnthropicOAuth, inferenceBackend } from "./anthropic-oauth.js";
import { callOpenAiTextResponse } from "./openai-responses.js";
import { hasPoolBOpenAiKey, poolBOpenAiModel, poolBProviderMode, type PoolBProviderMode } from "./pool-b-control.js";

export interface PromptProviderUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

export interface PromptCoverageAttempt {
  attempt_no: number;
  provider: "anthropic_oauth" | "openai_responses";
  requested_model: string;
  provider_model: string;
  provider_response_id: string | null;
  ok: boolean;
  content?: string;
  usage?: PromptProviderUsage;
  cost_cents?: number | null;
  error?: {
    status?: number;
    message: string;
    code?: string;
  };
}

export interface PromptCoverageSuccess {
  provider: "anthropic_oauth" | "openai_responses";
  model: string;
  provider_response_id: string | null;
  content: string;
  usage: PromptProviderUsage;
  cost_cents: number | null;
  fallback_used: boolean;
}

export type PromptCoverageResult =
  | {
      ok: true;
      provider_mode: PoolBProviderMode;
      attempts: PromptCoverageAttempt[];
      success: PromptCoverageSuccess;
    }
  | {
      ok: false;
      provider_mode: PoolBProviderMode;
      attempts: PromptCoverageAttempt[];
      last_error: {
        status?: number;
        message: string;
        code?: string;
      };
    };

function anthropicCostCents(usage: PromptProviderUsage): number {
  const usd =
    ((usage.input_tokens * 3) +
      (usage.output_tokens * 15) +
      (usage.cache_read_input_tokens * 0.3) +
      (usage.cache_creation_input_tokens * 3.75)) / 1_000_000;
  return Math.round(usd * 100);
}

function openAiCostCents(usage: PromptProviderUsage): number | null {
  const inputRate = Number(process.env.WAVEX_OS_POOL_B_OPENAI_INPUT_USD_PER_1M ?? "");
  const outputRate = Number(process.env.WAVEX_OS_POOL_B_OPENAI_OUTPUT_USD_PER_1M ?? "");
  if (!Number.isFinite(inputRate) || inputRate <= 0 || !Number.isFinite(outputRate) || outputRate <= 0) {
    return null;
  }
  const usd = ((usage.input_tokens * inputRate) + (usage.output_tokens * outputRate)) / 1_000_000;
  return Math.round(usd * 100);
}

function providerPlan(requestedModel: string): Array<{ provider: "anthropic_oauth" | "openai_responses"; model: string }> {
  const mode = poolBProviderMode();
  const openAiModel = poolBOpenAiModel();
  if (mode === "codex_only") {
    return [{ provider: "openai_responses", model: openAiModel }];
  }
  if (mode === "anthropic_then_codex") {
    return [
      { provider: "anthropic_oauth", model: requestedModel },
      { provider: "openai_responses", model: openAiModel },
    ];
  }
  return [{ provider: "anthropic_oauth", model: requestedModel }];
}

export async function runPoolBPromptCoverage(args: {
  prompt: string;
  requestedModel: string;
  maxTokens: number;
  metadata?: Record<string, string>;
}): Promise<PromptCoverageResult> {
  const mode = poolBProviderMode();
  const attempts: PromptCoverageAttempt[] = [];

  for (const plan of providerPlan(args.requestedModel)) {
    const attempt_no = attempts.length + 1;
    try {
      if (plan.provider === "anthropic_oauth") {
        if (inferenceBackend() !== "oauth") {
          throw Object.assign(new Error("WAVEX_INFERENCE_BACKEND must be oauth for Anthropic Pool B coverage"), {
            status: 503,
            code: "anthropic_backend_not_oauth",
          });
        }
        const r = await callAnthropicOAuth({
          model: plan.model,
          max_tokens: args.maxTokens,
          messages: [{ role: "user", content: args.prompt }],
        });
        const content = r.content
          .map((c) => (c.type === "text" ? (c as { text: string }).text : ""))
          .join("");
        const usage = {
          input_tokens: r.usage.input_tokens,
          output_tokens: r.usage.output_tokens,
          cache_read_input_tokens: r.usage.cache_read_input_tokens ?? 0,
          cache_creation_input_tokens: r.usage.cache_creation_input_tokens ?? 0,
        };
        const success: PromptCoverageSuccess = {
          provider: plan.provider,
          model: r.model ?? plan.model,
          provider_response_id: r.id,
          content,
          usage,
          cost_cents: anthropicCostCents(usage),
          fallback_used: attempt_no > 1,
        };
        attempts.push({
          attempt_no,
          provider: plan.provider,
          requested_model: args.requestedModel,
          provider_model: success.model,
          provider_response_id: r.id,
          ok: true,
          content,
          usage,
          cost_cents: success.cost_cents,
        });
        return { ok: true, provider_mode: mode, attempts, success };
      }

      if (!hasPoolBOpenAiKey()) {
        throw Object.assign(new Error("OPENAI_API_KEY is not configured for Pool B Codex fallback"), {
          status: 503,
          code: "openai_key_missing",
        });
      }
      const r = await callOpenAiTextResponse({
        model: plan.model,
        input: args.prompt,
        max_output_tokens: args.maxTokens,
        metadata: args.metadata,
      });
      const usage = {
        input_tokens: r.usage.input_tokens,
        output_tokens: r.usage.output_tokens,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      };
      const success: PromptCoverageSuccess = {
        provider: plan.provider,
        model: r.model ?? plan.model,
        provider_response_id: r.id,
        content: r.output_text,
        usage,
        cost_cents: openAiCostCents(usage),
        fallback_used: attempt_no > 1,
      };
      attempts.push({
        attempt_no,
        provider: plan.provider,
        requested_model: args.requestedModel,
        provider_model: success.model,
        provider_response_id: r.id,
        ok: true,
        content: r.output_text,
        usage,
        cost_cents: success.cost_cents,
      });
      return { ok: true, provider_mode: mode, attempts, success };
    } catch (error) {
      const err = error as { status?: number; message?: string; code?: string };
      attempts.push({
        attempt_no,
        provider: plan.provider,
        requested_model: args.requestedModel,
        provider_model: plan.model,
        provider_response_id: null,
        ok: false,
        error: {
          status: err.status,
          message: err.message ?? "provider_call_failed",
          code: err.code,
        },
      });
    }
  }

  const last = attempts[attempts.length - 1];
  return {
    ok: false,
    provider_mode: mode,
    attempts,
    last_error: {
      status: last?.error?.status,
      message: last?.error?.message ?? "provider_call_failed",
      code: last?.error?.code,
    },
  };
}
