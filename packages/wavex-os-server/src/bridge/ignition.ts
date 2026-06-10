/**
 * Phase: Ignition (post-activate).
 *
 * Design: docs/IGNITION.md. Closes the gap between "agents exist as rows"
 * (activate output) and "agents are doing visible work".
 *
 * Sequence (each step is idempotent against ignition-state.json):
 *   1. Load workflow_manifest from disk
 *   2. Read/create the Goal in Paperclip
 *   3. Seed first-task issues per non-muted slot
 *   4. CEO + CoS kickoff probe wake calls (best-effort, non-blocking)
 *   5. Validate L·IV coverage, retry gaps once
 *   6. Enable heartbeats with staggered cron offsets
 *   7. Write completion event to ignition-state.json
 *
 * Returns a structured result the activate route includes in its response.
 *
 * Failure-tolerant: every step records its own status; downstream callers
 * can re-invoke `POST /api/instance/:id/ignite` to resume from the first
 * incomplete step.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { CompanyManifest } from "@wavex-os/plugin-onboarding";
import { getOnboardingDir, getInstanceDir } from "../state-bridge.js";

// Base URL Paperclip is reachable at. Seeded from the process env, but
// ignite() overrides it per-run from the handoff arg — the env read is
// empty in some server contexts (and in the standalone /ignite path), and
// when it's empty EVERY Paperclip step silently skips and the company ends
// up orphan-from-planning. The handoff carries the real, verified URL.
let PAPERCLIP_URL = process.env.PAPERCLIP_HANDOFF_URL ?? "";

export type IgnitionStepStatus = "pending" | "ok" | "error" | "skipped";

export interface IgnitionState {
  v: 1;
  company_id: string;
  started_at: string;
  completed_at: string | null;
  steps: {
    workflow_load: { status: IgnitionStepStatus; note?: string };
    goal_create: { status: IgnitionStepStatus; goal_id?: string; note?: string };
    seed_issues: { status: IgnitionStepStatus; created: string[]; note?: string };
    seed_roadmap: { status: IgnitionStepStatus; created: string[]; note?: string };
    kickoff_probe: { status: IgnitionStepStatus; ceo_run_id?: string; cos_run_id?: string; note?: string };
    kickoff_routine: { status: IgnitionStepStatus; routine_id?: string; trigger_id?: string; note?: string };
    middleware_charter: { status: IgnitionStepStatus; note?: string };
    validate_coverage: { status: IgnitionStepStatus; gaps: string[]; note?: string };
    stagger_heartbeats: { status: IgnitionStepStatus; offsets: Record<string, number>; note?: string };
  };
  errors: { step: string; message: string; ts: string }[];
  warnings: string[];
}

export interface IgnitionResult {
  status: "ignited" | "partial" | "deferred" | "skipped";
  agents_working: number;
  workflows_queued: number;
  goal_id: string | null;
  errors: IgnitionState["errors"];
  warnings: string[];
  ignition_state_path: string;
}

interface WorkflowManifest {
  agent_workflows?: Record<string, {
    on_fire?: Array<{
      title?: string;
      description?: string;
      expected_output?: string;
      flow_type?: string;
      target?: string;
      dry_run_gate?: boolean;
    }>;
    heartbeat?: { period_minutes?: number };
  }>;
  /** Cross-agent collaborative initiatives — the "roadmap of tasks". Each
   *  is owned by one agent, runs on a cycle, pulls in participating agents,
   *  and exists to move a named set of KPIs. Seeded as roadmap issues. */
  bundle_workflows?: Record<string, {
    owner?: string;
    cycle_length?: string;
    participating_agents?: string[];
    kpis_moved?: string[];
  }>;
}

interface SwarmAgent {
  slot: string;
  template_id?: string;
  muted?: boolean;
}

function ignitionStatePath(companyId: string): string {
  return join(getInstanceDir(companyId), "ignition-state.json");
}

