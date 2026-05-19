/** Persistent help-chat sidebar. Operators can ask questions about
 *  fields/concepts as they fill out the wizard; T2 answers in-context
 *  using the current phase + field + everything the operator has filled
 *  in so far. Conversation is stored per-company and surfaces across
 *  pillar/phase navigation.
 *
 *  The chat is read-only: it explains, recommends ways to think about a
 *  field, but does NOT mutate any pillar/phase state. Mutating the wizard
 *  via natural language is a separate (bigger) project.
 *
 *  Routes:
 *    GET  /api/instance/:companyId/help-chat
 *      → { ok, messages: HelpMessage[] }
 *    POST /api/instance/:companyId/help-chat
 *      { message, phase?, field? }
 *      → { ok, messages, latest_assistant }
 *
 *  All T2 calls go through withTokenAccounting so they roll into the
 *  per-company token budget + counter. */

import { z } from "zod";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { route as tierRoute } from "@op-omega/plugin-tier-router";
import { assertBoard, assertCompanyAccess, AuthError } from "@wavex-os/auth-shim";
import { loadPillarResponses } from "@op-omega/plugin-onboarding";
import { getOnboardingDir } from "../state-bridge.js";
import {
  buildChiefContext,
  renderChiefContextBlock,
  rewriteSlashCommand,
} from "../mission-control/chief-context.js";
import { withTokenAccounting } from "../lib/token-accounting.js";
import { BudgetExhaustedError } from "../lib/token-budget.js";

interface HelpMessage {
  role: "user" | "assistant";
  ts_iso: string;
  text: string;
  /** Phase the user was on when they asked (for context). */
  phase?: string;
  /** Specific field they were focused on, if known. */
  field?: string;
}

interface HelpChatFile {
  companyId: string;
  messages: HelpMessage[];
}

const MAX_HISTORY = 40;
const MAX_MESSAGE_LEN = 1500;
const MAX_REPLY_LEN = 800;

const postSchema = z.object({
  message: z.string().min(1).max(MAX_MESSAGE_LEN),
  phase: z.string().max(40).optional(),
  field: z.string().max(80).optional(),
  // "onboarding" (default) keeps the original pillar-context behavior used
  // by the wizard sidebar. "board" repoints the chat for post-handoff
  // operation: the assistant impersonates the Chief of Staff and grounds
  // its answers in the activated company manifest + live fleet state.
  mode: z.enum(["onboarding", "board"]).default("onboarding"),
  /** Current Paperclip route the operator is viewing (board mode only).
   *  Used as additional context so the CoS biases its answer toward the
   *  agent / page the operator is actually looking at. */
  currentPath: z.string().max(200).optional(),
});

function authReq(req: FastifyRequest) {
  return { method: req.method, headers: req.headers as Record<string, string> };
}

function chatPath(companyId: string, mode: "onboarding" | "board" = "onboarding"): string {
  return join(
    getOnboardingDir(companyId),
    mode === "board" ? "board-chat.json" : "help-chat.json",
  );
}

async function readChat(companyId: string, mode: "onboarding" | "board" = "onboarding"): Promise<HelpChatFile> {
  try {
    const raw = await readFile(chatPath(companyId, mode), "utf8");
    return JSON.parse(raw) as HelpChatFile;
  } catch {
    return { companyId, messages: [] };
  }
}

async function writeChat(companyId: string, file: HelpChatFile, mode: "onboarding" | "board" = "onboarding"): Promise<void> {
  const path = chatPath(companyId, mode);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(file, null, 2), "utf8");
  const { rename } = await import("node:fs/promises");
  await rename(tmp, path);
}

