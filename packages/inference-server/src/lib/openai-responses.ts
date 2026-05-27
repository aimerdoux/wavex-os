interface OpenAiUsage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

interface OpenAiErrorBody {
  error?: {
    message?: string;
    code?: string;
    type?: string;
  };
}

export interface OpenAiTextResponse {
  id: string;
  model?: string;
  output_text: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
}

export interface OpenAiResponseError extends Error {
  status?: number;
  body?: string;
  code?: string;
}

function getOpenAiKey(): string {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) {
    const err = new Error("OPENAI_API_KEY is not configured") as OpenAiResponseError;
    err.status = 503;
    err.code = "openai_key_missing";
    throw err;
  }
  return key;
}

function extractOutputText(payload: Record<string, unknown>): string {
  if (typeof payload.output_text === "string") return payload.output_text;

  const output = Array.isArray(payload.output) ? payload.output : [];
  const chunks: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = Array.isArray((item as { content?: unknown }).content)
      ? (item as { content: Array<Record<string, unknown>> }).content
      : [];
    for (const part of content) {
      if (part?.type === "output_text" && typeof part.text === "string") {
        chunks.push(part.text);
      }
    }
  }
  return chunks.join("");
}

export async function callOpenAiTextResponse(args: {
  model: string;
  input: string;
  max_output_tokens: number;
  metadata?: Record<string, string>;
}): Promise<OpenAiTextResponse> {
  const key = getOpenAiKey();
  const resp = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: args.model,
      input: args.input,
      max_output_tokens: args.max_output_tokens,
      metadata: args.metadata,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    let message = body.slice(0, 400);
    let code: string | undefined;
    try {
      const parsed = JSON.parse(body) as OpenAiErrorBody;
      if (parsed.error?.message) message = parsed.error.message;
      code = parsed.error?.code;
    } catch {
      // fall back to raw body slice
    }
    const err = new Error(`OpenAI Responses call failed (${resp.status})`) as OpenAiResponseError;
    err.status = resp.status;
    err.body = body;
    err.code = code;
    err.message = message;
    throw err;
  }

  const payload = (await resp.json()) as Record<string, unknown>;
  const usage = (payload.usage ?? {}) as OpenAiUsage;
  return {
    id: typeof payload.id === "string" ? payload.id : "resp_unknown",
    model: typeof payload.model === "string" ? payload.model : args.model,
    output_text: extractOutputText(payload),
    usage: {
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      total_tokens: usage.total_tokens ?? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
    },
  };
}
