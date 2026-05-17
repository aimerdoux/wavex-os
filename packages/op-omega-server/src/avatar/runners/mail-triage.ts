/** Provider-agnostic mail triage runner — Phase 6.
 *
 *  Replaces the Phase 2 gmail-only `gmail-triage.ts`. Takes a provider id
 *  ("gmail" | "outlook") and uses the corresponding MailProvider to fetch
 *  threads. Everything else (classifier prompt, autonomy preset gating,
 *  approval store, audit log, memory hooks) is provider-agnostic.
 *
 *  Phase 6 additions on top of the Phase 2 runner:
 *    1. Loads `memory/preferences.jsonl` and prepends learned rules to the
 *       classifier prompt as hard constraints.
 *    2. Type strings + activity_log actions are parameterized by provider
 *       id (`avatar.<provider>.draft_reply` etc.) so Outlook + Gmail are
 *       cleanly distinguishable downstream.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { route as tierRoute } from "@op-omega/plugin-tier-router";
import { withTokenAccounting } from "../../lib/token-accounting.js";
import { readPreferences, type PreferenceRule } from "../memory/preferences.js";
import { mirrorToMissionControl } from "../../mission-control/mirror.js";
import { writeDeliverable } from "../../mission-control/deliverables.js";
import { gmailProvider } from "./mail/gmail-provider.js";
import { outlookProvider } from "./mail/outlook-provider.js";
import type { MailClassification, MailProvider, MailThread } from "./mail/types.js";

interface RunResult {
  avatarId: string;
  providerId: string;
  paperclipCompanyId: string;
  agentId: string | null;
  processed: number;
  drafted: number;
  approvalsCreated: number;
  errors: Array<{ threadId: string; message: string }>;
}

interface AvatarProfile {
  name: string;
  role: string;
  working_hours: [string, string];
  tz: string;
}

interface VoiceProfile {
  tone?: string;
  formality?: string;
  structure?: string;
  delegates?: string[];
}

interface VoiceFileShape {
  profile?: VoiceProfile;
  signoff?: string;
  guardrails?: string[];
}

interface ToolsMeta {
  vips?: string[];
  privacy_zones?: string[];
  signoff?: string;
}

interface TrustFile {
  autonomy_preset?: "cautious" | "balanced" | "aggressive";
  vips?: Array<{ email: string; label?: string }>;
  privacy_zones?: string[];
  notify?: string[];
}

interface OperatorContext {
  vips: Array<{ email: string; label?: string }>;
  privacy_zones: string[];
  signoff: string | null;
  guardrails: string[];
  autonomy_preset: "cautious" | "balanced" | "aggressive";
  preferences: PreferenceRule[];
}

const PROVIDER_REGISTRY: Record<string, MailProvider> = {
  gmail: gmailProvider,
  outlook: outlookProvider,
};

function avatarDir(id: string): string {
  const root = process.env.WAVEX_OS_STATE_DIR ?? join(homedir(), ".wavex-os");
  return join(root, "instances", "default", "avatars", id);
}

async function readJson<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; } catch { return null; }
}

function buildClassifierPrompt(provider: MailProvider, thread: MailThread, profile: AvatarProfile, voice: VoiceProfile | null, ctx: OperatorContext): string {
  const voiceBlock = voice
    ? `Voice profile:
- Tone: ${voice.tone ?? "balanced"}
- Formality: ${voice.formality ?? "casual"}
- Structure: ${voice.structure ?? "lists"}
- Delegates first: ${(voice.delegates ?? []).join(", ") || "(unknown)"}`
    : "Voice profile not captured.";

  const vipBlock = ctx.vips.length > 0
    ? `VIP table (always classify as "now" unless content is clearly transactional):
${ctx.vips.map((v) => `- ${v.email}${v.label ? ` (${v.label})` : ""}`).join("\n")}`
    : "VIPs: none flagged.";

  const guardrailsBlock = ctx.guardrails.length > 0
    ? `Draft guardrails — these are hard rules. Never violate them:
${ctx.guardrails.map((g) => `- ${g}`).join("\n")}`
    : "";

  // Phase 6 memory consumer — learned preference rules feed back into the
  // classifier prompt. Each rule has been distilled from operator corrections.
  const preferencesBlock = ctx.preferences.length > 0
    ? `Operator preferences (learned from past corrections — apply as constraints):
${ctx.preferences.map((p) => `- ${p.rule}`).join("\n")}`
    : "";

  const signoffBlock = ctx.signoff
    ? `Sign every draft exactly with: ${ctx.signoff}`
    : "";

  return `You triage incoming ${provider.label} mail for ${profile.name} (${profile.role}). Working hours ${profile.working_hours[0]}–${profile.working_hours[1]} ${profile.tz}.

${voiceBlock}

${vipBlock}

${guardrailsBlock ? guardrailsBlock + "\n\n" : ""}${preferencesBlock ? preferencesBlock + "\n\n" : ""}${signoffBlock ? signoffBlock + "\n\n" : ""}Thread:
- From: ${thread.from.name} <${thread.from.email}>
- Subject: ${thread.subject}
- Preview: ${thread.preview}

Classify as one of:
- "now": VIP-table sender, urgent, or deadline <48h
- "soon": needs reply but not urgent
- "fyi": no reply needed (newsletter, transactional)

If "now" or "soon", draft a reply in the operator's voice. If "fyi", draft is null.

Return JSON only:
{
  "classification": "now" | "soon" | "fyi",
  "draft": "<reply text or null>",
  "confidence": 0.0-1.0,
  "reasoning": "<one short sentence>",
  "open_question": "<question for the operator if you couldn't draft confidently, else null>"
}`;
}

function statusForPreset(preset: OperatorContext["autonomy_preset"], cls: MailClassification): "pending" | "approved" {
  if (preset === "aggressive" && (cls.classification === "now" || cls.classification === "soon") && cls.confidence >= 0.85) {
    return "approved";
  }
  if (preset === "balanced" && cls.classification === "fyi" && cls.confidence >= 0.9) {
    return "approved";
  }
  return "pending";
}

function inPrivacyZone(thread: MailThread, zones: string[]): boolean {
  if (zones.length === 0) return false;
  const hay = `${thread.subject} ${thread.from.email} ${thread.from.name}`.toLowerCase();
  return zones.some((z) => z.trim().length > 0 && hay.includes(z.toLowerCase()));
}

async function classifyOne(
  avatarId: string,
  provider: MailProvider,
  thread: MailThread,
  profile: AvatarProfile,
  voice: VoiceProfile | null,
  ctx: OperatorContext,
  opts: { dryRun: boolean; skipInference: boolean },
): Promise<MailClassification> {
  if (opts.dryRun && opts.skipInference) return provider.classifyStub(thread);
  try {
    const text = await withTokenAccounting(avatarId, "avatar_mail_triage", async () => {
      const resp = await tierRoute({
        agent_id: `avatar.${provider.id}.triage`,
        prompt: buildClassifierPrompt(provider, thread, profile, voice, ctx),
        task_metadata: {
          creativity_required: false,
          customer_facing: false,
          reasoning_depth: "shallow",
          priority: "batch",
        },
        companyId: avatarId,
        outputFormat: "json",
        timeout_ms: 45_000,
      });
      return resp.output.trim();
    });
    const cleaned = text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    const parsed = JSON.parse(cleaned) as MailClassification;
    return {
      classification: parsed.classification ?? "fyi",
      draft: parsed.draft ?? null,
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
      reasoning: parsed.reasoning ?? "no reasoning provided",
      open_question: parsed.open_question ?? null,
    };
  } catch {
    return provider.classifyStub(thread);
  }
}

interface PaperclipHandoff {
  paperclipUrl: string;
  paperclipCompanyId: string;
  conductorAgentId: string;
  agents: Record<string, string>;
}

export interface AvatarApproval {
  id: string;
  avatarId: string;
  type: string;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  decidedAt?: string;
  decisionNote?: string;
  editedPayload?: unknown;
  payload: Record<string, unknown>;
  requestedByAgentId: string;
}

async function writeApproval(avatarId: string, approval: AvatarApproval): Promise<void> {
  const dir = join(avatarDir(avatarId), "approvals");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${approval.id}.json`), JSON.stringify(approval, null, 2), "utf8");
}

async function logActivity(paperclipUrl: string, paperclipCompanyId: string, agentId: string, action: string, details: Record<string, unknown>): Promise<void> {
  try {
    await fetch(`${paperclipUrl}/api/companies/${paperclipCompanyId}/activity`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        actorType: "agent",
        actorId: agentId,
        agentId,
        action,
        entityType: "approval",
        entityId: details.approvalId,
        details,
      }),
    });
  } catch { /* non-fatal */ }
  // Mirror into the Mission Control ledger so the Stream widget surfaces
  // it alongside Paperclip-side events. Best-effort; never throws.
  await mirrorToMissionControl({
    companyId: paperclipCompanyId,
    actorNodeId: agentId,
    action,
    subjectRef: {
      kind: "approval",
      id: typeof details.approvalId === "string" ? details.approvalId : undefined,
      ...details,
    },
    modeContext: "avatar",
  });
}