async function readState(companyId: string): Promise<IgnitionState | null> {
  try {
    const raw = await readFile(ignitionStatePath(companyId), "utf8");
    return JSON.parse(raw) as IgnitionState;
  } catch {
    return null;
  }
}

async function writeState(state: IgnitionState): Promise<void> {
  const path = ignitionStatePath(state.company_id);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2));
}

function freshState(companyId: string): IgnitionState {
  return {
    v: 1,
    company_id: companyId,
    started_at: new Date().toISOString(),
    completed_at: null,
    steps: {
      workflow_load: { status: "pending" },
      goal_create: { status: "pending" },
      seed_issues: { status: "pending", created: [] },
      seed_roadmap: { status: "pending", created: [] },
      kickoff_probe: { status: "pending" },
      kickoff_routine: { status: "pending" },
      middleware_charter: { status: "pending" },
      validate_coverage: { status: "pending", gaps: [] },
      stagger_heartbeats: { status: "pending", offsets: {} },
    },
    errors: [],
    warnings: [],
  };
}

function recordErr(state: IgnitionState, step: string, message: string): void {
  state.errors.push({ step, message, ts: new Date().toISOString() });
}

async function loadWorkflowManifest(companyId: string): Promise<WorkflowManifest | null> {
  try {
    const path = join(getOnboardingDir(companyId), "workflow_manifest.json");
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as WorkflowManifest;
  } catch {
    return null;
  }
}