function buildPrompt(opts: {
  message: string;
  phase?: string;
  field?: string;
  pillarContext: string;
  history: HelpMessage[];
}): string {
  const lastMessages = opts.history.slice(-6).map((m) => `${m.role}: ${m.text}`).join("\n");
  return `You are an onboarding concierge for WaveX OS — the founder of an AI-agent company is setting up their fleet and you sit next to them throughout the wizard. You're a senior operator yourself: opinionated, terse, helpful. Treat this like a real conversation with someone shipping a real company.

Behavior:
- ANSWER what they actually ask, including business / strategy / "what should I do" questions. Don't refuse strategic questions by saying "I'm just here to help fill out the form" — that's the wrong stance. You're a concierge, not a form police. Ground your answer in the pillar context below when relevant.
- For form-field questions, explain what the field means, what good answers look like, common pitfalls, and (when you have enough signal from the context) recommend the specific choice that fits this customer. Recommending is fine — say WHY.
- Be concrete. Name agents, KPIs, or specific tools when relevant. Avoid wishy-washy "it depends" hedging unless the data really is ambiguous.
- Under ${MAX_REPLY_LEN} characters. Plain text, no markdown headers, no preamble.

CURRENT CONTEXT:
- Phase: ${opts.phase ?? "(not specified)"}
- Field: ${opts.field ?? "(not specified)"}

WHAT THE OPERATOR HAS FILLED IN SO FAR:
${opts.pillarContext || "(nothing yet)"}

RECENT CONVERSATION (oldest first):
${lastMessages || "(none)"}

OPERATOR'S NEW QUESTION:
${opts.message}

Your reply (plain text, under ${MAX_REPLY_LEN} chars, opinionated, grounded):`;
}

/** Build the system prompt for board mode — used post-onboarding on the
 *  Paperclip Dashboard chat. The assistant impersonates the company's
 *  Chief of Staff: terse, grounded in current fleet state, opinionated.
 *
 *  Output supports light markdown (**bold**, *italic*, lists, `code`) and
 *  inline action chips of the form [[ACTION:type:arg]] which the client
 *  renders as one-click buttons. Supported action types:
 *    [[ACTION:pause-agent:<slot>]]   — pause a single agent
 *    [[ACTION:resume-agent:<slot>]]  — resume a single agent
 *    [[ACTION:pause-fleet]]          — pause the whole fleet
 *    [[ACTION:resume-fleet]]         — resume the whole fleet
 *  Only emit actions when concretely advisable; never speculate. */
function buildBoardPrompt(opts: {
  message: string;
  companyName: string;
  fleetContext: string;
  currentPath?: string;
  history: HelpMessage[];
}): string {
  const lastMessages = opts.history.slice(-6).map((m) => `${m.role}: ${m.text}`).join("\n");
  return `You are the Chief of Staff for ${opts.companyName}. The operator just shipped the company and is asking you for situational read or guidance. Answer in plain English, under ${MAX_REPLY_LEN} characters. Be terse, honest, actionable. Ground every answer in the actual fleet state below — name specific agents, KPIs, or runs when relevant. If the operator asks about something outside fleet ops (general questions about the system, billing, etc.), redirect them to the right surface.

FORMATTING:
- Light markdown is OK: **bold** for names, *italic* for emphasis, \`code\` for slots/ids, hyphen bullets for lists.
- If you concretely recommend an action the operator should take, append exactly one chip per recommended action on its own line, format: [[ACTION:type:arg]]
  Supported types: pause-agent (arg=slot), resume-agent (arg=slot), pause-fleet (no arg), resume-fleet (no arg).
  Only emit actions when warranted by the live fleet state. Don't speculate.

FLEET STATE (live snapshot):
${opts.fleetContext || "(no fleet data available)"}
${opts.currentPath ? `\nOPERATOR IS CURRENTLY VIEWING: ${opts.currentPath}\nIf this looks like an agent page (e.g. /<COMPANY>/agents/<slot>), bias your answer toward that agent.\n` : ""}
RECENT CONVERSATION (oldest first):
${lastMessages || "(none)"}

OPERATOR'S NEW MESSAGE:
${opts.message}

Your reply (light markdown, action chips on own lines, under ${MAX_REPLY_LEN} chars):`;
}

/** Compact fleet-state summary for the board-mode system prompt. Pulls
 *  the signed company manifest from disk for goal/KPI registry, then
 *  fetches LIVE agent state from Paperclip via the per-company handoff
 *  mapping so the CoS sees real current status (active/paused/idle) and
 *  recent activity — not the stale snapshot mock-core wrote at spawn.
 *  Trimmed aggressively so token use stays bounded. */
