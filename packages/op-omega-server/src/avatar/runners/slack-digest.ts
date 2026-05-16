/** Slack mention-digest runner — Phase 6 (read-only).
 *
 *  Pulls recent @-mentions of the operator across connected Slack
 *  channels and surfaces each as an approval with an importance
 *  classification + deep link. The operator clicks through to Slack
 *  itself to reply — this runner deliberately does NOT draft Slack
 *  messages. Slack tone is more personal than email; reply autonomy
 *  is gated until digest-only proves trustworthy in production.
 *
 *  The approval type is `avatar.slack.mention_digest` (vs the mail
 *  runner's `*.draft_reply`) so the dashboard can distinguish them
 *  and surface a "View in Slack" CTA instead of an editable draft.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import { route as tierRoute } from "@op-omega/plugin-tier-router";
import { withTokenAccounting } from "../../lib/token-accounting.js";
import { readPreferences } from "../memory/preferences.js";
import type { AvatarApproval } from "./mail-triage.js";
import { mirrorToMissionControl } from "../../mission-control/mirror.js";

interface SlackMention {
  channel: string;          // #channel-name
  channelId: string;
  author: { name: string; email?: string };
  ts: string;               // ISO datetime
  text: string;
  permalink: string;        // slack:// or https:// deep link
  threadTs?: string;
}

interface SlackClassification {
  importance: "urgent" | "info" | "fyi";
  reasoning: string;
  confidence: number;
}

interface RunResult {
  avatarId: string;
  paperclipCompanyId: string;
  agentId: string | null;
  processed: number;
  approvalsCreated: number;
  errors: Array<{ ts: string; message: string }>;
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

interface PaperclipHandoff {
  paperclipUrl: string;
  paperclipCompanyId: string;
  conductorAgentId: string;
  agents: Record<string, string>;
}

function avatarDir(id: string): string {
  const root = process.env.WAVEX_OS_STATE_DIR ?? join(homedir(), ".wavex-os");
  return join(root, "instances", "default", "avatars", id);
}

async function readJson<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; } catch { return null; }
}

function fixtures(seed: string): SlackMention[] {
  const now = new Date();
  const isoBack = (deltaMs: number) => new Date(now.getTime() - deltaMs).toISOString();
  const tag = seed.slice(-6);
  return [
    {
      channel: "#eng-incidents",
      channelId: `C-${tag}-A`,
      author: { name: "Riley K", email: "riley@yourco.example" },
      ts: isoBack(20 * 60 * 1000),
      text: "@operator we hit a Stripe webhook backlog at 14:02 UTC — paged oncall, but loop you in?",
      permalink: `https://yourco.slack.example/archives/C-${tag}-A/p123${tag}1`,
    },
    {
      channel: "#partnerships",
      channelId: `C-${tag}-B`,
      author: { name: "Sam Owens", email: "sam@yourco.example" },
      ts: isoBack(3 * 60 * 60 * 1000),
      text: "@operator quick one — Pat asked if we want to co-market the Q3 launch. Send a thumbs up or skip and I'll handle it.",
      permalink: `https://yourco.slack.example/archives/C-${tag}-B/p456${tag}2`,
    },
    {
      channel: "#general",
      channelId: `C-${tag}-C`,
      author: { name: "People Ops", email: "people@yourco.example" },
      ts: isoBack(6 * 60 * 60 * 1000),
      text: "Reminder: holiday calendar update lands Monday. @operator @everyone please mark your PTO.",
      permalink: `https://yourco.slack.example/archives/C-${tag}-C/p789${tag}3`,
    },
  ];
}

const STUB_CLASSIFICATIONS: Record<string, SlackClassification> = {
  "1": { importance: "urgent", confidence: 0.88, reasoning: "Active incident, oncall paged, direct loop-in." },
  "2": { importance: "info", confidence: 0.76, reasoning: "Decision required from operator, no hard deadline; partner-relations." },
  "3": { importance: "fyi", confidence: 0.93, reasoning: "Mass @everyone reminder, no operator-specific action." },
};

function classifyStub(mention: SlackMention): SlackClassification {
  const last = mention.permalink.slice(-1);
  return STUB_CLASSIFICATIONS[last] ?? STUB_CLASSIFICATIONS["1"];
}

function buildClassifierPrompt(mention: SlackMention, profile: AvatarProfile, trust: TrustFile | null, preferences: Array<{ rule: string }>): string {
  const vips = (trust?.vips ?? []).map((v) => `- ${v.email}${v.label ? ` (${v.label})` : ""}`).join("\n");
  const prefBlock = preferences.length > 0
    ? `Operator preferences (apply as constraints):\n${preferences.map((p) => `- ${p.rule}`).join("\n")}\n\n`
    : "";
  return `You triage Slack @-mentions for ${profile.name} (${profile.role}). You DO NOT draft replies — the operator replies in Slack directly. Your job is to classify how soon they need to look.

${vips ? `VIPs (favor urgent if matching):\n${vips}\n\n` : ""}${prefBlock}Mention:
- Channel: ${mention.channel}
- From: ${mention.author.name}${mention.author.email ? ` <${mention.author.email}>` : ""}
- Text: ${mention.text}

Classify as:
- "urgent": active incident, time-sensitive ask, VIP author, direct decision requested with deadline.
- "info": decision wanted but no deadline, FYI from a known internal partner, action loosely implied.
- "fyi": mass @-mention, @everyone / @channel, reminder, no operator-specific action.

Return JSON only:
{
  "importance": "urgent" | "info" | "fyi",
  "confidence": 0.0-1.0,
  "reasoning": "<one short sentence>"
}`;
}

async function classifyOne(
  avatarId: string,
  mention: SlackMention,
  profile: AvatarProfile,
  trust: TrustFile | null,
  preferences: Array<{ rule: string }>,
  opts: { dryRun: boolean; skipInference: boolean },
): Promise<SlackClassification> {
  if (opts.dryRun && opts.skipInference) return classifyStub(mention);
  try {
    const text = await withTokenAccounting(avatarId, "avatar_slack_digest", async () => {
      const resp = await tierRoute({
        agent_id: "avatar.slack.digest",
        prompt: buildClassifierPrompt(mention, profile, trust, preferences),
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
    const parsed = JSON.parse(cleaned) as SlackClassification;
    return {
      importance: parsed.importance ?? "fyi",
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
      reasoning: parsed.reasoning ?? "no reasoning provided",
    };
  } catch {
    return classifyStub(mention);
  }
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

export async function runSlackDigest(
  avatarId: string,
  opts: { dryRun?: boolean; skipInference?: boolean } = {},
): Promise<RunResult> {
  const dryRun = opts.dryRun ?? true;
  const skipInference = opts.skipInference ?? true;
  const result: RunResult = {
    avatarId, paperclipCompanyId: "", agentId: null,
    processed: 0, approvalsCreated: 0, errors: [],
  };

  const profile = await readJson<AvatarProfile>(join(avatarDir(avatarId), "profile.json"));
  if (!profile) { result.errors.push({ ts: "<bootstrap>", message: "profile.json missing" }); return result; }
  const trust = await readJson<TrustFile>(join(avatarDir(avatarId), "trust.json"));
  const preferences = await readPreferences(avatarId);

  const handoff = await readJson<PaperclipHandoff>(join(avatarDir(avatarId), "paperclip-handoff.json"));
  if (!handoff) { result.errors.push({ ts: "<bootstrap>", message: "paperclip-handoff.json missing — finalize first" }); return result; }
  result.paperclipCompanyId = handoff.paperclipCompanyId;
  const agentId = handoff.agents["slack"] ?? null;
  result.agentId = agentId;
  if (!agentId) { result.errors.push({ ts: "<bootstrap>", message: "no slack sub-agent in mapping" }); return result; }

  // Real Slack pull lands together with Composio OAuth in slice 3.
  const mentions = dryRun ? fixtures(avatarId) : [];

  for (const mention of mentions) {
    result.processed += 1;
    try {
      const cls = await classifyOne(avatarId, mention, profile, trust, preferences, { dryRun, skipInference });
      const id = `apv_${randomBytes(8).toString("hex")}`;
      const now = new Date().toISOString();
      const approval: AvatarApproval = {
        id,
        avatarId,
        type: "avatar.slack.mention_digest",
        status: "pending",
        createdAt: now,
        requestedByAgentId: agentId,
        payload: {
          provider: "slack",
          channel: mention.channel,
          channelId: mention.channelId,
          author: mention.author,
          ts: mention.ts,
          text: mention.text,
          permalink: mention.permalink,
          importance: cls.importance,
          confidence: cls.confidence,
          reasoning: cls.reasoning,
        },
      };
      await writeApproval(avatarId, approval);
      await logActivity(handoff.paperclipUrl, handoff.paperclipCompanyId, agentId, "avatar.slack.mention_surfaced", {
        approvalId: id,
        channel: mention.channel,
        importance: cls.importance,
        confidence: cls.confidence,
      });
      result.approvalsCreated += 1;
    } catch (e) {
      result.errors.push({ ts: mention.ts, message: e instanceof Error ? e.message : String(e) });
    }
  }

  return result;
}
