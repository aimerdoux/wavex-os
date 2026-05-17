/** Calendar-triage runner — Phase 6.
 *
 *  Loads pending calendar invites (Google or Microsoft) via the
 *  provider abstraction, runs each through a T2 recommender, and
 *  writes one approval per invite. The approval payload carries the
 *  suggested response (accept / decline / propose-time) plus a draft
 *  message; the operator approves and the runner could fire the RSVP
 *  via Composio (deferred — same gate as the mail send path).
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { route as tierRoute } from "@op-omega/plugin-tier-router";
import { withTokenAccounting } from "../../lib/token-accounting.js";
import { readPreferences } from "../memory/preferences.js";
import { googleCalendarProvider } from "./calendar/google-provider.js";
import { microsoftCalendarProvider } from "./calendar/microsoft-provider.js";
import type { CalendarEvent, CalendarProvider, CalendarRecommendation } from "./calendar/types.js";
import type { AvatarApproval } from "./mail-triage.js";
import { mirrorToMissionControl } from "../../mission-control/mirror.js";
import { writeDeliverable } from "../../mission-control/deliverables.js";

interface RunResult {
  avatarId: string;
  providerId: string;
  paperclipCompanyId: string;
  agentId: string | null;
  processed: number;
  approvalsCreated: number;
  errors: Array<{ eventId: string; message: string }>;
}

interface AvatarProfile {
  name: string;
  role: string;
  working_hours: [string, string];
  tz: string;
}

interface TrustFile {
  autonomy_preset?: "cautious" | "balanced" | "aggressive";
  vips?: Array<{ email: string; label?: string }>;
  privacy_zones?: string[];
}

const PROVIDER_REGISTRY: Record<string, CalendarProvider> = {
  google_calendar: googleCalendarProvider,
  microsoft_calendar: microsoftCalendarProvider,
};

function avatarDir(id: string): string {
  const root = process.env.WAVEX_OS_STATE_DIR ?? join(homedir(), ".wavex-os");
  return join(root, "instances", "default", "avatars", id);
}

async function readJson<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; } catch { return null; }
}

function eventInsideWorkingHours(event: CalendarEvent, profile: AvatarProfile): boolean {
  const start = new Date(event.start);
  const [sH, sM] = profile.working_hours[0].split(":").map(Number);
  const [eH, eM] = profile.working_hours[1].split(":").map(Number);
  // Compare on the operator's tz instant — naive but fine for fixture work.
  const startMin = start.getUTCHours() * 60 + start.getUTCMinutes();
  return startMin >= (sH * 60 + sM) && startMin <= (eH * 60 + eM);
}

function buildRecommenderPrompt(provider: CalendarProvider, event: CalendarEvent, profile: AvatarProfile, trust: TrustFile | null, preferences: Array<{ rule: string }>): string {
  const vips = (trust?.vips ?? []).map((v) => `- ${v.email}${v.label ? ` (${v.label})` : ""}`).join("\n");
  const prefBlock = preferences.length > 0
    ? `Operator preferences (apply as constraints):\n${preferences.map((p) => `- ${p.rule}`).join("\n")}\n\n`
    : "";
  return `You triage incoming ${provider.label} invites for ${profile.name} (${profile.role}). Working hours ${profile.working_hours[0]}–${profile.working_hours[1]} ${profile.tz}.

${vips ? `VIPs (favor accept):\n${vips}\n\n` : ""}${prefBlock}Invite:
- Summary: ${event.summary}
- Organizer: ${event.organizer.name} <${event.organizer.email}>
- Start: ${event.start}
- End: ${event.end}
- Attendees: ${event.attendees.join(", ") || "(none listed)"}
${event.body ? `- Body: ${event.body}` : ""}

Decide ONE of:
- "accept": inside hours, no conflict, organizer is VIP/internal, agenda is clear.
- "decline": outside hours, hard conflict, organizer flagged, vendor cold demo, or recurring slot the operator usually skips.
- "propose-time": soft conflict / "any time this week" / outside hours but worth meeting.

Return JSON only:
{
  "suggested": "accept" | "decline" | "propose-time",
  "proposed_times": ["ISO datetime", ...] | null,
  "draft_message": "<message to send with the RSVP, or null>",
  "confidence": 0.0-1.0,
  "reasoning": "<one short sentence>"
}`;
}

async function recommendOne(
  avatarId: string,
  provider: CalendarProvider,
  event: CalendarEvent,
  profile: AvatarProfile,
  trust: TrustFile | null,
  preferences: Array<{ rule: string }>,
  opts: { dryRun: boolean; skipInference: boolean },
): Promise<CalendarRecommendation> {
  if (opts.dryRun && opts.skipInference) return provider.recommendStub(event);
  try {
    const text = await withTokenAccounting(avatarId, "avatar_calendar_triage", async () => {
      const resp = await tierRoute({
        agent_id: `avatar.${provider.id}.triage`,
        prompt: buildRecommenderPrompt(provider, event, profile, trust, preferences),
        task_metadata: {
          creativity_required: false,
          customer_facing: false,
          reasoning_depth: "shallow",
          priority: "batch",
        },
        companyId: avatarId,
        outputFormat: "json",
        timeout_ms: 30_000,
      });
      return resp.output.trim();
    });
    const cleaned = text.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    const parsed = JSON.parse(cleaned) as CalendarRecommendation;
    return {
      suggested: parsed.suggested ?? "decline",
      proposed_times: parsed.proposed_times ?? null,
      draft_message: parsed.draft_message ?? null,
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
      reasoning: parsed.reasoning ?? "no reasoning provided",
    };
  } catch {
    return provider.recommendStub(event);
  }
}

interface PaperclipHandoff {
  paperclipUrl: string;
  paperclipCompanyId: string;
  conductorAgentId: string;
  agents: Record<string, string>;
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

export async function runCalendarTriage(
  avatarId: string,
  providerId: string,
  opts: { dryRun?: boolean; skipInference?: boolean } = {},
): Promise<RunResult> {
  const provider = PROVIDER_REGISTRY[providerId];
  if (!provider) {
    return {
      avatarId, providerId, paperclipCompanyId: "", agentId: null,
      processed: 0, approvalsCreated: 0,
      errors: [{ eventId: "<bootstrap>", message: `unknown provider "${providerId}"` }],
    };
  }
  const dryRun = opts.dryRun ?? true;
  const skipInference = opts.skipInference ?? true;
  const result: RunResult = {
    avatarId, providerId: provider.id, paperclipCompanyId: "", agentId: null,
    processed: 0, approvalsCreated: 0, errors: [],
  };

  const profile = await readJson<AvatarProfile>(join(avatarDir(avatarId), "profile.json"));
  if (!profile) { result.errors.push({ eventId: "<bootstrap>", message: "profile.json missing" }); return result; }
  const trust = await readJson<TrustFile>(join(avatarDir(avatarId), "trust.json"));
  const preferences = await readPreferences(avatarId);

  const handoff = await readJson<PaperclipHandoff>(join(avatarDir(avatarId), "paperclip-handoff.json"));
  if (!handoff) { result.errors.push({ eventId: "<bootstrap>", message: "paperclip-handoff.json missing — finalize first" }); return result; }
  result.paperclipCompanyId = handoff.paperclipCompanyId;
  const agentId = handoff.agents[provider.id] ?? null;
  result.agentId = agentId;
  if (!agentId) { result.errors.push({ eventId: "<bootstrap>", message: `no ${provider.id} sub-agent in mapping` }); return result; }

  const events = await provider.fetchPendingInvites(avatarId, { dryRun });

  for (const event of events) {
    result.processed += 1;
    try {
      // Annotate with the runner's working-hours signal so the operator sees
      // the basis of the recommendation on the approval card.
      const insideHours = eventInsideWorkingHours(event, profile);
      const rec = await recommendOne(avatarId, provider, event, profile, trust, preferences, { dryRun, skipInference });
      const id = `apv_${randomBytes(8).toString("hex")}`;
      const now = new Date().toISOString();
      const approval: AvatarApproval = {
        id,
        avatarId,
        type: `avatar.${provider.id}.invite_response`,
        status: "pending",
        createdAt: now,
        requestedByAgentId: agentId,
        payload: {
          provider: provider.id,
          eventId: event.eventId,
          summary: event.summary,
          organizer: event.organizer,
          start: event.start,
          end: event.end,
          inside_working_hours: insideHours,
          suggested: rec.suggested,
          proposed_times: rec.proposed_times,
          draft_message: rec.draft_message,
          confidence: rec.confidence,
          reasoning: rec.reasoning,
        },
      };
      await writeApproval(avatarId, approval);
      await logActivity(handoff.paperclipUrl, handoff.paperclipCompanyId, agentId, `avatar.${provider.id}.invite_classified`, {
        approvalId: id,
        eventId: event.eventId,
        suggested: rec.suggested,
        confidence: rec.confidence,
      });
      try {
        await writeDeliverable({
          companyId: handoff.paperclipCompanyId,
          instanceId: avatarId,
          modeContext: "avatar",
          taskRefType: "avatar_approval",
          taskRefId: id,
          producedByNodeId: agentId,
          kind: "meeting_artifact",
          title: `Invite response: ${event.summary ?? event.eventId}`,
          description: `Recommended: ${rec.suggested}`,
          previewText: rec.draft_message?.slice(0, 280) ?? rec.reasoning?.slice(0, 280),
          mimeType: "text/plain",
          status: "draft",
          templateUsed: `avatar.${provider.id}.invite_response`,
          payload: {
            eventId: event.eventId,
            summary: event.summary,
            organizer: event.organizer,
            suggested: rec.suggested,
            proposed_times: rec.proposed_times,
            draft_message: rec.draft_message,
            confidence: rec.confidence,
          },
          taskRef: {
            id,
            title: `Respond to ${event.organizer ?? "invite"}`,
            status: "awaiting_review",
          },
        });
      } catch {
        // Best-effort.
      }
      result.approvalsCreated += 1;
    } catch (e) {
      result.errors.push({ eventId: event.eventId, message: e instanceof Error ? e.message : String(e) });
    }
  }

  return result;
}
