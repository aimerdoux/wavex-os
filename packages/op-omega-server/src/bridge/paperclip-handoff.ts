/** Paperclip handoff bridge (Slice 1 — Phase D opt-in handoff).
 *
 *  After bridgeAgents writes the swarm topology to the wavex DB, optionally
 *  hand off the same agents to a running Paperclip instance so they get a
 *  real runtime (heartbeats, claude CLI execution, KPI snapshots, fleet
 *  observation). Opt-in via PAPERCLIP_HANDOFF_URL env var; when unset, this
 *  is a no-op and bridgeAgents-only is the contract.
 *
 *  Idempotent: a per-wavex-company mapping is persisted to
 *  ~/.wavex-os/instances/<wavexCompanyId>/paperclip-handoff.json so re-runs
 *  reuse the same Paperclip companyId + agentIds. Hires that already exist
 *  on the Paperclip side are skipped (name+role match).
 *
 *  v1 scope:
 *    - Creates a Paperclip company on first activate of a wavex company
 *    - Hires the C-Suite + CEO Orchestrator (ceo, cpo, cmo, cro, cfo, cdo, coo)
 *    - Skips L·IV+ specialists for now (mapping to Paperclip's constrained
 *      role enum is lossy for sub-roles; that's a v2 mapping problem)
 *    - Each hire's instructionsBundle.files["AGENTS.md"] is assembled from the
 *      role's per-template SKILL.md + concatenated SKILL_*.md files at
 *      packages/onboarding-ui/public/agent-templates/<role>/
 *    - Auto-approves the hire if the Paperclip server returns an approval
 *      record (Paperclip 0.3.x board flow on local_trusted)
 */

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { CompanyManifest } from "@op-omega/plugin-onboarding";
import { readInferenceAllocation } from "../routes/inference-allocation.js";
import { mirrorToMissionControl } from "../mission-control/mirror.js";

interface SwarmAgentEntry {
  template_id?: string | null;
  reports_to?: string | null;
  display_name?: string;
  tier?: number;
  adapter?: string;
  /** Company-specific customization line written by the swarm phase —
   *  e.g. "Drives Linear's product roadmap across performance + AI agent
   *  integrations". Injected into each agent's CONTEXT.md so the agent
   *  knows what company it's working for, not just its generic role. */
  skill_overlay?: string;
  department?: string;
  level?: string;
  budget_monthly_usd?: number;
  heartbeat?: string;
  owned_kpi_ids?: string[];
}

/** Shared company-context block — same for every agent in the fleet.
 *  Built once per handoff from the finalized manifest's pillar_1 + goal. */
function buildCompanyContextBlock(manifest: unknown): string {
  const m = manifest as {
    pillar_responses?: { pillar_1?: Record<string, unknown> };
    goal?: { kpiId?: string; current?: number; target?: number; days?: number };
    meta_goal?: string;
    imprint_summary?: string;
  };
  const p1 = m.pillar_responses?.pillar_1 ?? {};
  const goal = m.goal ?? {};
  const lines: string[] = [
    "# Company Context",
    "",
    "_This file is injected by the wavex-os handoff bridge. It tells you which",
    "company you work for and what the fleet is driving toward. Your generic",
    "role skills are in AGENTS.md — this is the company-specific overlay._",
    "",
    `**Company:** ${(p1.org_name as string) ?? "(unnamed)"}`,
    "",
    `**What the company does:** ${(p1.company_context as string) ?? "n/a"}`,
    "",
    `**Ideal customer:** ${(p1.ideal_customer_profile as string) ?? "n/a"}`,
    "",
    `**Differentiator (hypothesis):** ${(p1.differentiator_hypothesis as string) ?? "n/a"}`,
    "",
    `**Primary friction (hypothesis):** ${(p1.primary_friction_hypothesis as string) ?? "n/a"}`,
    "",
    `**Competitive position:** ${(p1.competitive_position as string) ?? "n/a"}`,
    "",
    "## The goal the whole fleet is driving",
    "",
    goal.kpiId
      ? `**${goal.kpiId}**: ${goal.current ?? "?"} → ${goal.target ?? "?"} over ${goal.days ?? "?"} days`
      : "_No primary KPI set on the manifest._",
  ];
  if (m.meta_goal) {
    lines.push("", `**Meta goal:** ${m.meta_goal}`);
  }
  if (m.imprint_summary) {
    lines.push("", "## Onboarding imprint", "", m.imprint_summary);
  }
  return lines.join("\n");
}

/** Per-agent WORKFLOW.md — the agent's on_fire heartbeat loop, escalation
 *  path, and cadence, lifted straight from manifest.workflow_manifest.
 *
 *  Before this, the workflow manifest was loaded by ignition but only the
 *  FIRST on_fire task was ever surfaced (as a single seed issue). The agent
 *  itself never saw its own workflow — it heartbeated blind. Now every wake
 *  the agent has its loop in front of it. */
function buildAgentWorkflowMd(workflowManifest: unknown, slot: string): string | null {
  const wm = workflowManifest as {
    agent_workflows?: Record<string, {
      heartbeat?: string;
      on_fire?: Array<{
        task?: string; tier?: string; flow_type?: string;
        input?: string; expected_output?: string;
      }>;
      escalation?: Array<{ on?: string; to?: string }>;
    }>;
  };
  const aw = wm?.agent_workflows?.[slot];
  if (!aw) return null;

  const lines: string[] = [
    "# Your Workflow",
    "",
    "_Injected by the wavex-os handoff bridge from the finalized workflow",
    "manifest. This is the loop you run every heartbeat — read it top to",
    "bottom, each step's `input` is the prior step's `expected_output`._",
    "",
  ];
  if (aw.heartbeat) lines.push(`**Cadence:** every ${aw.heartbeat}`, "");

  const onFire = aw.on_fire ?? [];
  if (onFire.length > 0) {
    lines.push("## On every heartbeat, in order:", "");
    onFire.forEach((step, i) => {
      const parts = [`${i + 1}. **${step.task ?? "(unnamed step)"}**`];
      const meta: string[] = [];
      if (step.tier) meta.push(`tier ${step.tier}`);
      if (step.flow_type) meta.push(step.flow_type);
      if (step.input) meta.push(`in: ${step.input}`);
      if (step.expected_output) meta.push(`out: ${step.expected_output}`);
      if (meta.length) parts.push(`   _(${meta.join(" · ")})_`);
      lines.push(parts.join("\n"));
    });
    lines.push("");
  }

  const esc = aw.escalation ?? [];
  if (esc.length > 0) {
    lines.push("## Escalation", "");
    for (const e of esc) {
      lines.push(`- When \`${e.on ?? "?"}\` → escalate to \`${e.to ?? "?"}\``);
    }
    lines.push("");
  }

  if (onFire.length === 0 && esc.length === 0) return null;
  return lines.join("\n");
}

/** Per-agent CONTEXT.md = shared company block + this agent's customization
 *  (skill_overlay, department/level, who it reports to, owned KPIs). */