async function summarizeBoardContext(companyId: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  const lines: string[] = [];
  const onboardingDir = getOnboardingDir(companyId);
  // company.manifest.json — signed final manifest (KPI registry, swarm, etc.)
  try {
    const raw = await readFile(join(onboardingDir, "company.manifest.json"), "utf8");
    const parsed = JSON.parse(raw) as {
      company?: { name?: string };
      goal?: { kpiId?: string; current?: number; target?: number; days?: number };
      kpi_registry?: { entries?: Array<{ kpiId?: string; label?: string; ownerRole?: string }> };
    };
    if (parsed.company?.name) lines.push(`Company: ${parsed.company.name}`);
    if (parsed.goal) {
      const g = parsed.goal;
      lines.push(`Goal KPI: ${g.kpiId} — current ${g.current ?? "?"} → target ${g.target ?? "?"} (${g.days ?? "?"}d window)`);
    }
    const top = parsed.kpi_registry?.entries?.slice(0, 6) ?? [];
    if (top.length) {
      lines.push("Top KPIs:");
      for (const k of top) lines.push(`  - ${k.label} (owned by ${k.ownerRole ?? "?"})`);
    }
  } catch { /* manifest not yet written */ }
  // Live fleet status from Paperclip — read paperclip-handoff.json for the
  // mapping, then GET /api/companies/<id>/agents for the authoritative
  // current state. Falls back gracefully if Paperclip is unreachable or
  // the handoff hasn't run.
  try {
    const mappingRaw = await readFile(join(onboardingDir, "..", "paperclip-handoff.json"), "utf8");
    const mapping = JSON.parse(mappingRaw) as { paperclipUrl?: string; paperclipCompanyId?: string };
    if (mapping.paperclipUrl && mapping.paperclipCompanyId) {
      const resp = await fetch(`${mapping.paperclipUrl}/api/companies/${mapping.paperclipCompanyId}/agents`);
      if (resp.ok) {
        const agents = await resp.json() as Array<{
          id: string; name?: string; status: string; urlKey?: string;
          lastHeartbeatAt?: string | null;
        }>;
        const byStatus = new Map<string, number>();
        for (const a of agents) byStatus.set(a.status, (byStatus.get(a.status) ?? 0) + 1);
        const summary = [...byStatus.entries()]
          .map(([s, n]) => `${n} ${s}`)
          .join(", ");
        lines.push(`Fleet (${agents.length} total): ${summary}`);
        // Surface paused/error agents by name so the CoS can call them out.
        const flagged = agents.filter((a) => a.status === "paused" || a.status === "error").slice(0, 8);
        if (flagged.length) {
          lines.push("Flagged agents:");
          for (const a of flagged) {
            lines.push(`  - \`${a.urlKey ?? a.id}\` (${a.name ?? "?"}) — ${a.status}`);
          }
        }
      }
    }
  } catch { /* paperclip unreachable or handoff not run */ }
  return lines.join("\n");
}

async function summarizePillars(companyId: string): Promise<string> {
  const responses = await loadPillarResponses(companyId).catch(() => null);
  if (!responses) return "";
  const lines: string[] = [];
  const p1 = responses.pillar_1 as { org_name?: string; company_context?: string; industry_hint?: string; business_model_hint?: string } | undefined;
  if (p1) {
    if (p1.org_name) lines.push(`Company: ${p1.org_name}`);
    if (p1.industry_hint) lines.push(`Industry: ${p1.industry_hint}`);
    if (p1.business_model_hint) lines.push(`Business model: ${p1.business_model_hint}`);
    if (p1.company_context) lines.push(`Context: ${p1.company_context.slice(0, 200)}`);
  }
  const p3 = responses.pillar_3 as { stage?: string; product_state?: string } | undefined;
  if (p3?.stage) lines.push(`Stage: ${p3.stage}`);
  if (p3?.product_state) lines.push(`Product state: ${p3.product_state}`);
  const p4 = responses.pillar_4 as { sales_motion?: string; lead_sources?: string[] } | undefined;
  if (p4?.sales_motion) lines.push(`Sales motion: ${p4.sales_motion}`);
  if (p4?.lead_sources) lines.push(`Lead sources: ${p4.lead_sources.join(", ")}`);
  return lines.join("\n");
}

