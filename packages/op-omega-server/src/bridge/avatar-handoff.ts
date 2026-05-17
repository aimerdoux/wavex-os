/** Avatar → Paperclip bridge.
 *
 *  When an Avatar is finalized, mirror it as a Paperclip company at
 *  avatar-os/<avatarId>. The fleet is a kernel `avatar.conductor` agent
 *  plus one per-tool sub-agent for every connected provider. This gives
 *  the Avatar everything Paperclip provides for free: heartbeat runs,
 *  approvals, activity_log, per-agent + fleet pause, costs, agent-skills.
 *
 *  Parallel to packages/op-omega-server/src/bridge/paperclip-handoff.ts
 *  which mirrors the company onboarding (Solo Founder / Hybrid). The
 *  Avatar bridge is intentionally simpler: no scope filter, no kernel
 *  CoS — the conductor IS the kernel.
 *
 *  Idempotent: re-finalize reuses the existing Paperclip companyId +
 *  agentIds via the on-disk mapping at
 *  ~/.wavex-os/instances/default/avatars/<id>/paperclip-handoff.json. */

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { mirrorToMissionControl } from "../mission-control/mirror.js";

// ── Types ────────────────────────────────────────────────────────────────

interface AvatarProfile {
  name: string;
  role: string;
  working_hours: [string, string];
  tz: string;
}

interface AvatarToolConnection {
  provider: string;
  ref: string;
  status: "stub" | "connected";
}

interface AvatarVoiceProfile {
  tone?: string;
  formality?: string;
  structure?: string;
  delegates?: string[];
}

export interface AvatarHandoffReport {
  enabled: boolean;
  paperclipUrl: string | null;
  paperclipCompanyId: string | null;
  conductorAgentId: string | null;
  created: Array<{ provider: string; agentId: string; status: string }>;
  skipped: Array<{ provider: string; reason: string }>;
  errors: Array<{ provider: string; message: string }>;
}

interface PaperclipMapping {
  paperclipUrl: string;
  paperclipCompanyId: string;
  conductorAgentId: string;
  createdAt: string;
  agents: Record<string, string>; // provider → paperclip agentId
}

// ── Disk helpers ─────────────────────────────────────────────────────────

function avatarDir(avatarId: string): string {
  const root = process.env.WAVEX_OS_STATE_DIR ?? join(homedir(), ".wavex-os");
  return join(root, "instances", "default", "avatars", avatarId);
}

function mappingPath(avatarId: string): string {
  return join(avatarDir(avatarId), "paperclip-handoff.json");
}

async function loadMapping(avatarId: string): Promise<PaperclipMapping | null> {
  try {
    const raw = await readFile(mappingPath(avatarId), "utf8");
    return JSON.parse(raw) as PaperclipMapping;
  } catch {
    return null;
  }
}