function buildAgentContextMd(
  companyBlock: string,
  slot: string,
  entry: SwarmAgentEntry,
): string {
  const lines: string[] = [companyBlock, "", "---", "", `## Your role in this fleet`, ""];
  lines.push(`**Slot:** \`${slot}\``);
  if (entry.department) lines.push(`**Department:** ${entry.department}`);
  if (entry.level) lines.push(`**Level:** ${entry.level}`);
  if (entry.reports_to) lines.push(`**Reports to:** \`${entry.reports_to}\``);
  if (typeof entry.budget_monthly_usd === "number") {
    lines.push(`**Monthly inference budget:** $${entry.budget_monthly_usd}`);
  }
  if (entry.owned_kpi_ids && entry.owned_kpi_ids.length > 0) {
    lines.push(`**KPIs you own:** ${entry.owned_kpi_ids.join(", ")}`);
  }
  if (entry.skill_overlay) {
    lines.push(
      "",
      "## Your company-specific mandate",
      "",
      entry.skill_overlay,
      "",
      "_This mandate was written for THIS company during onboarding. When it",
      "conflicts with your generic role skills, the mandate wins — it reflects",
      "what the operator actually hired this fleet to do._",
    );
  }
  return lines.join("\n");
}

export interface HandoffReport {
  enabled: boolean;
  paperclipUrl: string | null;
  paperclipCompanyId: string | null;
  created: Array<{ slot: string; agentId: string; status: string }>;
  skipped: Array<{ slot: string; reason: string }>;
  errors: Array<{ slot: string; message: string }>;
}

const PAPERCLIP_ROLE_ENUM = new Set([
  "ceo", "cto", "cmo", "cfo", "security", "engineer",
  "designer", "pm", "qa", "devops", "researcher", "general",
]);

/** Project the op-omega slot taxonomy onto Paperclip's role enum.
 *  This loses fidelity (Paperclip has no cro/cdo/coo/cpo in its enum), but
 *  the agent's actual behavior comes from instructionsBundle, not the role
 *  label. We pick the closest enum value + record the original in metadata. */
function mapRoleToPaperclipEnum(slot: string): { role: string; orig: string } {
  // Special case: kernel CoS sits under ceo.* so the head-based logic
  // below would label it as "ceo" (same role as the actual CEO). Paperclip
  // has no chief-of-staff enum value, so fall back to "general" with the
  // CoS-flavored capabilities surfacing via the AGENTS.md bundle.
  if (slot === "ceo.chief-of-staff") return { role: "general", orig: "chief_of_staff" };
  const head = slot.split(".")[0];
  if (PAPERCLIP_ROLE_ENUM.has(head)) return { role: head, orig: head };
  // Map non-enum wavex roles to closest equivalents
  const map: Record<string, string> = {
    cpo: "pm",          // Chief Product Officer → PM enum
    cro: "general",     // Chief Revenue Officer → general (sales-shaped, no enum slot)
    cdo: "researcher",  // Chief Data Officer → researcher (data-shaped)
    coo: "devops",      // Chief Operating Officer → devops (operations-shaped)
  };
  const role = map[head] ?? "general";
  return { role, orig: head };
}

const ICON_BY_HEAD: Record<string, string> = {
  ceo: "crown",
  cto: "cpu",
  cmo: "rocket",
  cro: "target",
  cfo: "database",
  cdo: "radar",
  coo: "cog",
  cpo: "puzzle",
};

function iconForSlot(slot: string): string {
  // CoS sits at ceo.* but isn't the actual CEO — give it the "eye" icon
  // to reflect its observer role per MINIMAL_INCEPTION.md ("one acts; one
  // observes"). Without this special case, it'd inherit "crown" from CEO.
  if (slot === "ceo.chief-of-staff") return "eye";
  return ICON_BY_HEAD[slot.split(".")[0]] ?? "bot";
}

function humanNameForSlot(slot: string, displayName?: string): string {
  if (displayName) return displayName;
  // CoS would otherwise render as "CEO / CHIEF-OF-STAFF" — visually a second
  // CEO. Give it a clean identity so Paperclip's name + urlKey (chief-of-staff)
  // surface a distinct node.
  if (slot === "ceo.chief-of-staff") return "Chief of Staff";
  const parts = slot.split(".").map(s => s.toUpperCase());
  return parts.join(" / ");
}

/** Stable slot → 0..N-1 bucket. Used to stagger heartbeat first-wake so a
 *  35-agent fleet doesn't thundering-herd the operator's Claude Max window
 *  on the same scheduler tick. */
function slotHashBucket(slot: string, buckets: number): number {
  let h = 0;
  for (let i = 0; i < slot.length; i++) h = (h * 31 + slot.charCodeAt(i)) >>> 0;
  return h % buckets;
}

/** Heartbeat runtimeConfig for a freshly-hired agent.
 *
 *  Demo-day finding (2026-05-14): every agent shipped `enabled: false`, so
 *  the fleet landed in the graph but never woke — no inference, no work.
 *  The whole WaveX product is the autonomous fleet, so heartbeats MUST be
 *  on. Cost is bounded by the Max-allocation slider, not by keeping the
 *  fleet inert.
 *
 *  intervalSec = (base / swarmShare) + per-slot jitter:
 *    - swarmShare is the swarm's slice of the operator's Claude Max window
 *      (0.05..1.0), from ~/.wavex-os/state/inference-allocation.json. At
 *      100% the swarm runs at `base`; at 50% intervals double (agents wake
 *      half as often → consume ~half the window); at 25% they quadruple.
 *      That's the enforcement teeth behind the allocation slider.
 *    - the jitter spreads ~35 agents across the interval so the first wake
 *      (and every wake after) is staggered, without needing a per-agent
 *      cron field that Paperclip's heartbeat policy doesn't expose.
 *
 *  Env overrides:
 *    PAPERCLIP_HANDOFF_HEARTBEAT_ENABLED   "false" to ship inert (old behavior)
 *    PAPERCLIP_HANDOFF_HEARTBEAT_BASE_SEC  base interval, default 1800 (30 min)
 *    PAPERCLIP_HANDOFF_HEARTBEAT_JITTER_SEC per-bucket step, default 45
 */
function heartbeatConfigForSlot(slot: string, swarmPct: number): {
  enabled: boolean;
  intervalSec: number;
  wakeOnDemand: boolean;
} {
  const enabled = process.env.PAPERCLIP_HANDOFF_HEARTBEAT_ENABLED !== "false";
  const baseSec = Number(process.env.PAPERCLIP_HANDOFF_HEARTBEAT_BASE_SEC ?? 1800);
  const jitterStep = Number(process.env.PAPERCLIP_HANDOFF_HEARTBEAT_JITTER_SEC ?? 45);
  // Clamp the swarm share to 5%..100% — a 0% swarm would be ÷0 and a fleet
  // that never wakes is just the bug we're fixing. The operator can still
  // pause the fleet via Paperclip if they truly want it silent.
  const swarmShare = Math.max(0.05, Math.min(1, swarmPct / 100));
  // 40 buckets ≈ comfortably more than the 35-slot kernel, so collisions
  // are rare and the spread is ~0..30 min on the default jitter step.
  const bucket = slotHashBucket(slot, 40);
  const scaledBase = Math.round(baseSec / swarmShare);
  return {
    enabled,
    intervalSec: enabled ? scaledBase + bucket * jitterStep : 0,
    wakeOnDemand: true,
  };
}