export function registerHelpChatRoute(app: FastifyInstance): void {
  app.get<{ Querystring: { mode?: string } }>("/api/instance/:companyId/help-chat", async (req, reply) => {
    const ar = authReq(req);
    try { assertBoard(ar); } catch (e) {
      if (e instanceof AuthError) return reply.status(e.statusCode).send({ error: e.message });
      throw e;
    }
    const { companyId } = req.params as { companyId: string };
    assertCompanyAccess(ar, companyId);
    const mode = req.query.mode === "board" ? "board" : "onboarding";
    const chat = await readChat(companyId, mode);
    return { ok: true, messages: chat.messages };
  });

  app.post("/api/instance/:companyId/help-chat", async (req, reply) => {
    const ar = authReq(req);
    try { assertBoard(ar); } catch (e) {
      if (e instanceof AuthError) return reply.status(e.statusCode).send({ error: e.message });
      throw e;
    }
    const { companyId } = req.params as { companyId: string };
    assertCompanyAccess(ar, companyId);
    const parsed = postSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ ok: false, error: "validation failed", issues: parsed.error.issues });
    }

    const mode = parsed.data.mode;
    const chat = await readChat(companyId, mode);
    chat.messages.push({
      role: "user",
      ts_iso: new Date().toISOString(),
      text: parsed.data.message,
      phase: parsed.data.phase,
      field: parsed.data.field,
    });

    // Phase 5 v2 — slash-command pre-processor for board mode.
    // /briefing /anomalies /orphans get rewritten into longer canonical
    // prompts before T2 sees them.
    const operatorMessage =
      mode === "board"
        ? (rewriteSlashCommand(parsed.data.message) ?? parsed.data.message)
        : parsed.data.message;

    let assistantText: string;
    try {
      // Phase 5 v2 — inject Mission Control state into board prompts.
      // The Chief AI lives ONLY in the Kernel chat (per user spec); no
      // widget surface. Built every request: cheap (one scoreboard read +
      // one graph read + one event scan) and keeps the answer grounded
      // in current state instead of a snapshot from N minutes ago.
      const chiefBlock =
        mode === "board"
          ? await buildChiefContext(companyId)
              .then(renderChiefContextBlock)
              .catch(() => "")
          : "";
      const fleetContextBase =
        mode === "board" ? await summarizeBoardContext(companyId) : "";
      const fullPrompt = mode === "board"
        ? buildBoardPrompt({
            message: operatorMessage,
            companyName: companyId,
            fleetContext: chiefBlock
              ? `${chiefBlock}\n\n${fleetContextBase}`
              : fleetContextBase,
            currentPath: parsed.data.currentPath,
            history: chat.messages.slice(0, -1),
          })
        : buildPrompt({
            message: operatorMessage,
            phase: parsed.data.phase,
            field: parsed.data.field,
            pillarContext: await summarizePillars(companyId),
            history: chat.messages.slice(0, -1),
          });
      assistantText = await withTokenAccounting(companyId, mode === "board" ? "board_chat" : "help_chat", async () => {
        const resp = await tierRoute({
          agent_id: mode === "board" ? "post-onboarding.board-chat" : "onboarding.help-chat",
          prompt: fullPrompt,
          task_metadata: {
            creativity_required: false, customer_facing: false,
            reasoning_depth: "shallow", priority: "batch",
          },
          companyId,
          outputFormat: "text",
          timeout_ms: 45_000,
        });
        return resp.output.trim();
      });
    } catch (e) {
      if (e instanceof BudgetExhaustedError) {
        return reply.status(429).send({
          ok: false, error: e.message,
          budget: { used: e.used, cap: e.cap, companyId: e.companyId },
        });
      }
      // Persist the user message even when T2 fails so the operator's
      // question isn't lost; surface the failure as the assistant's reply.
      assistantText = `(I couldn't generate a reply right now: ${e instanceof Error ? e.message : String(e)}. Try again in a moment.)`;
    }

    chat.messages.push({
      role: "assistant",
      ts_iso: new Date().toISOString(),
      text: assistantText.slice(0, MAX_REPLY_LEN * 2),
      phase: parsed.data.phase,
      field: parsed.data.field,
    });

    if (chat.messages.length > MAX_HISTORY) {
      chat.messages = chat.messages.slice(-MAX_HISTORY);
    }
    await writeChat(companyId, chat, mode);
    return {
      ok: true,
      messages: chat.messages,
      latest_assistant: chat.messages[chat.messages.length - 1],
    };
  });
}
