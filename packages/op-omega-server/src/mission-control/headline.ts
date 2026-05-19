/** Mission Control — Living Headline generator (Frontier F1).
 *
 *  Generates the single-sentence display-type Headline + 2-3 sentence
 *  narrative shown at the top of Mission Control. Uses the same
 *  structured context as the Kernel chat (Phase 5) but renders the
 *  LLM output as a strict JSON payload instead of free-form chat.
 *
 *  Falls back to a deterministic templated headline if the LLM call
 *  fails or budgets out — the surface MUST always render something.
 *
 *  Cache: 5 min per companyId (in-memory). The Headline isn't billable
 *  on every load — operators may open MC repeatedly.
 */

import { route as tierRoute } from "@op-omega/plugin-tier-router";
import { buildChiefContext, renderChiefContextBlock, type ChiefContext } from "./chief-context.js";
import type { OrbResult } from "./health-orb.js";

export type HeadlineSentiment = "good" | "mixed" | "urgent" | "neutral";

export interface HeadlineResult {
  headline: string;
  narrative: string;
  sentiment: HeadlineSentiment;
  generatedAt: string;
  cached: boolean;
  /** "llm" if Claude generated it, "fallback" if we synthesized it. */
  source: "llm" | "fallback";
}

const CACHE_TTL_MS = 5 * 60 * 1000;
interface CacheEntry {
  result: HeadlineResult;
  expiresAt: number;
}
const cache = new Map<string, CacheEntry>();

const SYSTEM_PROMPT = `You are the Chief of Staff for a non-technical operator running an AI-agent company. Your job is to read the mission-control state and produce a brief, plain-English headline.

You will return STRICT JSON (no markdown, no commentary outside the JSON):

{
  "headline": "single sentence, 8-14 words, present-tense, declarative — answers 'where are we?'",
  "narrative": "2-3 sentences, ~50-80 words, cite specific KPIs/agents/numbers from the state; do NOT speculate.",
  "sentiment": "good" | "mixed" | "urgent" | "neutral"
}

Rules:
- Use proper-noun agent names + KPI names from the state. Never use UUIDs.
- The headline is the ONE thing the operator should know if they only read one sentence.
- "good" = on-track everywhere; "mixed" = mostly on track with 1-2 issues; "urgent" = at least one KPI off-track OR runway crisis OR overdue approval > 72h; "neutral" = no data yet.
- If the state is empty (no KPIs declared, no events), say so plainly — do not invent. Use sentiment "neutral".
- Never make up numbers. If you don't have a number, omit it rather than guess.
`;

function fallbackHeadline(ctx: ChiefContext, orb: OrbResult | null): HeadlineResult {
  const generatedAt = new Date().toISOString();
  const off = ctx.scoreboard.filter((k) => k.status === "off-track");
  const risk = ctx.scoreboard.filter((k) => k.status === "at-risk");
  const orphans = ctx.orphanedWork.length;
  const recent = ctx.recentEvents.length;
  let sentiment: HeadlineSentiment = "neutral";
  if (ctx.scoreboard.length === 0 && recent === 0) {
    return {
      headline: "Mission Control is set up — declare your first KPI to start tracking.",
      narrative:
        "No KPIs have been declared yet, so there's nothing to score. Once your first task records an expected KPI impact, the headline will reflect real movement.",
      sentiment: "neutral",
      generatedAt,
      cached: false,
      source: "fallback",
    };
  }
  if (off.length > 0 || (orb?.status === "action")) {
    sentiment = "urgent";
    return {
      headline: `${off.length || 1} KPI${off.length === 1 ? " is" : "s are"} off-track — your attention is needed.`,
      narrative:
        `${off.map((k) => k.kpiId).slice(0, 3).join(", ")} ${off.length === 1 ? "is" : "are"} significantly behind target. ${ctx.recentEvents.length} events in the last 24h; ${orphans} orphan tasks without declared KPI impact.`,
      sentiment,
      generatedAt,
      cached: false,
      source: "fallback",
    };
  }
  if (risk.length > 0) {
    sentiment = "mixed";
    return {
      headline: `Mostly on track — ${risk.length} KPI${risk.length === 1 ? "" : "s"} worth watching.`,
      narrative:
        `${risk.map((k) => k.kpiId).slice(0, 3).join(", ")} trending below pace. ${recent} events in the last 24h.`,
      sentiment,
      generatedAt,
      cached: false,
      source: "fallback",
    };
  }
  sentiment = "good";
  return {
    headline: `All KPIs on track${recent > 0 ? ` — ${recent} events in the last 24h` : ""}.`,
    narrative:
      `No KPIs flagged off-track or at-risk. ${recent} recent events. Nothing requires your immediate attention.`,
    sentiment,
    generatedAt,
    cached: false,
    source: "fallback",
  };
}

function tryParseJson(text: string): { headline: string; narrative: string; sentiment: HeadlineSentiment } | null {
  // The model sometimes wraps JSON in ```json ... ``` despite instructions.
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  try {
    const parsed = JSON.parse(stripped) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;
    const headline = typeof obj.headline === "string" ? obj.headline : null;
    const narrative = typeof obj.narrative === "string" ? obj.narrative : null;
    const sentimentRaw = typeof obj.sentiment === "string" ? obj.sentiment : null;
    if (!headline || !narrative) return null;
    const sentiment: HeadlineSentiment = (
      ["good", "mixed", "urgent", "neutral"] as const
    ).includes(sentimentRaw as HeadlineSentiment)
      ? (sentimentRaw as HeadlineSentiment)
      : "neutral";
    return { headline, narrative, sentiment };
  } catch {
    return null;
  }
}

export async function buildHeadline(
  companyId: string,
  orb: OrbResult | null = null,
): Promise<HeadlineResult> {
  // Cache check.
  const cached = cache.get(companyId);
  if (cached && cached.expiresAt > Date.now()) {
    return { ...cached.result, cached: true };
  }

  const ctx = await buildChiefContext(companyId).catch(
    () => null as ChiefContext | null,
  );
  if (!ctx) {
    const result: HeadlineResult = {
      headline: "Mission Control is starting up — please wait.",
      narrative: "The context aggregator returned no data. Try again in a few seconds.",
      sentiment: "neutral",
      generatedAt: new Date().toISOString(),
      cached: false,
      source: "fallback",
    };
    return result;
  }

  // Try LLM. If anything fails, fall back to the deterministic template.
  let result: HeadlineResult;
  try {
    const contextBlock = renderChiefContextBlock(ctx);
    const userPrompt = `${contextBlock}\n\nReturn STRICT JSON only.`;
    const resp = await tierRoute({
      agent_id: "mission-control.headline",
      prompt: `${SYSTEM_PROMPT}\n\n${userPrompt}`,
      task_metadata: {
        creativity_required: false,
        customer_facing: true,
        reasoning_depth: "shallow",
        priority: "batch",
      },
      companyId,
      outputFormat: "text",
      timeout_ms: 30_000,
    });
    const parsed = tryParseJson(resp.output);
    if (parsed) {
      result = {
        ...parsed,
        generatedAt: new Date().toISOString(),
        cached: false,
        source: "llm",
      };
    } else {
      result = fallbackHeadline(ctx, orb);
    }
  } catch {
    result = fallbackHeadline(ctx, orb);
  }

  cache.set(companyId, { result, expiresAt: Date.now() + CACHE_TTL_MS });
  return result;
}

/** Test helper — clear the cache (also useful for the /headline?refresh=1 endpoint). */
export function invalidateHeadlineCache(companyId?: string): void {
  if (companyId) cache.delete(companyId);
  else cache.clear();
}