/** Assemble AGENTS.md content from the vendored role template directory.
 *  Concatenates SKILL.md (entry) + all SKILL_*.md siblings. */
async function readAgentBundle(role: string, repoRoot: string): Promise<string | null> {
  const dir = join(repoRoot, "packages", "onboarding-ui", "public", "agent-templates", role);
  try {
    const entries = await readdir(dir);
    const main = entries.includes("SKILL.md") ? await readFile(join(dir, "SKILL.md"), "utf8") : "";
    const skills = entries
      .filter(n => n.startsWith("SKILL_") && n.endsWith(".md"))
      .sort();
    const parts: string[] = [];
    if (main) parts.push(main);
    for (const fname of skills) {
      try {
        const c = await readFile(join(dir, fname), "utf8");
        parts.push(`\n\n---\n\n## Skill: ${fname.replace(/^SKILL_/, "").replace(/\.md$/, "").replace(/_/g, " ").toLowerCase()}\n\n${c}`);
      } catch {
        // ignore unreadable side files
      }
    }
    return parts.length > 0 ? parts.join("") : null;
  } catch {
    return null;
  }
}

/** Build the CEO AGENTS.md as a manifest-driven, tenant-neutral operating
 *  contract. Replaces the frozen `agent-templates/ceo/SKILL.md` +
 *  `SKILL_KPI_OWNERSHIP.md` (which were hardcoded to the WaveX-Experiences
 *  dogfood company — Bookings GMV / public.bookings / etc.) with a goal
 *  sentence parameterized from `manifest.goal.{kpiId, current, target, days}`.
 *
 *  Keeps a tight set of frozen role-mechanic siblings (heartbeat discipline,
 *  post-delivery review, board escalation) and drops the rest to land the
 *  rendered bundle at ~15KB — the prior 67KB bundle was the cause of an
 *  autocompact thrash that killed real heartbeat runs.
 *
 *  Frozen-path-safe: only READS from agent-templates/ceo/; never writes. */
async function buildCeoBundle(
  manifest: CompanyManifest,
  repoRoot: string,
): Promise<string> {
  const m = manifest as unknown as {
    goal?: { kpiId?: string; current?: number; target?: number; days?: number };
  };
  const goal = m.goal ?? {};
  const kpiId = goal.kpiId ?? "primary_kpi";
  const current = goal.current ?? "?";
  const target = goal.target ?? "?";
  const days = goal.days ?? 90;

  const header = [
    "# CEO — Operating Contract",
    "",
    "You are the **CEO** in Paperclip OS for this company. The goal,",
    "the KPI tree, and the data plane are defined by the finalized",
    "onboarding manifest — not by this file.",
    "",
    "## Your one job",
    "",
    `> **Defend \`${kpiId}\` from ${current} to ${target} within ${days} days** of your go-live date.`,
    "",
    "Everything else — queue grooming, hiring, firing, promoting operators —",
    "exists only to move that number. The current value, target, KPI tree,",
    "and SQL definitions live in `CONTEXT.md` (company overlay) and in the",
    "manifest the operator finalized. Read those first, every heartbeat.",
    "",
    "## What you do NOT do",
    "",
    "You are a **supervisor**, not an operator. You never:",
    "",
    "- Write code in any company repo",
    "- Execute marketing campaigns, send messages, or transact with customers",
    "- Modify company business data (the manifest's connected data plane)",
    "- Spawn new agents without explicit user approval",
    "",
    "Your **only writes** are inside the **Paperclip orchestration DB**,",
    "specifically:",
    "",
    "- `kpi_snapshots` (insert only — never update/delete)",
    "- `issue_approvals` (insert only)",
    "- `approval_comments` (insert only)",
    "- `issues.ceo_review_status` and `issues.actual_delta` (update on completed issues only)",
    "- `agents.adapter_config->'confidenceLevel'` (update — for operators you supervise)",
    "",
    "If you catch yourself about to write anywhere else, **stop and report**.",
    "",
    "## Context you must read before doing anything",
    "",
    "1. `CONTEXT.md` (same folder) — the company overlay: what the company",
    "   does, who its customer is, and the primary KPI from the manifest.",
    "2. `WORKFLOW.md` (same folder, if present) — your heartbeat loop, lifted",
    "   from `manifest.workflow_manifest.agent_workflows[<your slot>]`.",
    "3. `SKILL_DELIVERABLE_OR_BUST.md` (same folder, if present) — the rule",
    "   that every heartbeat must produce exactly one of: a closed roadmap",
    "   issue, a measurable KPI movement, or an explicit escalation. A run",
    "   that emits only a snapshot + a self-report is NOT a deliverable.",
    "4. The remaining `SKILL_*.md` siblings in this folder — frozen",
    "   role-mechanic playbooks (heartbeat discipline, post-delivery review,",
    "   board escalation).",
    "",
    "## Every heartbeat run must produce",
    "",
    "On every scheduled wake:",
    "",
    `1. **Snapshot KPIs** — insert one \`kpi_snapshots\` row for \`${kpiId}\` and`,
    "   each component KPI defined in the manifest. Source queries come from",
    "   the manifest / data-plane adapter, NOT inlined here.",
    "2. **Review** every `issues` row where `status='completed'` AND",
    "   `ceo_review_status IS NULL`. Grade against each issue's committed",
    "   `measurement_plan` (see `SKILL_POST_DELIVERY_REVIEW.md`).",
    "3. **Report** — emit ONE structured report to stdout:",
    "",
    "   ```",
    "   CEO REVIEW REPORT — <timestamp>",
    `   Meta-goal: ${kpiId} = <X> (baseline <Y>, +<Z>, Δ = N%)`,
    `   Projected ${days}-day finish: <P> (on-pace / behind / ahead)`,
    "   Issues reviewed this cycle: <list>",
    "   Confidence changes: <operator → old_level → new_level>",
    "   Blockers: <anything that should escalate to the operator>",
    "   ```",
    "",
    "4. If the meta-goal is **behind pace**, identify the operator whose KPI",
    "   tier is most responsible and file a single `[CEO direction]` issue",
    "   to that operator. Do NOT spawn work yourself.",
    "",
    "## Reliability",
    "",
    "- If the company's data plane is unreachable, log the failure as a",
    "  `kpi_snapshots` row with `value = NULL` (or write to stdout and skip",
    "  the insert). Do not error out the whole cycle.",
    "- If the Paperclip DB is unreachable, exit with code 1 and let the",
    "  recovery system notice.",
    "",
    "## Turn discipline",
    "",
    "Your heartbeat runs are **short**. Don't sprawl. Get in, read state,",
    "write snapshots + reviews, emit the report, get out. **Target ~30 tool",
    "calls per heartbeat.** Sprawl is the failure mode — autocompact thrash",
    "from a bloated context will kill the run before the report lands.",
    "",
    "## Confidence level",
    "",
    "You run at `confidenceLevel = 3` (autonomous in your narrow supervisor",
    "lane). The operator can demote you to 2 (read-only) if you start writing",
    "to places you shouldn't.",
    "",
    "## Kernel protocol — Goal Keeper (24h cycle)",
    "",
    "Beyond your standard supervisor heartbeat, you run a **once-daily Goal",
    "Keeper cycle** in your company's primary timezone.",
    "",
    "1. Read the prior 24h KPI delta. What moved, what didn't, what regressed.",
    `2. Identify the single biggest gap toward \`${kpiId}\`. Pick ONE bottleneck.`,
    "3. File ONE (1) directive issue: `[CEO direction] <KPI>: <hypothesis>`.",
    "   Assign to the operator whose tier owns that KPI. Body must include",
    "   `target_kpi`, `estimated_delta`, `measurement_plan`, `baseline_snapshot`.",
    "4. Do NOT spawn more than one directive per Goal Keeper cycle.",
    "5. End the cycle.",
    "",
    "## Kernel protocol — Anti-bottleneck rule (NO pre-flight gating)",
    "",
    "When an operator submits a deliverable, **do NOT block on pre-flight",
    "quality checks**. The grading happens AFTER delivery, against the",
    "committed measurement plan. Pre-flight gating recreates the bottleneck",
    "you exist to dissolve.",
    "",
    "If you find yourself being asked for approval on >5 deliveries per day,",
    "the fleet has drifted into pre-flight mode. File an `[ALIGNMENT]` issue.",
    "",
    "## Kernel protocol — Critical-priority 2h window",
    "",
    "Issues with `priority='critical'` get a **2-hour grading window**. If no",
    "grade is filed within 2h, the directive is treated as approved by default.",
    "Reserve `priority='critical'` for: meta-goal regressions, customer-facing",
    "outages, legal/compliance, security. Filing 5+ criticals in one day will",
    "trip the platform's batch-flood limit and your subsequent criticals will",
    "be auto-demoted to `priority='high'`.",
  ].join("\n");

  // A tight kept-set of frozen role-mechanic siblings. Aggressively trimmed
  // from the 14-file original to land the bundle at ~15KB and avoid the
  // 67KB autocompact thrash that was killing real heartbeat runs. Other
  // SKILL_* files (board_directive, collaboration, delegate_or_kill,
  // economic_self_awareness, kpi_ownership, lessons_log, operator_management,
  // queue_economics, recovery_protocol, board_messages) are intentionally
  // omitted here — they either restated wavex-specific examples or duplicated
  // playbook material already covered by the kept set.
  const KEPT_SKILLS = [
    "SKILL_CEO_HEARTBEAT_DISCIPLINE.md",
    "SKILL_POST_DELIVERY_REVIEW.md",
    "SKILL_BOARD_ESCALATION.md",
  ];

  const dir = join(repoRoot, "packages", "onboarding-ui", "public", "agent-templates", "ceo");
  const parts: string[] = [header];
  for (const fname of KEPT_SKILLS) {
    try {
      const c = await readFile(join(dir, fname), "utf8");
      const label = fname.replace(/^SKILL_/, "").replace(/\.md$/, "").replace(/_/g, " ").toLowerCase();
      parts.push(`\n\n---\n\n## Skill: ${label}\n\n${c}`);
    } catch {
      // ignore unreadable side files — degrade rather than fail the handoff
    }
  }
  return parts.join("");
}