async function saveMapping(avatarId: string, mapping: PaperclipMapping): Promise<void> {
  await mkdir(avatarDir(avatarId), { recursive: true });
  await writeFile(mappingPath(avatarId), JSON.stringify(mapping, null, 2), "utf8");
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function resolveRepoRoot(): string {
  // src lives at: packages/op-omega-server/src/bridge/avatar-handoff.ts
  const here = fileURLToPath(import.meta.url);
  return resolve(here, "..", "..", "..", "..", "..");
}

/** Read the per-tool SKILL bundle from the wavex agent-templates tree.
 *  Falls back to a minimal placeholder if the file is missing — useful in
 *  early phases where only one or two tool templates exist. */
async function readAvatarBundle(provider: string, profile: AvatarProfile, voice: AvatarVoiceProfile | null): Promise<string> {
  const repoRoot = resolveRepoRoot();
  const templateDir = join(repoRoot, "packages", "onboarding-ui", "public", "agent-templates", "avatar", provider);
  let main = "";
  try {
    const entries = await readdir(templateDir);
    if (entries.includes("SKILL.md")) {
      main = await readFile(join(templateDir, "SKILL.md"), "utf8");
      for (const fname of entries.filter((n) => n.startsWith("SKILL_") && n.endsWith(".md")).sort()) {
        const c = await readFile(join(templateDir, fname), "utf8");
        main += `\n\n---\n\n## Skill: ${fname.replace(/^SKILL_/, "").replace(/\.md$/, "").replace(/_/g, " ").toLowerCase()}\n\n${c}`;
      }
    }
  } catch {
    /* fall through to placeholder */
  }
  if (!main) {
    main = `# avatar.${provider}\n\nPlaceholder. The ${provider} sub-agent template hasn't been authored yet. Once SKILL.md is added at packages/onboarding-ui/public/agent-templates/avatar/${provider}/, the next finalize will pick it up.`;
  }
  // Prepend the avatar's identity + voice context so every sub-agent runs
  // with the right tone, working hours, and timezone.
  const voiceBlock = voice
    ? `## Voice\n- Tone: ${voice.tone ?? "balanced"}\n- Formality: ${voice.formality ?? "casual"}\n- Structure: ${voice.structure ?? "lists"}\n- Delegates first: ${(voice.delegates ?? []).join(", ") || "(unknown)"}\n`
    : "";
  return `# ${profile.name} — ${provider} sub-agent\n\n## Operator\n- Name: ${profile.name}\n- Role: ${profile.role}\n- Working hours: ${profile.working_hours[0]}–${profile.working_hours[1]} ${profile.tz}\n\n${voiceBlock}\n---\n\n${main}`;
}

// ── Paperclip API ────────────────────────────────────────────────────────

async function ensureAvatarCompany(
  paperclipUrl: string,
  avatarId: string,
  profile: AvatarProfile,
  existing: PaperclipMapping | null,
): Promise<{ paperclipCompanyId: string; created: boolean }> {
  if (existing) {
    const r = await fetch(`${paperclipUrl}/api/companies/${existing.paperclipCompanyId}`).catch(() => null);
    if (r && r.ok) return { paperclipCompanyId: existing.paperclipCompanyId, created: false };
  }
  const name = `avatar-os/${avatarId}`;
  // Encode the avatar slug into the description so the Paperclip UI can
  // recover it even if the operator renames the company. Mirrors the
  // wavex-os convention used by paperclip-handoff.ts.
  const description = `Auto-provisioned from WaveX OS Avatar onboarding. ` +
    `Operator: ${profile.name} · ${profile.role}. avatarId=${avatarId}`;
  const r = await fetch(`${paperclipUrl}/api/companies`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, description }),
  });
  if (!r.ok) {
    throw new Error(`Paperclip POST /api/companies failed: ${r.status} ${await r.text()}`);
  }
  const body = await r.json() as { id: string };
  return { paperclipCompanyId: body.id, created: true };
}