async function createApproval(
  provider: MailProvider,
  paperclipUrl: string,
  paperclipCompanyId: string,
  agentId: string,
  avatarId: string,
  thread: MailThread,
  classification: MailClassification,
  initialStatus: "pending" | "approved",
): Promise<string> {
  const id = `apv_${randomBytes(8).toString("hex")}`;
  const now = new Date().toISOString();
  const approval: AvatarApproval = {
    id,
    avatarId,
    type: `avatar.${provider.id}.draft_reply`,
    status: initialStatus,
    createdAt: now,
    decidedAt: initialStatus === "approved" ? now : undefined,
    decisionNote: initialStatus === "approved" ? "auto-approved by autonomy preset" : undefined,
    requestedByAgentId: agentId,
    payload: {
      provider: provider.id,
      threadId: thread.threadId,
      subject: thread.subject,
      from: thread.from,
      preview: thread.preview,
      receivedAt: thread.receivedAt,
      draftText: classification.draft,
      classification: classification.classification,
      confidence: classification.confidence,
      reasoning: classification.reasoning,
      openQuestion: classification.open_question ?? null,
    },
  };
  await writeApproval(avatarId, approval);
  await logActivity(paperclipUrl, paperclipCompanyId, agentId, `avatar.${provider.id}.draft_created`, {
    approvalId: id,
    threadId: thread.threadId,
    classification: classification.classification,
    confidence: classification.confidence,
  });
  // Mission Control deliverable ledger entry — invariant: every successful
  // task produces a Deliverable. The runner records what was drafted +
  // hashes it for content-addressing; folder-reveal works via diskPath.
  try {
    await writeDeliverable({
      companyId: paperclipCompanyId,
      instanceId: avatarId,
      modeContext: "avatar",
      taskRefType: "avatar_approval",
      taskRefId: id,
      producedByNodeId: agentId,
      kind: "email_draft",
      title: `Reply: ${thread.subject ?? "(no subject)"}`,
      description: `Draft reply to ${thread.from ?? "unknown sender"}`,
      previewText: classification.draft?.slice(0, 280) ?? "",
      mimeType: "text/plain",
      status: initialStatus === "approved" ? "approved" : "draft",
      templateUsed: `avatar.${provider.id}.draft_reply`,
      payload: {
        threadId: thread.threadId,
        subject: thread.subject,
        from: thread.from,
        draftText: classification.draft,
        classification: classification.classification,
        confidence: classification.confidence,
      },
      taskRef: {
        id,
        title: `Reply to ${thread.from ?? "thread"}`,
        status: initialStatus === "approved" ? "approved" : "awaiting_review",
      },
    });
  } catch {
    // Deliverable write is best-effort; approval flow is the source of truth.
  }
  if (initialStatus === "approved") {
    await logActivity(paperclipUrl, paperclipCompanyId, agentId, "avatar.approval.auto_approved", {
      approvalId: id,
      provider: provider.id,
      classification: classification.classification,
      confidence: classification.confidence,
    });
  }
  return id;
}