/** Strip WaveX-Experiences leakage from a frozen template and prepend a
 *  manifest-driven header so non-CEO agents inherit the tenant's actual KPI
 *  contract instead of the dogfood Bookings-GMV one. Frozen-path-safe:
 *  operates on the in-memory string AFTER the template was read. */
function applyManifestOverlay(
  bundleMd: string,
  role: string,
  manifest: CompanyManifest,
  companyContextBlock: string,
): string {
  const m = manifest as unknown as {
    goal?: { kpiId?: string; current?: number | string; target?: number | string; days?: number };
  };
  const g = m.goal ?? {};
  const kpiId = g.kpiId ?? "primary_kpi";
  const current = g.current ?? "?";
  const target = g.target ?? "?";
  const days = g.days ?? 90;

  const companyMatch = companyContextBlock.match(/\*\*Company:\*\*\s*(.+?)\s*$/m);
  const company = companyMatch ? companyMatch[1].trim() : "this company";
  const roleTitle = role.split("-").map((w) => w === "cmo" || w === "cro" || w === "cfo" || w === "cto" || w === "coo" || w === "ceo" ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

  // Strip lines starting with "# WaveX ..."
  let cleaned = bundleMd.replace(/^# WaveX [^\n]*\n?/gm, "");
  // Strip phrases / literals / schema refs / paths
  const stripPatterns: Array<RegExp | string> = [
    /Bookings GMV/gi, /booking_gmv/gi,
    "$25,000", "$25000",
    "public.bookings", "public.genesis_leads", "public.concierge_*",
    "public.concierge_messages", "public.concierge_sessions", "public.marketing_events",
    "$HOME/ObsidianVault", "wavex-experience-architect", "WaveX Supabase business data",
    "WaveX CEO v2", "Effective: 2026-05-01. Owner: WaveX CEO.",
  ];
  for (const p of stripPatterns) {
    cleaned = typeof p === "string" ? cleaned.split(p).join("") : cleaned.replace(p, "");
  }

  const header = `# ${roleTitle} — Operating Contract for ${company}\n\n**Goal:** defend \`${kpiId}\` from ${current} to ${target} within ${days} days.\n**Domain context, data plane, and KPI tree** live in \`CONTEXT.md\` — read it first, every heartbeat.\n\n---\n\n`;
  return header + cleaned;
}

/** Resolve the wavex-os repo root from this file's path. */
function resolveRepoRoot(): string {
  // src lives at: packages/op-omega-server/src/bridge/paperclip-handoff.ts
  const here = fileURLToPath(import.meta.url);
  return resolve(here, "..", "..", "..", "..", "..");
}

function handoffStateDir(wavexCompanyId: string): string {
  const root = process.env.WAVEX_OS_STATE_DIR ?? join(homedir(), ".wavex-os");
  return join(root, "instances", "default", "companies", wavexCompanyId);
}

interface PaperclipMapping {
  paperclipUrl: string;
  paperclipCompanyId: string;
  createdAt: string;
  agents: Record<string, string>; // slot -> paperclip agentId
}

async function loadMapping(wavexCompanyId: string): Promise<PaperclipMapping | null> {
  try {
    const raw = await readFile(join(handoffStateDir(wavexCompanyId), "paperclip-handoff.json"), "utf8");
    return JSON.parse(raw) as PaperclipMapping;
  } catch {
    return null;
  }
}

async function saveMapping(wavexCompanyId: string, m: PaperclipMapping): Promise<void> {
  const dir = handoffStateDir(wavexCompanyId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "paperclip-handoff.json"), JSON.stringify(m, null, 2), "utf8");
}

/** Per-tenant MCP scoping.
 *
 *  Root cause of pre-fix bug: Paperclip's claude-local adapter spawned the
 *  global `claude` CLI which transitively inherited the operator's installed
 *  MCP plugins (Supabase, Amplitude, Meta Ads, etc.). Every tenant's agent
 *  saw the operator's entire toolbelt — a cross-tenant data leak AND an
 *  autocompact thrash multiplier (multi-KB JSON tool outputs filling the
 *  context within ~10 turns).
 *
 *  Fix: emit a per-tenant mcp.json under the paperclip company's home and
 *  point each agent's claude CLI at it via `--mcp-config <path>
 *  --strict-mcp-config`. The strict flag tells claude to ignore the global
 *  registry entirely. Tenants that connected nothing get an empty
 *  {"mcpServers":{}} — zero tools, deterministic — rather than inheriting
 *  the operator's globally-installed MCPs.
 *
 *  Schema mapping (connector id -> MCP server spec) is intentionally a
 *  small static allowlist. This file does NOT write secrets — connector
 *  credentials live in the operator's keychain / Composio brokerage and
 *  the MCP server entries here only specify the executable + args; the
 *  MCP server itself reads credentials from env or its own config. */
const KNOWN_MCP_SERVERS: Record<string, { command: string; args: string[]; env?: Record<string, string> } | null> = {
  // Operator's installed MCP set as of 2026-05-15 doesn't include any
  // tenant-side servers. When a tenant later connects e.g. Composio or a
  // first-party Supabase MCP, add the spec here. For now every connector
  // in the matrix maps to null (no MCP available yet) — which means an
  // empty mcp.json is written, which is exactly what we want vs leaking
  // the operator's global Supabase MCP.
  "supabase": null,
  "github": null,
  "shopify": null,
  "stripe": null,
  "hubspot": null,
  "mixpanel": null,
  "whatsapp": null,
  "telegram": null,
  "slack": null,
  "meta-ads-api": null,
  "google-ads-api": null,
  "linkedin-sales-nav": null,
  "twilio-sms": null,
  "posthog": null,
  "segment": null,
  "plaid": null,
  "claude-code": null, // inference bootstrap; no MCP surface
};

interface ConnectorEntry { id: string; status?: string }
interface ConnectorManifestShape {
  required?: ConnectorEntry[];
  suggested?: ConnectorEntry[];
  deferred?: ConnectorEntry[];
}

function paperclipCompanyDir(paperclipCompanyId: string): string {
  const paperclipRoot = process.env.WAVEX_PAPERCLIP_ROOT ?? join(homedir(), ".paperclip");
  return join(paperclipRoot, "instances", "default", "companies", paperclipCompanyId);
}

function tenantMcpConfigPath(paperclipCompanyId: string): string {
  return join(paperclipCompanyDir(paperclipCompanyId), ".claude", "mcp.json");
}

/** Write `~/.paperclip/instances/default/companies/<paperclipCompanyId>/.claude/mcp.json`
 *  containing ONLY the MCP servers this tenant authorized through onboarding.
 *  Returns the absolute path written. */
export async function generatePerTenantMcpConfig(
  wavexCompanyId: string,
  paperclipCompanyId: string,
): Promise<string> {
  const onboardingDir = join(handoffStateDir(wavexCompanyId), "onboarding");
  let manifest: ConnectorManifestShape = {};
  try {
    const raw = await readFile(join(onboardingDir, "connector_manifest.json"), "utf8");
    manifest = JSON.parse(raw) as ConnectorManifestShape;
  } catch {
    // No manifest = no connectors authorized = empty scope. Still write the
    // file so the agent's --mcp-config arg points somewhere valid.
  }

  const authorized = new Set<string>();
  const allEntries = [
    ...(manifest.required ?? []),
    ...(manifest.suggested ?? []),
    ...(manifest.deferred ?? []),
  ];
  for (const entry of allEntries) {
    if (!entry?.id) continue;
    if (entry.status === "configured") authorized.add(entry.id);
  }

  const mcpServers: Record<string, { command: string; args: string[]; env?: Record<string, string> }> = {};
  for (const id of authorized) {
    const spec = KNOWN_MCP_SERVERS[id];
    if (spec) mcpServers[id] = spec;
  }

  const configPath = tenantMcpConfigPath(paperclipCompanyId);
  await mkdir(join(paperclipCompanyDir(paperclipCompanyId), ".claude"), { recursive: true });
  await writeFile(configPath, JSON.stringify({ mcpServers }, null, 2), "utf8");
  return configPath;
}

/** Patch every paperclip agent in `mapping` so its claude_local adapter
 *  invokes claude with `--mcp-config <tenantPath> --strict-mcp-config`,
 *  isolating it from the operator's globally-installed MCP servers.
 *
 *  Idempotent: re-running just rewrites the same extraArgs. Paperclip's
 *  PATCH /api/agents/:id deep-merges adapterConfig, so we only need to
 *  send the extraArgs field. */
async function applyMcpConfigToAgents(
  paperclipUrl: string,
  agents: Record<string, string>,
  tenantMcpPath: string,
): Promise<{ patched: string[]; failed: Array<{ agentId: string; reason: string }> }> {
  const extraArgs = ["--mcp-config", tenantMcpPath, "--strict-mcp-config"];
  const patched: string[] = [];
  const failed: Array<{ agentId: string; reason: string }> = [];
  for (const agentId of Object.values(agents)) {
    try {
      const r = await fetch(`${paperclipUrl}/api/agents/${agentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adapterConfig: { extraArgs } }),
      });
      if (!r.ok) {
        failed.push({ agentId, reason: `HTTP ${r.status}` });
      } else {
        patched.push(agentId);
      }
    } catch (e) {
      failed.push({ agentId, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return { patched, failed };
}

/** Per-slot live handoff progress. Written after each hire so the UI can
 *  poll it for a real slot-by-slot reveal during activate, then cleared
 *  when handoff completes. Lives next to paperclip-handoff.json. */
interface HandoffProgressSlot {
  slot: string;
  status: "pending" | "hiring" | "hired" | "already_mapped" | "skipped" | "failed";
  agentId?: string;
  reason?: string;
}
interface HandoffProgress {
  paperclipUrl: string;
  paperclipCompanyId: string;
  total: number;
  completed: number;
  inFlight: string | null;
  slots: HandoffProgressSlot[];
}

function handoffProgressPath(wavexCompanyId: string): string {
  return join(handoffStateDir(wavexCompanyId), "handoff-progress.json");
}

async function writeHandoffProgress(wavexCompanyId: string, p: HandoffProgress): Promise<void> {
  const dir = handoffStateDir(wavexCompanyId);
  await mkdir(dir, { recursive: true });
  await writeFile(handoffProgressPath(wavexCompanyId), JSON.stringify(p, null, 2), "utf8");
}

async function updateHandoffProgress(
  wavexCompanyId: string,
  slot: string,
  patch: Partial<HandoffProgressSlot>,
  completed: number,
): Promise<void> {
  const { readFile } = await import("node:fs/promises");
  try {
    const raw = await readFile(handoffProgressPath(wavexCompanyId), "utf8");
    const p = JSON.parse(raw) as HandoffProgress;
    p.completed = completed;
    p.inFlight = patch.status === "hiring" ? slot : null;
    p.slots = p.slots.map((s) => (s.slot === slot ? { ...s, ...patch } : s));
    await writeFile(handoffProgressPath(wavexCompanyId), JSON.stringify(p, null, 2), "utf8");
  } catch { /* file racing or removed — non-fatal */ }
}

async function clearHandoffProgress(wavexCompanyId: string): Promise<void> {
  const { unlink } = await import("node:fs/promises");
  try { await unlink(handoffProgressPath(wavexCompanyId)); } catch { /* already gone */ }
}

/** Read scope.json so the bridge can honor the operator's sub-fleet
 *  selection. Lives next to onboarding artifacts; null if unset (treat
 *  as full-org, no filtering). */
async function readScopeForBridge(wavexCompanyId: string): Promise<{ mode: "full" | "focused"; departments: string[] } | null> {
  const { readFile } = await import("node:fs/promises");
  const path = join(handoffStateDir(wavexCompanyId), "onboarding", "scope.json");
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as { mode?: string; departments?: string[] };
    if (parsed.mode === "focused") {
      return { mode: "focused", departments: parsed.departments ?? [] };
    }
    return { mode: "full", departments: [] };
  } catch {
    return null;
  }
}

async function ensurePaperclipCompany(
  paperclipUrl: string,
  wavexCompanyId: string,
  manifest: CompanyManifest,
  existing: PaperclipMapping | null,
): Promise<{ paperclipCompanyId: string; created: boolean }> {
  if (existing) {
    // Verify it still exists
    const r = await fetch(`${paperclipUrl}/api/companies/${existing.paperclipCompanyId}`).catch(() => null);
    if (r && r.ok) return { paperclipCompanyId: existing.paperclipCompanyId, created: false };
  }
  const name = `wavex-os/${wavexCompanyId}`;
  // Encode the wavex slug into the description so the Paperclip UI can
  // recover it even if the operator renames the company. The name prefix
  // is the primary lookup; description is the fallback. See
  // packages/core/ui/src/lib/wavex-link.ts deriveWavexCompanyId.
  const description = `Auto-provisioned from wavex-os onboarding finalize. Source manifest hash: ${manifest.signatures?.manifest_hash ?? "unknown"}. wavexCompanyId=${wavexCompanyId}`;
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

async function hireOne(
  paperclipUrl: string,
  paperclipCompanyId: string,
  slot: string,
  entry: SwarmAgentEntry,
  reportsToId: string | null,
  bundleMd: string,
  contextMd: string,
  workflowMd: string | null,
  swarmPct: number,
): Promise<{ agentId: string; status: string }> {
  const { role, orig } = mapRoleToPaperclipEnum(slot);
  const name = humanNameForSlot(slot, entry.display_name);
  const payload: Record<string, unknown> = {
    name,
    role,
    title: humanNameForSlot(slot),
    icon: iconForSlot(slot),
    capabilities: `Vendored from wavex-os op-omega manifest. Original slot=${slot}, template=${entry.template_id ?? orig}.`,
    adapterType: "claude_local",
    adapterConfig: {
      // Auth wrapper — NEVER bare `claude`. Root cause (2026-05-14 live demo):
      // claude v2.1.x with CLAUDE_CONFIG_DIR explicitly set reads
      // <dir>/.credentials.json and skips the macOS keychain entirely, so
      // every keychain-auth box reports "Not logged in". The wrapper unsets
      // CLAUDE_CONFIG_DIR, drops an empty ANTHROPIC_API_KEY, and guarantees
      // USER/LOGNAME so the keychain is reachable from launchd spawns.
      // PAPERCLIP_HANDOFF_WRAPPER lets an operator point at a per-box wrapper;
      // the repo-versioned default is the safe fallback for every fresh fleet.
      command: process.env.PAPERCLIP_HANDOFF_WRAPPER
        ?? join(resolveRepoRoot(), "scripts", "ops", "claude-keychain-wrapper.sh"),
      model: "claude-sonnet-4-6",
      dangerouslySkipPermissions: true,
      timeoutSec: 600,
      graceSec: 30,
      // Deliberately do NOT pass CLAUDE_CONFIG_DIR — see above. HOME + USER +
      // LOGNAME are the minimum claude needs to find the login keychain.
      env: {
        HOME: { type: "plain", value: process.env.HOME ?? "" },
        USER: { type: "plain", value: process.env.USER ?? process.env.LOGNAME ?? "" },
        LOGNAME: { type: "plain", value: process.env.LOGNAME ?? process.env.USER ?? "" },
      },
    },
    // AGENTS.md = generic role skills; CONTEXT.md = company-specific overlay
    // (company context + this agent's skill_overlay mandate); WORKFLOW.md =
    // the agent's on_fire heartbeat loop. All land in the agent's
    // instructions dir so it knows its craft, its company, AND its cycle.
    instructionsBundle: {
      files: {
        "AGENTS.md": bundleMd,
        "CONTEXT.md": contextMd,
        ...(workflowMd ? { "WORKFLOW.md": workflowMd } : {}),
      },
    },
    runtimeConfig: { heartbeat: heartbeatConfigForSlot(slot, swarmPct) },
  };
  if (reportsToId) payload.reportsTo = reportsToId;

  const r = await fetch(`${paperclipUrl}/api/companies/${paperclipCompanyId}/agent-hires`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    throw new Error(`agent-hires failed for ${slot}: ${r.status} ${await r.text()}`);
  }
  const body = await r.json() as { agent: { id: string; status: string }; approval?: { id: string; status: string } };
  const status = body.agent.status;
  // Auto-approve if Paperclip created an approval record
  if (body.approval && body.approval.status === "pending") {
    const ap = await fetch(`${paperclipUrl}/api/approvals/${body.approval.id}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decisionNote: `Auto-approved by wavex-os handoff bridge for slot=${slot}` }),
    });
    if (!ap.ok) {
      // Non-fatal — agent still exists, just pending
      return { agentId: body.agent.id, status: `${status}_approve_failed_${ap.status}` };
    }
    return { agentId: body.agent.id, status: "approved" };
  }
  return { agentId: body.agent.id, status };
}