function paperclipFetch(path: string, init?: RequestInit): Promise<Response> {
  if (!PAPERCLIP_URL) {
    return Promise.reject(new Error("PAPERCLIP_HANDOFF_URL not set"));
  }
  return fetch(`${PAPERCLIP_URL.replace(/\/$/, "")}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
}

/** Slot → stable cron-minute offset. Distributes 35 slots across 60 minutes
 *  so the fleet doesn't all fire at minute 0. */
function hashSlotToOffset(slot: string): number {
  let h = 0;
  for (let i = 0; i < slot.length; i++) h = ((h << 5) - h + slot.charCodeAt(i)) | 0;
  return Math.abs(h) % 60;
}

/**
 * Run ignition for a freshly-activated company. Idempotent.
 */
export async function ignite(
  manifest: CompanyManifest,
  companyId: string,
  paperclipHandoff: {
    paperclipCompanyId: string | null;
    paperclipUrl?: string | null;
    created: Array<{ slot: string; agentId: string }>;
  } | null,
): Promise<IgnitionResult> {
  const state = (await readState(companyId)) ?? freshState(companyId);
  // Back-compat: an ignition-state.json written before seed_roadmap /
  // kickoff_routine existed won't have those steps. Initialize them so step
  // access + the allOk check don't trip over `undefined`.
  if (!state.steps.seed_roadmap) {
    state.steps.seed_roadmap = { status: "pending", created: [] };
  }
  if (!state.steps.kickoff_routine) {
    state.steps.kickoff_routine = { status: "pending" };
  }
  await writeState(state);

  // ── Step 1: load workflow manifest ───────────────────────────────────
  const workflow = await loadWorkflowManifest(companyId);
  if (!workflow) {
    state.steps.workflow_load = { status: "error", note: "workflow_manifest.json missing" };
    recordErr(state, "workflow_load", "workflow_manifest.json not found in onboarding dir");
    await writeState(state);
    return {
      status: "deferred",
      agents_working: 0,
      workflows_queued: 0,
      goal_id: null,
      errors: state.errors,
      warnings: state.warnings,
      ignition_state_path: ignitionStatePath(companyId),
    };
  }
  state.steps.workflow_load = { status: "ok" };

  // Prefer the URL the handoff actually used — see the `let PAPERCLIP_URL`
  // note above. Without this, the standalone /ignite path (and any server
  // started without PAPERCLIP_HANDOFF_URL in its env) skips every Paperclip
  // step → no goal, no issues, no roadmap, no kickoff → orphan-from-planning.
  if (paperclipHandoff?.paperclipUrl) {
    PAPERCLIP_URL = paperclipHandoff.paperclipUrl;
  }

  // swarm_manifest.agents is an OBJECT keyed by slot in real manifests
  // (e.g. { "ceo.orchestrator": {...}, "cpo": {...} }) — 35 entries. The old
  // type assertion claimed `SwarmAgent[]` (an array), which was a lie: at
  // runtime `swarmAgents.filter(...)` threw "filter is not a function", and
  // because activate.ts swallowed ignite() into a soft "deferred", EVERY
  // incepted company silently ended up orphan-from-planning. Normalize both
  // shapes; when it's the slot-keyed object, the key IS the canonical slot.
  const swarm = (manifest as unknown as {
    swarm_manifest?: { agents?: SwarmAgent[] | Record<string, SwarmAgent> };
  }).swarm_manifest;
  const rawAgents = swarm?.agents;
  const swarmAgents: SwarmAgent[] = Array.isArray(rawAgents)
    ? rawAgents
    : rawAgents && typeof rawAgents === "object"
      ? Object.entries(rawAgents).map(([slot, cfg]) => ({ ...(cfg as SwarmAgent), slot }))
      : [];
  const nonMuted = swarmAgents.filter((a) => !a.muted);

  // ── Step 2: ensure Goal exists in Paperclip ──────────────────────────
  let goalId: string | null = state.steps.goal_create.goal_id ?? null;
  const paperclipCompanyId = paperclipHandoff?.paperclipCompanyId ?? null;

  if (!goalId && paperclipCompanyId && PAPERCLIP_URL) {
    try {
      const existing = await paperclipFetch(`/api/companies/${paperclipCompanyId}/goals`);
      if (existing.ok) {
        const existingBody = (await existing.json()) as Array<{ id: string }> | { items: Array<{ id: string }> };
        const list = Array.isArray(existingBody) ? existingBody : existingBody.items ?? [];
        if (list.length > 0) {
          goalId = list[0]!.id;
        }
      }
      if (!goalId) {
        const p1 = (manifest as unknown as { pillar_responses?: { pillar_1?: Record<string, unknown> } }).pillar_responses?.pillar_1 ?? {};
        const title = `${(p1.org_name as string) ?? "company"} — primary goal`;
        const body = [
          `Company context: ${p1.company_context ?? "n/a"}`,
          ``,
          `Primary friction (hypothesized): ${p1.primary_friction_hypothesis ?? "n/a"}`,
          ``,
          `Differentiator (hypothesized): ${p1.differentiator_hypothesis ?? "n/a"}`,
          ``,
          `Meta KPI: ${(manifest as unknown as { meta_goal?: string }).meta_goal ?? "to be set"}`,
        ].join("\n");
        const create = await paperclipFetch(`/api/companies/${paperclipCompanyId}/goals`, {
          method: "POST",
          body: JSON.stringify({ title, description: body }),
        });
        if (create.ok) {
          const created = (await create.json()) as { id: string };
          goalId = created.id;
        } else {
          recordErr(state, "goal_create", `paperclip goals POST returned ${create.status}`);
        }
      }
      state.steps.goal_create = { status: goalId ? "ok" : "error", goal_id: goalId ?? undefined };
    } catch (e) {
      state.steps.goal_create = { status: "error", note: (e as Error).message };
      recordErr(state, "goal_create", (e as Error).message);
    }
  } else if (!paperclipCompanyId) {
    state.steps.goal_create = { status: "skipped", note: "no Paperclip company id (handoff not enabled)" };
    state.warnings.push("Ignition skipped goal_create: Paperclip handoff was not enabled");
  }

  // ── Step 3: seed first-task issues ───────────────────────────────────
  const slotToPaperclipId = new Map<string, string>(
    (paperclipHandoff?.created ?? []).map((c) => [c.slot, c.agentId]),
  );
  const createdIssues: string[] = state.steps.seed_issues.created ?? [];
  if (paperclipCompanyId && PAPERCLIP_URL && createdIssues.length === 0) {
    for (const agent of nonMuted) {
      const slot = agent.slot;
      const tasks = workflow.agent_workflows?.[slot]?.on_fire ?? [];
      const firstNonGated = tasks.find((t) => !t.dry_run_gate);
      if (!firstNonGated) continue;
      const paperclipAgentId = slotToPaperclipId.get(slot);
      if (!paperclipAgentId) continue;

      const title = `${(firstNonGated.expected_output ?? firstNonGated.title ?? "Initial cycle").slice(0, 80)}`;
      // OPERATIONAL_LAYER.md §1 — the deliverable contract. The Liaison's
      // DELIVERABLE_LEDGER skill parses this fenced block back out to seed a
      // wavex_os.deliverable_ledger row (plan_ref + expected_response + kind).
      const body = [
        firstNonGated.description ?? "",
        "",
        "```wavex-contract",
        `plan_ref: workflow:${slot}:on_fire`,
        `expected_response: ${(firstNonGated.expected_output ?? firstNonGated.title ?? "complete the seeded cycle").replace(/\r?\n/g, " ").slice(0, 280)}`,
        "kind: routine",
        "```",
        "",
        "_Seeded by ignition v1. Grade criteria: see SKILL_KPI_OWNERSHIP measurement contract._",
      ].join("\n");
      try {
        const resp = await paperclipFetch(`/api/companies/${paperclipCompanyId}/issues`, {
          method: "POST",
          body: JSON.stringify({
            title,
            description: body,
            assigneeAgentId: paperclipAgentId,
            goalId,
            priority: "medium",
            tags: ["wavex:ignition-seed:v1"],
          }),
        });
        if (resp.ok) {
          const created = (await resp.json()) as { id?: string; key?: string };
          if (created.key) createdIssues.push(created.key);
          else if (created.id) createdIssues.push(created.id);
        }
      } catch (e) {
        recordErr(state, "seed_issues", `slot=${slot}: ${(e as Error).message}`);
      }
    }
    state.steps.seed_issues = { status: createdIssues.length > 0 ? "ok" : "error", created: createdIssues };
  } else if (!paperclipCompanyId) {
    state.steps.seed_issues = { status: "skipped", created: [], note: "no Paperclip company id" };
  } else {
    state.steps.seed_issues = { status: "ok", created: createdIssues, note: "already seeded; idempotent skip" };
  }

  // ── Step 3.5: seed the roadmap (bundle_workflows) ────────────────────
  // bundle_workflows are the cross-agent initiatives — the "roadmap of
  // tasks" the operator expects to see after inception. Each becomes one
  // issue assigned to its owner agent, tagged with the KPIs it moves and
  // the participating agents, so the fleet has concrete multi-agent
  // deliverables to drive, not just per-agent heartbeat loops.
  const roadmapCreated: string[] = state.steps.seed_roadmap.created ?? [];
  const bundleWorkflows = workflow.bundle_workflows ?? {};
  const bundleNames = Object.keys(bundleWorkflows);
  if (paperclipCompanyId && PAPERCLIP_URL && roadmapCreated.length === 0 && bundleNames.length > 0) {
    for (const bundleName of bundleNames) {
      const bw = bundleWorkflows[bundleName]!;
      const ownerSlot = bw.owner ?? "";
      const ownerAgentId = ownerSlot ? slotToPaperclipId.get(ownerSlot) : undefined;
      const title = `[Roadmap] ${bundleName.replace(/[._]/g, " ")}`;
      const body = [
        `Cross-agent initiative seeded by ignition v1.`,
        ``,
        `**Owner:** \`${ownerSlot || "unassigned"}\``,
        `**Cycle:** ${bw.cycle_length ?? "n/a"}`,
        `**KPIs this moves:** ${(bw.kpis_moved ?? []).join(", ") || "n/a"}`,
        `**Participating agents:** ${(bw.participating_agents ?? []).map((s) => `\`${s}\``).join(", ") || "n/a"}`,
        ``,
        `Owner: break this into concrete child issues, pull in the`,
        `participating agents, and drive the cycle. Grade against the KPIs above.`,
        ``,
        // OPERATIONAL_LAYER.md §1 — deliverable contract, parsed by the
        // Liaison's DELIVERABLE_LEDGER skill into a deliverable_ledger row.
        "```wavex-contract",
        `plan_ref: bundle:${bundleName}`,
        `expected_response: ${`Break into child issues, drive the ${bw.cycle_length ?? "stated"} cycle, move KPIs: ${(bw.kpis_moved ?? []).join(", ") || "n/a"}`.slice(0, 280)}`,
        "kind: directive",
        "```",
      ].join("\n");
      try {
        const resp = await paperclipFetch(`/api/companies/${paperclipCompanyId}/issues`, {
          method: "POST",
          body: JSON.stringify({
            title,
            description: body,
            ...(ownerAgentId ? { assigneeAgentId: ownerAgentId } : {}),
            goalId,
            priority: "high",
            tags: ["wavex:roadmap:v1", `wavex:bundle:${bundleName}`],
          }),
        });
        if (resp.ok) {
          const created = (await resp.json()) as { id?: string; key?: string };
          if (created.key) roadmapCreated.push(created.key);
          else if (created.id) roadmapCreated.push(created.id);
        } else {
          recordErr(state, "seed_roadmap", `bundle=${bundleName}: POST issues returned ${resp.status}`);
        }
      } catch (e) {
        recordErr(state, "seed_roadmap", `bundle=${bundleName}: ${(e as Error).message}`);
      }
    }
    state.steps.seed_roadmap = {
      status: roadmapCreated.length > 0 ? "ok" : "error",
      created: roadmapCreated,
    };
  } else if (!paperclipCompanyId) {
    state.steps.seed_roadmap = { status: "skipped", created: [], note: "no Paperclip company id" };
  } else if (bundleNames.length === 0) {
    state.steps.seed_roadmap = { status: "skipped", created: [], note: "workflow manifest has no bundle_workflows" };
  } else {
    state.steps.seed_roadmap = { status: "ok", created: roadmapCreated, note: "already seeded; idempotent skip" };
  }
  await writeState(state);

  // ── Step 4: CEO + CoS kickoff probe (best-effort) ────────────────────
  // The kickoff carries a real brief in `reason` — not just a bare wake.
  // Bug fixed here: the old code sent `wake_reason`, which isn't a field
  // wakeAgentSchema accepts ({ source, triggerDetail, reason, payload,
  // idempotencyKey, forceFreshSession }), so the context was silently
  // dropped by the validator. Now the agent's first run sees the goal,
  // the seeded issues, and the roadmap it's expected to drive.
  // The kickoff is the Kernel's FOUNDING PLANNING DIRECTIVE — not a bare
  // wake. It hands the CEO + Chief of Staff the manifest's goal, the seeded
  // work, and the roster, and tells them to convert the manifest into an
  // executable task roadmap. Without this run the fleet is "orphan from
  // planning": agents wake with nothing concrete to drive and just chatter.
  const g = (manifest as { goal?: { kpiId?: string; current?: number; target?: number; days?: number } }).goal;
  const goalLine = g?.kpiId
    ? `GOAL: move ${g.kpiId} from ${g.current ?? "?"} to ${g.target ?? "?"} within ${g.days ?? "?"} days.`
    : `GOAL: not set in the manifest — derive it from the company context and confirm it.`;
  const kickoffBrief = [
    `INCEPTION KICKOFF — your fleet just went live. You are the Kernel (CEO + Chief of Staff). This is your FOUNDING PLANNING RUN — the most important run this company will ever have.`,
    ``,
    goalLine,
    goalId ? `Paperclip goal id: ${goalId}.` : `(Paperclip goal object not created yet — create/confirm it as step 0.)`,
    ``,
    `Your manifest is already on disk as CONTEXT.md (company + your mandate)`,
    `and WORKFLOW.md (your heartbeat loop). Read them, then convert the`,
    `manifest into an EXECUTABLE PLAN:`,
    `  1. Decompose the goal into 3-5 KPI-targeted workstreams.`,
    `  2. For each workstream: name the owning role + the supporting roles.`,
    `  3. Sequence them — what unblocks what — and set the FIRST concrete`,
    `     deliverable for each, each with a measurement (not a vibe).`,
    `  4. Tell each role which tools / connectors to use for their work.`,
    createdIssues.length > 0
      ? `  Fold your first-cycle seed issues into the plan: ${createdIssues.join(", ")}.`
      : `  No per-agent seed issues exist yet — create them as part of the plan.`,
    roadmapCreated.length > 0
      ? `  You own coordination of these roadmap initiatives: ${roadmapCreated.join(", ")} — break each into child issues and pull in the agents they name.`
      : `  No roadmap initiatives were seeded — derive them from the manifest's bundle_workflows.`,
    ``,
    `OUTPUT of this run: the task roadmap, written as Paperclip issues with`,
    `owners + measurements, so every agent's next heartbeat has concrete work`,
    `aimed directly at the goal.`,
  ].join("\n");

  if (paperclipCompanyId && PAPERCLIP_URL && state.steps.kickoff_probe.status === "pending") {
    const ceoId = slotToPaperclipId.get("ceo.orchestrator");
    const cosId = slotToPaperclipId.get("ceo.chief-of-staff");
    const wakeBody = (label: string) => JSON.stringify({
      source: "automation",
      triggerDetail: "system",
      reason: `[${label}] ${kickoffBrief}`,
      payload: { seeded_issue_keys: createdIssues, roadmap_issue_keys: roadmapCreated, goal_id: goalId },
      idempotencyKey: `ignition-kickoff-${companyId}-${label}`,
    });
    if (ceoId) {
      try {
        const wake = await paperclipFetch(`/api/agents/${ceoId}/wakeup`, {
          method: "POST",
          body: wakeBody("CEO kickoff"),
        });
        state.steps.kickoff_probe.ceo_run_id = wake.ok ? "ok" : `err_${wake.status}`;
      } catch (e) {
        recordErr(state, "kickoff_probe", `CEO wake failed: ${(e as Error).message}`);
      }
    }
    if (cosId) {
      try {
        const wake = await paperclipFetch(`/api/agents/${cosId}/wakeup`, {
          method: "POST",
          body: wakeBody("CoS kickoff"),
        });
        state.steps.kickoff_probe.cos_run_id = wake.ok ? "ok" : `err_${wake.status}`;
      } catch (e) {
        recordErr(state, "kickoff_probe", `CoS wake failed: ${(e as Error).message}`);
      }
    }
    state.steps.kickoff_probe.status = ceoId && cosId ? "ok" : "error";
  }

  // ── Step 4.5: register the recurring 2-hour fleet follow-up ──────────
  // A one-shot kickoff isn't enough — the operator asked for a follow-up
  // every 2h. We register a Paperclip routine assigned to the CEO with a
  // schedule trigger. Each fire creates a fresh "fleet review" issue, so
  // the CEO re-assesses progress toward the goal on a fixed cadence
  // regardless of what individual agent heartbeats are doing.
  //
  // Cron is off-:00 (7 */2) so we don't pile onto every other fleet's
  // top-of-hour tick. Override via WAVEX_FOLLOWUP_CRON.
  if (
    paperclipCompanyId && PAPERCLIP_URL &&
    state.steps.kickoff_routine.status === "pending"
  ) {
    const ceoId = slotToPaperclipId.get("ceo.orchestrator");
    const followupCron = process.env.WAVEX_FOLLOWUP_CRON ?? "7 */2 * * *";
    try {
      const routineResp = await paperclipFetch(`/api/companies/${paperclipCompanyId}/routines`, {
        method: "POST",
        body: JSON.stringify({
          title: "Fleet follow-up — every 2h",
          description: [
            `Recurring fleet review seeded by wavex-os ignition.`,
            ``,
            `Each fire: re-read the goal${goalId ? ` (${goalId})` : ""}, check progress`,
            `on the seeded + roadmap issues, course-correct, and re-assign or`,
            `escalate anything stalled. Keep it tight — this is a pulse check,`,
            `not a full re-plan.`,
          ].join("\n"),
          ...(goalId ? { goalId } : {}),
          ...(ceoId ? { assigneeAgentId: ceoId } : {}),
          priority: "high",
          status: "active",
          concurrencyPolicy: "coalesce_if_active",
          catchUpPolicy: "skip_missed",
        }),
      });
      if (!routineResp.ok) {
        recordErr(state, "kickoff_routine", `routine POST returned ${routineResp.status}`);
        state.steps.kickoff_routine = { status: "error", note: `routine POST ${routineResp.status}` };
      } else {
        const routine = (await routineResp.json()) as { id: string };
        state.steps.kickoff_routine.routine_id = routine.id;
        // Attach the schedule trigger.
        const trigResp = await paperclipFetch(`/api/routines/${routine.id}/triggers`, {
          method: "POST",
          body: JSON.stringify({
            kind: "schedule",
            label: "every 2h",
            cronExpression: followupCron,
            timezone: process.env.WAVEX_FOLLOWUP_TZ ?? "UTC",
            enabled: true,
          }),
        });
        if (!trigResp.ok) {
          recordErr(state, "kickoff_routine", `trigger POST returned ${trigResp.status}`);
          state.steps.kickoff_routine = {
            status: "error",
            routine_id: routine.id,
            note: `routine created but trigger POST ${trigResp.status}`,
          };
        } else {
          const trigger = (await trigResp.json()) as { id: string };
          state.steps.kickoff_routine = {
            status: "ok",
            routine_id: routine.id,
            trigger_id: trigger.id,
            note: `cron=${followupCron}`,
          };
        }
      }
    } catch (e) {
      recordErr(state, "kickoff_routine", `${(e as Error).message}`);
      state.steps.kickoff_routine = { status: "error", note: (e as Error).message };
    }
  } else if (!paperclipCompanyId) {
    state.steps.kickoff_routine = { status: "skipped", note: "no Paperclip company id" };
  }
  await writeState(state);

  // ── Step 4c: middleware supervisor charter (silent agent) ─────────────
  // The Chief of Staff becomes the in-fleet MIDDLEWARE agency from minute
  // one: it enforces meta-prompt hygiene (DEFER-UNTIL cadence, no duplicate
  // titles, revenue-proximate priorities, evidence-cited claims), watches
  // the run governor tier, and acts as the inference-hook fixer target.
  // Previously this charter had to be filed and assigned by a human after
  // every onboarding (observed 2026-06-10) — now ignition installs it.
  {
    const cosAgentId = slotToPaperclipId.get("ceo.chief-of-staff");
    if (paperclipCompanyId && cosAgentId) {
      try {
        const charterResp = await paperclipFetch(`/api/companies/${paperclipCompanyId}/issues`, {
          method: "POST",
          body: JSON.stringify({
            title: "MIDDLEWARE: Fleet supervisor charter — Chief of Staff owns in-flight integrity",
            description: [
              "You are the middleware agency between the platform and this fleet — silent by",
              "design: you work through issue operations and prompt enforcement, not chatter.",
              "",
              "Cycle (repeat; file the next cycle as backlog with a top line",
              "'DEFER-UNTIL: <ISO timestamp +24h>'):",
              "1. GOVERNOR: GET http://localhost:3100/api/governor/status — record tier +",
              "   utilization in your cycle comment. At conserve or worse, verify only",
              "   high/critical issues are in_progress; defer or downgrade the rest.",
              "2. HOOKS: when woken with reason '[inference-hook] …', diagnose the named",
              "   failure (GET /api/heartbeat-runs/{runId}), apply the smallest safe fix or",
              "   file ONE issue to the right owner. Never blindly retry the failed action.",
              "3. META-PROMPTS: enforce on every agent — next-cycle issues carry DEFER-UNTIL;",
              "   never file duplicate titles (the API returns 409 — comment on the existing",
              "   issue); priorities reflect revenue proximity; claims cite evidence.",
              "4. GRADING: grade closed cycles A–F against their stated acceptance criteria",
              "   in a weekly digest on YOUR issue (never comment on done issues).",
              "STOP: platform unreachable 2 consecutive cycles, or the operator posts STOP.",
            ].join("\n"),
            assigneeAgentId: cosAgentId,
            priority: "high",
            status: "todo",
          }),
        });
        if (!charterResp.ok) {
          recordErr(state, "middleware_charter", `POST issues returned ${charterResp.status}`);
          state.steps.middleware_charter = { status: "error", note: `POST ${charterResp.status}` };
        } else {
          const charter = (await charterResp.json()) as { id: string; identifier?: string };
          state.steps.middleware_charter = {
            status: "ok",
            note: charter.identifier ?? charter.id,
          };
        }
      } catch (e) {
        recordErr(state, "middleware_charter", (e as Error).message);
        state.steps.middleware_charter = { status: "error", note: (e as Error).message };
      }
    } else {
      state.steps.middleware_charter = {
        status: "skipped",
        note: paperclipCompanyId ? "no chief-of-staff slot" : "no Paperclip company id",
      };
    }
  }
  await writeState(state);

  // ── Step 5: validate L·IV coverage ────────────────────────────────────
  const gaps: string[] = [];
  for (const agent of nonMuted) {
    if (!slotToPaperclipId.has(agent.slot)) gaps.push(agent.slot);
  }
  state.steps.validate_coverage = { status: gaps.length === 0 ? "ok" : "error", gaps };
  if (gaps.length > 0) {
    state.warnings.push(`L·IV coverage gaps: ${gaps.join(", ")}`);
  }

  // ── Step 6: heartbeat offsets ────────────────────────────────────────
  // As of 2026-05-14, heartbeats are enabled AT HIRE TIME in
  // paperclip-handoff.ts (heartbeatConfigForSlot) — `enabled: true` with a
  // per-slot jittered intervalSec. The old "deferred to G.3.b" note is
  // resolved: we no longer need a PATCH endpoint because the hire payload
  // carries the final runtimeConfig.heartbeat. This step now just records
  // the computed offsets for observability — the actual staggering lives
  // in the hire payload's intervalSec jitter.
  const offsets: Record<string, number> = {};
  for (const agent of nonMuted) offsets[agent.slot] = hashSlotToOffset(agent.slot);
  state.steps.stagger_heartbeats = {
    status: "ok",
    offsets,
    note: "heartbeats enabled at hire time (paperclip-handoff heartbeatConfigForSlot); offsets here are observability-only",
  };

  // ── Finalize ─────────────────────────────────────────────────────────
  const allOk = Object.values(state.steps).every((s) => s.status === "ok" || s.status === "skipped");
  state.completed_at = allOk ? new Date().toISOString() : null;
  await writeState(state);

  return {
    status: allOk
      ? (state.warnings.length > 0 ? "partial" : "ignited")
      : (state.steps.workflow_load.status === "error" ? "deferred" : "partial"),
    agents_working: nonMuted.length - gaps.length,
    workflows_queued: createdIssues.length + roadmapCreated.length,
    goal_id: goalId,
    errors: state.errors,
    warnings: state.warnings,
    ignition_state_path: ignitionStatePath(companyId),
  };
}