/** Run mail triage for a single avatar + provider. */
export async function runMailTriage(
  avatarId: string,
  providerId: string,
  opts: { dryRun?: boolean; skipInference?: boolean } = {},
): Promise<RunResult> {
  const provider = PROVIDER_REGISTRY[providerId];
  if (!provider) {
    return {
      avatarId, providerId, paperclipCompanyId: "", agentId: null,
      processed: 0, drafted: 0, approvalsCreated: 0,
      errors: [{ threadId: "<bootstrap>", message: `unknown provider "${providerId}"` }],
    };
  }
  const dryRun = opts.dryRun ?? true;
  const skipInference = opts.skipInference ?? true;
  const result: RunResult = {
    avatarId, providerId: provider.id, paperclipCompanyId: "", agentId: null,
    processed: 0, drafted: 0, approvalsCreated: 0, errors: [],
  };

  const profile = await readJson<AvatarProfile>(join(avatarDir(avatarId), "profile.json"));
  if (!profile) { result.errors.push({ threadId: "<bootstrap>", message: "profile.json missing" }); return result; }
  const voiceFile = await readJson<VoiceFileShape>(join(avatarDir(avatarId), "voice.json"));
  const voice = voiceFile?.profile ?? null;
  const trust = await readJson<TrustFile>(join(avatarDir(avatarId), "trust.json"));
  const toolsFile = await readJson<{ meta?: Record<string, ToolsMeta> }>(join(avatarDir(avatarId), "tools.json"));
  const providerMeta = toolsFile?.meta?.[provider.id] ?? {};
  const preferences = await readPreferences(avatarId);
  const ctx: OperatorContext = {
    vips: trust?.vips ?? (providerMeta.vips ?? []).map((email) => ({ email })),
    privacy_zones: trust?.privacy_zones ?? providerMeta.privacy_zones ?? [],
    signoff: voiceFile?.signoff ?? providerMeta.signoff ?? null,
    guardrails: voiceFile?.guardrails ?? [],
    autonomy_preset: trust?.autonomy_preset ?? "cautious",
    preferences,
  };

  const handoff = await readJson<PaperclipHandoff>(join(avatarDir(avatarId), "paperclip-handoff.json"));
  if (!handoff) { result.errors.push({ threadId: "<bootstrap>", message: "paperclip-handoff.json missing — finalize first" }); return result; }
  result.paperclipCompanyId = handoff.paperclipCompanyId;
  const agentId = handoff.agents[provider.id] ?? null;
  result.agentId = agentId;
  if (!agentId) { result.errors.push({ threadId: "<bootstrap>", message: `no ${provider.id} sub-agent in mapping — re-finalize after connecting` }); return result; }

  const threads = await provider.fetchUnseen(avatarId, { dryRun });

  for (const thread of threads) {
    result.processed += 1;
    try {
      if (inPrivacyZone(thread, ctx.privacy_zones)) {
        await logActivity(handoff.paperclipUrl, handoff.paperclipCompanyId, agentId, `avatar.${provider.id}.privacy_skip`, {
          approvalId: thread.threadId,
          threadId: thread.threadId,
          subject: thread.subject,
        });
        continue;
      }
      const cls = await classifyOne(avatarId, provider, thread, profile, voice, ctx, { dryRun, skipInference });
      if (cls.classification !== "fyi") result.drafted += 1;
      const status = statusForPreset(ctx.autonomy_preset, cls);
      await createApproval(provider, handoff.paperclipUrl, handoff.paperclipCompanyId, agentId, avatarId, thread, cls, status);
      result.approvalsCreated += 1;
    } catch (e) {
      result.errors.push({ threadId: thread.threadId, message: e instanceof Error ? e.message : String(e) });
    }
  }

  return result;
}