/** Topologically sort swarm slots so parents land in Paperclip before
 *  their children. Required because Paperclip's reportsTo schema needs a
 *  real UUID — the parent's hire response provides it. If a child fires
 *  before its parent, reportsTo would be null and the child would orphan
 *  at Paperclip's root.
 *
 *  Cycles or unresolvable parents fall to the end (treated as roots). */
function topoSortSlots(swarm: Record<string, SwarmAgentEntry>): Array<[string, SwarmAgentEntry]> {
  const all = Object.entries(swarm);
  const known = new Set(all.map(([s]) => s));
  const placed = new Set<string>();
  const result: Array<[string, SwarmAgentEntry]> = [];
  while (placed.size < all.length) {
    const before = placed.size;
    for (const [slot, entry] of all) {
      if (placed.has(slot)) continue;
      const parent = entry.reports_to;
      // Place when: no parent OR parent isn't in this swarm OR parent already placed.
      if (!parent || !known.has(parent) || placed.has(parent)) {
        result.push([slot, entry]);
        placed.add(slot);
      }
    }
    if (placed.size === before) {
      // No progress → cycle. Push remaining as-is and break.
      for (const [slot, entry] of all) {
        if (!placed.has(slot)) { result.push([slot, entry]); placed.add(slot); }
      }
    }
  }
  return result;
}