interface HirePayload {
  name: string;
  role: string;
  title: string;
  icon: string;
  capabilities: string;
  reportsTo?: string;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  instructionsBundle: { files: Record<string, string> };
  runtimeConfig: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

async function hireAgent(
  paperclipUrl: string,
  paperclipCompanyId: string,
  payload: HirePayload,
): Promise<{ agentId: string; status: string }> {
  const r = await fetch(`${paperclipUrl}/api/companies/${paperclipCompanyId}/agent-hires`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    throw new Error(`agent-hires failed: ${r.status} ${await r.text()}`);
  }
  const body = await r.json() as { agent: { id: string; status: string }; approval?: { id: string; status: string } };
  // Auto-approve any approval record Paperclip creates so the Avatar
  // fleet is live immediately. Mirrors the wavex-os bridge convention.
  if (body.approval && body.approval.status === "pending") {
    await fetch(`${paperclipUrl}/api/approvals/${body.approval.id}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decisionNote: `Auto-approved by WaveX OS Avatar bridge` }),
    }).catch(() => {});
  }
  return { agentId: body.agent.id, status: body.agent.status };
}

// ── Provider catalog ─────────────────────────────────────────────────────

// Paperclip's agent.icon column accepts a closed enum (see
// packages/core/server/src/routes/agents.ts validation). Map each
// Avatar provider to a semantically-close member of that enum.
const PROVIDER_ICONS: Record<string, string> = {
  gmail: "mail",
  outlook: "mail",
  google_calendar: "zap",
  microsoft_calendar: "zap",
  slack: "message-square",
  notion: "file-code",
  linear: "target",
  github: "git-branch",
  twilio_sms: "radar",
  hubspot: "globe",
};

const PROVIDER_TITLES: Record<string, string> = {
  gmail: "Gmail agent",
  outlook: "Outlook agent",
  google_calendar: "Google Calendar agent",
  microsoft_calendar: "Microsoft Calendar agent",
  slack: "Slack agent",
  notion: "Notion agent",
  linear: "Linear agent",
  github: "GitHub agent",
  twilio_sms: "SMS agent",
  hubspot: "HubSpot agent",
};

function adapterConfigForAvatar(): Record<string, unknown> {
  return {
    command: process.env.PAPERCLIP_HANDOFF_WRAPPER ?? "claude",
    model: "claude-sonnet-4-6",
    dangerouslySkipPermissions: true,
    timeoutSec: 600,
    graceSec: 30,
    env: {
      HOME: { type: "plain", value: process.env.HOME ?? "" },
      CLAUDE_CONFIG_DIR: { type: "plain", value: process.env.CLAUDE_CONFIG_DIR ?? `${process.env.HOME}/.claude` },
    },
  };
}

// ── Main entry point ─────────────────────────────────────────────────────

export async function handoffAvatarToPaperclip(avatarId: string): Promise<AvatarHandoffReport> {
  const paperclipUrl = process.env.PAPERCLIP_HANDOFF_URL?.replace(/\/+$/, "") ?? null;
  if (!paperclipUrl) {
    return {
      enabled: false, paperclipUrl: null, paperclipCompanyId: null,
      conductorAgentId: null, created: [], skipped: [], errors: [],
    };
  }

  const dir = avatarDir(avatarId);
  const profile = await readJson<AvatarProfile>(join(dir, "profile.json"));
  if (!profile) {
    return {
      enabled: true, paperclipUrl, paperclipCompanyId: null,
      conductorAgentId: null, created: [], skipped: [],
      errors: [{ provider: "<bootstrap>", message: "avatar profile.json missing" }],
    };
  }
  const tools = (await readJson<{ connected: AvatarToolConnection[] }>(join(dir, "tools.json")))?.connected ?? [];
  const voiceFile = await readJson<{ profile?: AvatarVoiceProfile }>(join(dir, "voice.json"));
  const voice = voiceFile?.profile ?? null;

  const report: AvatarHandoffReport = {
    enabled: true, paperclipUrl, paperclipCompanyId: null,
    conductorAgentId: null, created: [], skipped: [], errors: [],
  };

  const existing = await loadMapping(avatarId);
  let paperclipCompanyId: string;
  try {
    const ensured = await ensureAvatarCompany(paperclipUrl, avatarId, profile, existing);
    paperclipCompanyId = ensured.paperclipCompanyId;
    report.paperclipCompanyId = paperclipCompanyId;
  } catch (e) {
    report.errors.push({ provider: "<bootstrap>", message: e instanceof Error ? e.message : String(e) });
    return report;
  }

  const slotToPaperclipId: Record<string, string> = { ...(existing?.agents ?? {}) };

  // 1) Hire the conductor (kernel). Idempotent via slotToPaperclipId.
  let conductorAgentId: string;
  if (slotToPaperclipId["conductor"]) {
    conductorAgentId = slotToPaperclipId["conductor"];
  } else {
    try {
      const conductorBundle = await readAvatarBundle("conductor", profile, voice);
      const conductor = await hireAgent(paperclipUrl, paperclipCompanyId, {
        name: `${profile.name} (conductor)`,
        role: "general",
        title: "Avatar conductor",
        icon: "sparkles",
        capabilities: `Kernel conductor for ${profile.name}'s Avatar. Routes work to per-tool sub-agents. Identity + voice context are bundled in AGENTS.md.`,
        adapterType: "claude_local",
        adapterConfig: adapterConfigForAvatar(),
        instructionsBundle: { files: { "AGENTS.md": conductorBundle } },
        // Conductor doesn't poll on a fixed cadence — it wakes on demand
        // when a sub-agent needs routing or a chat message arrives.
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } },
        metadata: { avatar_kind: "conductor", avatar_id: avatarId },
      });
      conductorAgentId = conductor.agentId;
      slotToPaperclipId["conductor"] = conductorAgentId;
      // Mirror to MC using the scope-tree-canonical id (prefixed with
      // "agent:") so renderers resolve the actor's display name immediately.
      const conductorNodeId = `agent:${conductorAgentId}`;
      await mirrorToMissionControl({
        companyId: paperclipCompanyId,
        instanceId: avatarId,
        actorNodeId: conductorNodeId,
        action: "wavex.avatar_handoff.conductor_hired",
        modeContext: "avatar",
        subjectRef: {
          kind: "node",
          id: conductorNodeId,
          avatarId,
          paperclipAgentId: conductorAgentId,
        },
      });
    } catch (e) {
      report.errors.push({ provider: "conductor", message: e instanceof Error ? e.message : String(e) });
      // Without a conductor the Avatar is half-built; bail rather than
      // mirror orphan sub-agents.
      await saveMapping(avatarId, {
        paperclipUrl, paperclipCompanyId, conductorAgentId: "",
        createdAt: existing?.createdAt ?? new Date().toISOString(),
        agents: slotToPaperclipId,
      });
      return report;
    }
  }
  report.conductorAgentId = conductorAgentId;

  // 2) Hire one sub-agent per connected tool, idempotent.
  for (const tool of tools) {
    const provider = tool.provider;
    if (slotToPaperclipId[provider]) {
      report.skipped.push({ provider, reason: "already-mapped" });
      continue;
    }
    try {
      const bundle = await readAvatarBundle(provider, profile, voice);
      const hire = await hireAgent(paperclipUrl, paperclipCompanyId, {
        name: `${profile.name} — ${provider}`,
        role: "general",
        title: PROVIDER_TITLES[provider] ?? `${provider} agent`,
        icon: PROVIDER_ICONS[provider] ?? "bot",
        capabilities: `Per-tool sub-agent for ${provider}. Reports to conductor. Skills live in AGENTS.md.`,
        reportsTo: conductorAgentId,
        adapterType: "claude_local",
        adapterConfig: adapterConfigForAvatar(),
        instructionsBundle: { files: { "AGENTS.md": bundle } },
        // Sub-agents are wakeOnDemand by default — explicit triage/poll
        // schedules are added later by the Phase 2 runner.
        runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } },
        metadata: {
          avatar_kind: "sub_agent",
          avatar_id: avatarId,
          provider,
          credential_ref: tool.ref,
          credential_status: tool.status,
        },
      });
      slotToPaperclipId[provider] = hire.agentId;
      report.created.push({ provider, agentId: hire.agentId, status: hire.status });
      const subagentNodeId = `agent:${hire.agentId}`;
      const conductorNodeIdForChild = `agent:${conductorAgentId}`;
      await mirrorToMissionControl({
        companyId: paperclipCompanyId,
        instanceId: avatarId,
        actorNodeId: subagentNodeId,
        action: "wavex.avatar_handoff.subagent_hired",
        modeContext: "avatar",
        subjectRef: {
          kind: "node",
          id: subagentNodeId,
          toNodeId: conductorNodeIdForChild,
          provider,
          paperclipAgentId: hire.agentId,
        },
      });
    } catch (e) {
      report.errors.push({ provider, message: e instanceof Error ? e.message : String(e) });
    }
  }

  await saveMapping(avatarId, {
    paperclipUrl,
    paperclipCompanyId,
    conductorAgentId,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    agents: slotToPaperclipId,
  });

  return report;
}
