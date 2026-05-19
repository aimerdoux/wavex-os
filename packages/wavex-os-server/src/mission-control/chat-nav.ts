/** Mission Control — Chat-as-nav parser (Frontier F4).
 *
 *  Takes a natural-language question + companyId, returns a STRUCTURED
 *  card payload (not free-form text). The MC UI dispatches on `kind`
 *  to render the appropriate component — most often re-using existing
 *  surfaces (e.g. ReceiptsPanel for KPI questions).
 *
 *  Supported card kinds (v1):
 *    - "kpi"      → open ReceiptsPanel for kpiId
 *    - "decision" → jump to Decisions tab, optionally highlight itemId
 *    - "agent"    → render a text card scoped to a specific node (name + load)
 *    - "text"     → fallback: plain-language answer (used for ambiguous
 *                   questions, general queries, or when LLM fails JSON)
 *
 *  The LLM is constrained via strict-JSON prompt + post-parse validation.
 *  If parsing fails, we fall back to a `text` card with the raw output so
 *  the operator never sees a broken state.
 *
 *  No caching — chat is interactive and stateless.
 */

import { route as tierRoute } from "@wavex-os/plugin-tier-router";
import { buildChiefContext, renderChiefContextBlock } from "./chief-context.js";

export type CardKind = "kpi" | "decision" | "agent" | "text";

export interface AskResult {
  kind: CardKind;
  /** Free-form payload depending on kind. */
  payload: Record<string, unknown>;
  /** Plain-language sentence shown above the card (sets context). */
  preface: string;
  generatedAt: string;
  source: "llm" | "fallback";
}

const SYSTEM_PROMPT = `You are the Mission Control navigator for a non-technical operator running an AI-agent company. Given a natural-language question and the <mission-control-state> block, return STRICT JSON describing what card the UI should render. Always include a short \`preface\` sentence (under 25 words) that introduces the card.

Return one of:

  { "kind": "kpi", "kpiId": "<exact_kpiId_from_state>", "preface": "..." }
  { "kind": "decision", "preface": "..." }
  { "kind": "agent", "nodeId": "<scope_node_id>", "nodeName": "...", "preface": "..." }
  { "kind": "text", "answer": "<2-3 sentence plain-language reply>", "preface": "..." }

Rules:
- Prefer "kpi" when the question names a KPI or asks about progress/numbers.
- Prefer "decision" when the question asks "what should I do", "what's next", "approve…", or about blockers.
- Prefer "agent" when the question names a specific role (CMO, CFO, etc.) or asks about who.
- Use "text" only when none of the structured kinds fit, or when the state has no relevant data.
- Never invent KPI ids or node ids. If you can't ground them in <mission-control-state>, use "text".
- Output NOTHING outside the JSON object. No markdown, no commentary.
- The preface is the first thing the operator reads — make it useful and specific.
`;

function tryParse(raw: string): Record<string, unknown> | null {
  const stripped = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try {
    const parsed = JSON.parse(stripped);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function fallbackText(question: string, raw?: string): AskResult {
  return {
    kind: "text",
    payload: {
      answer: raw?.trim() || "I couldn't answer that one. Try asking about a specific KPI or 'what needs my attention?'",
    },
    preface: `On "${question.slice(0, 80)}":`,
    generatedAt: new Date().toISOString(),
    source: "fallback",
  };
}

export async function askMissionControl(
  companyId: string,
  question: string,
): Promise<AskResult> {
  if (!question?.trim()) {
    return fallbackText("(empty question)");
  }
  const ctx = await buildChiefContext(companyId).catch(() => null);
  if (!ctx) {
    return fallbackText(question, "Mission Control state isn't available right now.");
  }

  const block = renderChiefContextBlock(ctx);
  const prompt = `${SYSTEM_PROMPT}\n\n${block}\n\n<question>${question.trim()}</question>\n\nReturn STRICT JSON only.`;

  let raw = "";
  try {
    const resp = await tierRoute({
      agent_id: "mission-control.chat-nav",
      prompt,
      task_metadata: {
        creativity_required: false,
        customer_facing: true,
        reasoning_depth: "shallow",
        priority: "batch",
      },
      companyId,
      outputFormat: "text",
      timeout_ms: 25_000,
    });
    raw = resp.output ?? "";
  } catch (err) {
    return fallbackText(question, err instanceof Error ? err.message : String(err));
  }

  const parsed = tryParse(raw);
  if (!parsed || typeof parsed.kind !== "string") {
    return fallbackText(question, raw);
  }
  const kind = parsed.kind as string;
  const preface = typeof parsed.preface === "string" ? parsed.preface : `On "${question.slice(0, 80)}":`;
  const generatedAt = new Date().toISOString();

  if (kind === "kpi" && typeof parsed.kpiId === "string") {
    // Validate against the actual scoreboard so we don't open a panel
    // for a hallucinated id.
    const valid = ctx.scoreboard.some((k) => k.kpiId === parsed.kpiId);
    if (!valid) return fallbackText(question, `I don't see a KPI named "${parsed.kpiId}" in the current state.`);
    return {
      kind: "kpi",
      payload: { kpiId: parsed.kpiId },
      preface,
      generatedAt,
      source: "llm",
    };
  }

  if (kind === "decision") {
    return {
      kind: "decision",
      payload: {},
      preface,
      generatedAt,
      source: "llm",
    };
  }

  if (kind === "agent" && typeof parsed.nodeId === "string") {
    return {
      kind: "agent",
      payload: {
        nodeId: parsed.nodeId,
        nodeName: typeof parsed.nodeName === "string" ? parsed.nodeName : null,
      },
      preface,
      generatedAt,
      source: "llm",
    };
  }

  if (kind === "text") {
    return {
      kind: "text",
      payload: { answer: typeof parsed.answer === "string" ? parsed.answer : raw },
      preface,
      generatedAt,
      source: "llm",
    };
  }

  return fallbackText(question, raw);
}