export async function handoffToPaperclip(
  manifest: CompanyManifest,
  wavexCompanyId: string,
): Promise<HandoffReport> {
  const paperclipUrl = process.env.PAPERCLIP_HANDOFF_URL?.replace(/\/+$/, "") ?? null;
  if (!paperclipUrl) {
    return {
      enabled: false,
      paperclipUrl: null,
      paperclipCompanyId: null,
      created: [],
      skipped: [],
      errors: [],
    };
  }

  const report: HandoffReport = {
    enabled: true,
    paperclipUrl,
    paperclipCompanyId: null,
    created: [],
    skipped: [],
    errors: [],
  };

  const existing = await loadMapping(wavexCompanyId);
  const { paperclipCompanyId } = await ensurePaperclipCompany(paperclipUrl, wavexCompanyId, manifest, existing);
  report.paperclipCompanyId = paperclipCompanyId;

  // Emit per-tenant MCP scope BEFORE hiring any agent so the first heartbeat
  // already sees a scoped --mcp-config. (Hires below come up paused; first
  // spawn is on heartbeat.)
  const tenantMcpPath = await generatePerTenantMcpConfig(wavexCompanyId, paperclipCompanyId);

  const repoRoot = resolveRepoRoot();
  // The signed CompanyManifest nests the swarm under `swarm_manifest.agents`.
  // (Stand-alone swarm_manifest.json has it at top-level; CompanyManifest doesn't.)
  const swarm =
    (manifest as unknown as { swarm_manifest?: { agents?: Record<string, SwarmAgentEntry> } }).swarm_manifest?.agents ??
    (manifest as unknown as { agents?: Record<string, SwarmAgentEntry> }).agents ??
    {};

  // Company-context block — built once, shared verbatim across every agent's
  // CONTEXT.md. Per-agent customization (skill_overlay etc.) is appended
  // per-slot inside the hire loop below.
  const companyContextBlock = buildCompanyContextBlock(manifest);

  // Inference allocation — the swarm's share of the operator's Claude Max
  // window. Read once; scales every agent's heartbeat interval. Default
  // 70% (the route's default) if the operator never touched the slider.
  const allocation = await readInferenceAllocation();
  const swarmPct = allocation.swarm_pct;

  // Track slot -> paperclip agentId for reports_to resolution
  const slotToPaperclipId: Record<string, string> = { ...(existing?.agents ?? {}) };

  // Operator may have muted slots via the redundancy review — skip them
  // in Paperclip too, matching the bridge's behavior.
  const mutes = new Set(
    (manifest as unknown as { template_mutes?: string[] }).template_mutes ?? [],
  );

  // Sub-fleet scope filter — only honored when mode === "focused".
  // In focused mode we skip agents whose department isn't in the
  // operator's selected set (or, for custom-only scopes, anything
  // outside "ops" — the same fallback the swarm-manifest route uses).
  // In full mode we mirror every slot regardless of vendor-parked status,
  // because the operator didn't ask to scope anything down — they want
  // the whole intended org in Paperclip.
  const scope = await readScopeForBridge(wavexCompanyId);
  const scopeDepts = scope && scope.mode === "focused"
    ? new Set<string>([
        ...(scope.departments.length > 0 ? scope.departments : ["ops"]),
        "ceo", // CEO + chief-of-staff are sacrosanct
      ])
    : null; // null = full org, no department filtering

  // Full handoff: every slot in the swarm, sorted topologically so parents
  // land before children. The original V1 scope was C-suite only — fine
  // for early dev, but the "wavex-os/<company>" record in Paperclip then
  // hid 27 of 35 agents (every L·IV specialist) which made the dashboard
  // misleading. Now the manifest in Paperclip matches wavex 1:1.
  //
  // Per-slot progress is written to <onboarding-dir>/handoff-progress.json
  // after each hire so the UI can poll it for a real slot-by-slot reveal
  // (ActivateProgress component). The file is overwritten on every step
  // and removed when this function returns.
  const allSlots = topoSortSlots(swarm);
  await writeHandoffProgress(wavexCompanyId, {
    paperclipCompanyId,
    paperclipUrl,
    total: allSlots.length,
    completed: 0,
    inFlight: null,
    slots: allSlots.map(([slot]) => ({ slot, status: "pending" as const })),
  });

  let completed = 0;
  for (const [slot, entry] of allSlots) {
    if (mutes.has(slot)) {
      report.skipped.push({ slot, reason: "muted-by-operator" });
      completed += 1;
      await updateHandoffProgress(wavexCompanyId, slot, { status: "skipped", reason: "muted-by-operator" }, completed);
      continue;
    }
    if (slotToPaperclipId[slot]) {
      report.skipped.push({ slot, reason: "already-mapped" });
      completed += 1;
      // Already-mapped slots are still live in Paperclip from a prior
      // activate — render them as success in the UI, not as "skipped".
      await updateHandoffProgress(wavexCompanyId, slot, { status: "already_mapped", reason: "already-mapped" }, completed);
      continue;
    }
    // Sub-fleet scope filter — skip agents whose department isn't in
    // the operator's selected set. Only applies when scope.mode is
    // "focused". CEO + chief-of-staff (department "ceo") always go
    // through. Vendor-generator-parked agents in scoped departments
    // still mirror to Paperclip — the bridge defers to the operator's
    // explicit scope choice, not vendor-parking heuristics.
    if (scopeDepts) {
      const dept = (entry as { department?: string }).department ?? "";
      if (!scopeDepts.has(dept)) {
        report.skipped.push({ slot, reason: `outside-scope` });
        completed += 1;
        await updateHandoffProgress(wavexCompanyId, slot, { status: "skipped", reason: "outside-scope" }, completed);
        continue;
      }
    }
    await updateHandoffProgress(wavexCompanyId, slot, { status: "hiring" }, completed);
    // Bundle is normally keyed off slot.split(".")[0] (ceo/cmo/cro/etc.).
    // CoS is special-cased because its slot starts with "ceo." — without
    // this guard, the CoS would receive the CEO's AGENTS.md bundle (CEO
    // operator-management + economic-self-awareness routines) instead of
    // its own SKILL_FLEET_ALIGNMENT routine. That made the CoS effectively
    // a duplicate CEO from Paperclip's runtime perspective.
    const bundleRole = slot === "ceo.chief-of-staff"
      ? "chief-of-staff"
      : slot.split(".")[0].replace(/_/g, "-");
    // CEO is special-cased: the frozen agent-templates/ceo/SKILL.md +
    // SKILL_KPI_OWNERSHIP.md are hardcoded WaveX-Experiences (Bookings GMV /
    // public.bookings / etc.). Every tenant's CEO inherited that contract
    // and queried the wrong data plane. buildCeoBundle replaces those two
    // files with a manifest-driven, tenant-neutral header parameterized
    // from `manifest.goal.{kpiId, current, target, days}`, and keeps a tight
    // subset of role-mechanic siblings. Frozen-path-safe: read-only.
    const bundleMd = bundleRole === "ceo"
      ? await buildCeoBundle(manifest, repoRoot)
      : applyManifestOverlay(
          (await readAgentBundle(bundleRole, repoRoot)
            ?? await readAgentBundle("chief-of-staff", repoRoot)
            ?? `# ${slot}\n\nPlaceholder — bundle file missing.`),
          bundleRole,
          manifest,
          companyContextBlock,
        );
    // CONTEXT.md = shared company block + this agent's skill_overlay mandate.
    const contextMd = buildAgentContextMd(companyContextBlock, slot, entry);
    // WORKFLOW.md = this agent's on_fire heartbeat loop (null if the
    // workflow manifest has no entry for this slot).
    const workflowMd = buildAgentWorkflowMd(
      (manifest as unknown as { workflow_manifest?: unknown }).workflow_manifest,
      slot,
    );
    const reportsToSlot = entry.reports_to ?? null;
    const reportsToId = reportsToSlot ? slotToPaperclipId[reportsToSlot] ?? null : null;
    try {
      const out = await hireOne(paperclipUrl, paperclipCompanyId, slot, entry, reportsToId, bundleMd, contextMd, workflowMd, swarmPct);
      slotToPaperclipId[slot] = out.agentId;
      report.created.push({ slot, agentId: out.agentId, status: out.status });
      completed += 1;
      await updateHandoffProgress(wavexCompanyId, slot, { status: "hired", agentId: out.agentId }, completed);
      // Mission Control mirror — surfaces "Sales Agent joined under Sales"
      // (or equivalent) in the Stream widget. Best-effort, never throws.
      await mirrorToMissionControl({
        companyId: paperclipCompanyId,
        instanceId: wavexCompanyId,
        actorNodeId: out.agentId,
        action: "wavex.paperclip_handoff.agent_hired",
        modeContext: "solo_founder",
        subjectRef: {
          kind: "node",
          id: out.agentId,
          toNodeId: reportsToId ?? undefined,
          slot,
        },
      });
    } catch (e) {
      report.errors.push({ slot, message: e instanceof Error ? e.message : String(e) });
      completed += 1;
      await updateHandoffProgress(wavexCompanyId, slot, { status: "failed" }, completed);
    }
  }
  await clearHandoffProgress(wavexCompanyId);

  // Persist mapping for idempotency
  await saveMapping(wavexCompanyId, {
    paperclipUrl,
    paperclipCompanyId,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    agents: slotToPaperclipId,
  });

  // Apply --mcp-config to every freshly-mapped agent so their next spawn
  // ignores the operator's global MCP registry. Best-effort: failures here
  // don't fail the handoff (we still surface them in the log).
  await applyMcpConfigToAgents(paperclipUrl, slotToPaperclipId, tenantMcpPath);

  return report;
}

/** Force-rerender AGENTS.md / CONTEXT.md / WORKFLOW.md on disk for every
 *  already-mapped slot in a wavex company's paperclip-handoff.json.
 *
 *  Why this exists: the activate route's handoffToPaperclip skips
 *  already-mapped slots, so a fleet hired before the manifest-driven CEO
 *  bundle / overlay rewrite still reads the old WaveX-Experiences-hardcoded
 *  AGENTS.md on disk. This refreshes those files in place against the
 *  currently-finalized manifest. No Paperclip API calls; the Paperclip
 *  agents already exist — we just rewrite what they READ at next heartbeat.
 *
 *  Idempotent. Safe to re-run. */
export async function rerenderBundlesForCompany(
  wavexCompanyId: string,
  _paperclipUrl: string,
  _paperclipApiKey: string | null,
): Promise<{
  rerendered: Array<{ slot: string; agentId: string; bytes: number }>;
  skipped: Array<{ slot: string; reason: string }>;
}> {
  const rerendered: Array<{ slot: string; agentId: string; bytes: number }> = [];
  const skipped: Array<{ slot: string; reason: string }> = [];

  // 1) Load the company manifest
  const manifestPath = join(
    handoffStateDir(wavexCompanyId),
    "onboarding",
    "company.manifest.json",
  );
  const manifestRaw = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(manifestRaw) as CompanyManifest;

  // 2) Load the paperclip-handoff mapping
  const mapping = await loadMapping(wavexCompanyId);
  if (!mapping) {
    throw new Error(`no paperclip-handoff.json for wavex company ${wavexCompanyId}`);
  }
  const paperclipCompanyId = mapping.paperclipCompanyId;

  // Refresh per-tenant MCP scope alongside the bundle rerender. Same root
  // cause: existing tenants hired before this fix have agents that still
  // spawn claude with no --mcp-config, so they pick up the operator's
  // global MCPs on every heartbeat.
  const tenantMcpPath = await generatePerTenantMcpConfig(wavexCompanyId, paperclipCompanyId);
  await applyMcpConfigToAgents(mapping.paperclipUrl, mapping.agents, tenantMcpPath);

  const repoRoot = resolveRepoRoot();
  const swarm =
    (manifest as unknown as { swarm_manifest?: { agents?: Record<string, SwarmAgentEntry> } }).swarm_manifest?.agents ??
    (manifest as unknown as { agents?: Record<string, SwarmAgentEntry> }).agents ??
    {};
  const companyContextBlock = buildCompanyContextBlock(manifest);
  const workflowManifest = (manifest as unknown as { workflow_manifest?: unknown }).workflow_manifest;

  // Paperclip-side instructions base path. The Paperclip *server* (separate
  // process on :3100) reads agent instructions from its OWN data root, which
  // defaults to ~/.paperclip. We deliberately do NOT use PAPERCLIP_DATA_DIR
  // here — that env var is set by mock-core to point the vendored onboarding
  // plugin at ~/.wavex-os and would write to the wrong tree. Use the
  // dedicated WAVEX_PAPERCLIP_ROOT override to repoint at a non-default
  // Paperclip install.
  const paperclipRoot = process.env.WAVEX_PAPERCLIP_ROOT ?? join(homedir(), ".paperclip");
  const instructionsBase = join(
    paperclipRoot,
    "instances",
    "default",
    "companies",
    paperclipCompanyId,
    "agents",
  );

  // 3) For each (slot, agentId) in the handoff: render fresh files
  for (const [slot, agentId] of Object.entries(mapping.agents)) {
    const entry = swarm[slot];
    if (!entry) {
      skipped.push({ slot, reason: "slot-not-in-current-swarm" });
      continue;
    }
    const bundleRole = slot === "ceo.chief-of-staff"
      ? "chief-of-staff"
      : slot.split(".")[0].replace(/_/g, "-");
    const bundleMd = bundleRole === "ceo"
      ? await buildCeoBundle(manifest, repoRoot)
      : applyManifestOverlay(
          (await readAgentBundle(bundleRole, repoRoot)
            ?? await readAgentBundle("chief-of-staff", repoRoot)
            ?? `# ${slot}\n\nPlaceholder — bundle file missing.`),
          bundleRole,
          manifest,
          companyContextBlock,
        );
    const contextMd = buildAgentContextMd(companyContextBlock, slot, entry);
    const workflowMd = buildAgentWorkflowMd(workflowManifest, slot);

    const instructionsDir = join(instructionsBase, agentId, "instructions");
    await mkdir(instructionsDir, { recursive: true });
    await writeFile(join(instructionsDir, "AGENTS.md"), bundleMd, "utf8");
    await writeFile(join(instructionsDir, "CONTEXT.md"), contextMd, "utf8");
    if (workflowMd) {
      await writeFile(join(instructionsDir, "WORKFLOW.md"), workflowMd, "utf8");
    }
    rerendered.push({ slot, agentId, bytes: Buffer.byteLength(bundleMd, "utf8") });
  }

  return { rerendered, skipped };
}
