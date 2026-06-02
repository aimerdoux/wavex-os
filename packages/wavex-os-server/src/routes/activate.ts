/** POST /api/instance/:companyId/activate
 *
 *  Loads the signed company.manifest.json from disk and runs `bridgeAgents`
 *  to materialize the swarm topology + companies row into the wavex DB.
 *  This is the seam where wizard output becomes runtime state.
 *
 *  Idempotent: re-calling against the same companyId after a refinement
 *  upserts cleanly (deterministic agent ids). */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import yaml from "js-yaml";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { computeManifestHash, type CompanyManifest } from "@wavex-os/plugin-onboarding";
import { assertBoard, assertCompanyAccess, AuthError } from "@wavex-os/auth-shim";
import { getDb, runMigrations } from "@wavex-os/db";
import { getOnboardingDir } from "../state-bridge.js";
import { bridgeAgents, bridgeKpis } from "../bridge/finalize-bridge.js";
import { handoffToPaperclip, rerenderBundlesForCompany } from "../bridge/paperclip-handoff.js";
import { ignite } from "../bridge/ignition.js";

function authReq(req: FastifyRequest) {
  return { method: req.method, headers: req.headers as Record<string, string> };
}

let migrationsRun = false;
async function ensureMigrations(): Promise<void> {
  if (migrationsRun) return;
  await runMigrations();
  migrationsRun = true;
}

/** Best-effort sync of the finalized, signed manifest to Supabase
 *  (wavex_os.company_manifests) so it stops being local-disk-only and a
 *  cross-device story becomes possible. The wavex_os schema is not
 *  REST-exposed, so this goes through the service-role SECURITY DEFINER RPC
 *  `wavex_os_record_company_manifest` (keyed on company_id, idempotent).
 *
 *  Best-effort: any failure (missing env, network, RPC error) is logged and
 *  swallowed — it must NEVER fail activate. The manifest is already safely
 *  on disk by the time this runs. */
async function syncManifestToCloud(
  companyId: string,
  manifest: CompanyManifest,
  manifestSha256: string,
): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.warn(
      `[activate] manifest cloud-sync skipped for ${companyId}: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set`,
    );
    return;
  }
  // goal / finalized_at / signed_at are wavex-layered sidecar fields (not on
  // the upstream CompanyManifest type) — read defensively via a cast.
  const m = manifest as unknown as {
    goal?: { kpiId?: string; current?: number; target?: number; days?: number };
    finalized_at?: string;
    signed_at?: string;
  };
  try {
    const res = await fetch(`${url}/rest/v1/rpc/wavex_os_record_company_manifest`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: key,
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        p_company_id: companyId,
        p_manifest: manifest,
        p_manifest_sha256: manifestSha256,
        p_goal: m.goal ?? null,
        p_finalized_at: m.finalized_at ?? null,
        p_signed_at: m.signed_at ?? null,
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(
        `[activate] manifest cloud-sync failed for ${companyId}: ${res.status} ${res.statusText} ${detail}`,
      );
      return;
    }
    console.log(`[activate] manifest cloud-synced for ${companyId} (sha ${manifestSha256.slice(0, 12)})`);
  } catch (e) {
    console.error(
      `[activate] manifest cloud-sync error for ${companyId}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/** Best-effort Telegram alert when a company activates but ignition leaves
 *  it planning-orphaned. The operator MUST know — the fleet looks live but
 *  has no goal / roadmap / kickoff, so the agents wake with nothing to
 *  drive. This used to slip by as a soft "deferred" status. Never throws. */
async function alertIgnitionOrphaned(companyId: string, detail: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN ?? process.env.WAVEX_OPS_TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID ?? process.env.WAVEX_OPS_TELEGRAM_CHAT_ID;
  if (!token || !chat) return;
  const text = [
    `⚠️ *WaveX — ignition orphaned*`,
    `Company \`${companyId}\` activated and agents were hired — but ignition did not plan it.`,
    `The fleet has no goal / roadmap / kickoff. Detail: ${detail}`,
    `Re-run planning: POST /api/instance/${companyId}/ignite`,
  ].join("\n");
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chat,
      text,
      parse_mode: "Markdown",
      disable_web_page_preview: true,
    }),
  });
}

export function registerActivateRoute(app: FastifyInstance): void {
  // GET /api/instance/:companyId/handoff-status — polled by ActivateProgress
  // during /activate so the UI can paint per-slot hires in real time.
  // Returns the current handoff-progress.json (written by paperclip-handoff.ts
  // after each hire) or null when no handoff is in flight / complete.
  app.get("/api/instance/:companyId/handoff-status", async (req, reply) => {
    const ar = authReq(req);
    try { assertBoard(ar); } catch (e) {
      if (e instanceof AuthError) return reply.status(e.statusCode).send({ error: e.message });
      throw e;
    }
    const { companyId } = req.params as { companyId: string };
    assertCompanyAccess(ar, companyId);
    try {
      const path = join(getOnboardingDir(companyId), "..", "handoff-progress.json");
      const raw = await readFile(path, "utf8");
      return { ok: true, progress: JSON.parse(raw) };
    } catch {
      return { ok: true, progress: null };
    }
  });

  app.post("/api/instance/:companyId/activate", async (req, reply) => {
    const ar = authReq(req);
    try { assertBoard(ar); } catch (e) {
      if (e instanceof AuthError) return reply.status(e.statusCode).send({ error: e.message });
      throw e;
    }
    const { companyId } = req.params as { companyId: string };
    assertCompanyAccess(ar, companyId);

    let manifest: CompanyManifest;
    try {
      const path = join(getOnboardingDir(companyId), "company.manifest.json");
      const raw = await readFile(path, "utf8");
      manifest = JSON.parse(raw) as CompanyManifest;
    } catch {
      return reply.status(404).send({
        ok: false,
        error: "manifest not found — finalize the wizard first",
        companyId,
      });
    }

    try {
      await ensureMigrations();
      const db = await getDb();
      const result = await bridgeAgents(manifest, companyId, db);
      const kpiResult = await bridgeKpis(manifest, companyId, db);
      result.kpis = kpiResult.kpis;

      // bridgeAgents mutated the manifest with template_selections (rationale
      // for each matrix pick). Persist back to disk + re-sign so the dashboard
      // can surface it and the audit trail is honest about the matrix's choices.
      const dir = getOnboardingDir(companyId);
      const newHash = computeManifestHash(manifest);
      manifest.signatures = { ...manifest.signatures, manifest_hash: newHash };
      await writeFile(join(dir, "company.manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
      await writeFile(join(dir, "company.manifest.yaml"), yaml.dump(manifest), "utf8");

      // Best-effort cloud sync — the manifest is now safely on disk; mirror it
      // to wavex_os.company_manifests so it's no longer local-disk-only. Never
      // fails activate (see syncManifestToCloud).
      await syncManifestToCloud(companyId, manifest, newHash);

      // Best-effort activation tracking — fires user_signed_up event for the
      // WS3 activation funnel. Uses companyId as user_id for CLI installs
      // (no traditional auth). Idempotent: duplicate rows are harmless since
      // user_activated has the unique constraint (not user_signed_up).
      void (async () => {
        const supaUrl = process.env.SUPABASE_URL;
        const supaKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
        if (!supaUrl || !supaKey) return;
        try {
          await fetch(`${supaUrl}/rest/v1/wavex_os.product_activation_events`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Prefer: "return=minimal",
              apikey: supaKey,
              Authorization: `Bearer ${supaKey}`,
            },
            body: JSON.stringify({
              company_id: companyId,
              user_id: companyId,
              event_type: "user_signed_up",
              occurred_at: new Date().toISOString(),
              payload: { source: "activate" },
            }),
          });
        } catch {
          // intentionally swallowed — must never fail activate
        }
      })();

      // Phase D — opt-in handoff to a running Paperclip instance. When
      // PAPERCLIP_HANDOFF_URL is set, the C-Suite is mirrored as real
      // Paperclip agents so they get heartbeats + claude CLI execution.
      // When unset, this is a no-op and bridgeAgents-only is the contract.
      //
      // Re-run auto-detection on each activate — if Paperclip wasn't running
      // when wavex booted but is up now, detection picks it up here and the
      // handoff fires. Self-heals without requiring a wavex restart.
      const { detectAndConfigurePaperclip } = await import("../lib/paperclip-detect.js");
      await detectAndConfigurePaperclip();

      // G1 — quota pre-flight. Spawning the full C-Suite as live Paperclip
      // agents means N concurrent claude heartbeats. If the model bucket
      // the fleet uses is already exhausted, every one of those fails with
      // "You've hit your <model> limit" (observed 2026-05-19: 35 agents →
      // 50 doomed runs). The DB bridge above already ran (agents exist +
      // are recoverable), so we gate ONLY the live handoff: probe the
      // fleet model with a 1-token canary, and if it's a hard ceiling,
      // skip the spawn and tell the operator when it resets. Opt out with
      // WAVEX_AGENT_QUOTA_PREFLIGHT=0. Transient 429s do NOT block — the
      // heartbeat retry/backoff handles those.
      // Halts on a hard quota ceiling ("exhausted") OR an auth/login failure
      // ("auth_failed") — the latter caused 91% of the 2026-05-27 storm and is
      // model-agnostic, so it must gate the spawn too.
      let quotaSkip: { model: string; detail: string; resetHint: string | null; state: "exhausted" | "auth_failed" } | null = null;
      if (process.env.WAVEX_AGENT_QUOTA_PREFLIGHT !== "0") {
        const { probeClaudeQuota, fleetAgentModel } = await import("../lib/claude-quota-preflight.js");
        const model = fleetAgentModel();
        const probe = await probeClaudeQuota(model).catch(() => null);
        if (probe?.state === "exhausted" || probe?.state === "auth_failed") {
          quotaSkip = { model, detail: probe.detail, resetHint: probe.resetHint, state: probe.state };
        }
      }

      const handoff = quotaSkip
        ? {
            enabled: true,
            paperclipUrl: process.env.PAPERCLIP_HANDOFF_URL ?? null,
            paperclipCompanyId: null,
            created: [],
            skipped: [],
            errors: [{
              slot: "<quota-preflight>",
              message:
                quotaSkip.state === "auth_failed"
                  ? `Live agent handoff skipped — ${quotaSkip.detail}. Agents are hired in the DB and recoverable; ` +
                    `fix the Claude login (run \`claude /login\` / re-auth the keychain wrapper) and re-run activate. ` +
                    `Set WAVEX_AGENT_QUOTA_PREFLIGHT=0 to bypass this check.`
                  : `Live agent handoff skipped — ${quotaSkip.detail}. Agents are hired in the DB and recoverable; ` +
                    `re-run activate once quota resets, or set WAVEX_AGENT_MODEL to a model with headroom ` +
                    `(e.g. opus) and retry. Set WAVEX_AGENT_QUOTA_PREFLIGHT=0 to bypass this check.`,
            }],
          }
        : await handoffToPaperclip(manifest, companyId).catch((e) => ({
        enabled: true,
        paperclipUrl: process.env.PAPERCLIP_HANDOFF_URL ?? null,
        paperclipCompanyId: null,
        created: [],
        skipped: [],
        errors: [{ slot: "<bootstrap>", message: e instanceof Error ? e.message : String(e) }],
      }));

      // Phase G — Ignition. Does NOT fail activate (the agents are hired
      // and recoverable) — but a failed/deferred ignition leaves the fleet
      // ORPHAN FROM PLANNING: no goal object, no seeded roadmap, no
      // kickoff. That used to slip by silently as a soft "deferred". It
      // must not. See docs/IGNITION.md.
      const ignition = await ignite(manifest, companyId, handoff).catch((e) => ({
        status: "deferred" as const,
        agents_working: 0,
        workflows_queued: 0,
        goal_id: null,
        errors: [{ step: "<bootstrap>", message: e instanceof Error ? e.message : String(e), ts: new Date().toISOString() }],
        warnings: [],
        ignition_state_path: "",
      }));

      // A planned fleet HAS a goal object. No goal_id (or any errors) means
      // the company is planning-orphaned — surface it LOUDLY, never silently.
      const ignitionOrphaned =
        !ignition.goal_id || (ignition.errors?.length ?? 0) > 0;
      if (ignitionOrphaned) {
        const detail =
          (ignition.errors ?? []).map((er) => `${er.step}: ${er.message}`).join("; ") ||
          "ignition produced no goal object";
        console.error(
          `[activate] IGNITION ORPHANED — company ${companyId}: agents hired but the fleet is unplanned. ${detail}`,
        );
        await alertIgnitionOrphaned(companyId, detail).catch(() => {});
      }

      return {
        ok: true,
        inserted: { companies: result.companies, agents: result.agents, kpis: result.kpis },
        warnings: result.warnings,
        sha256: newHash,
        paperclipHandoff: handoff,
        ignition,
        ignition_orphaned: ignitionOrphaned,
      };
    } catch (e) {
      return reply.status(500).send({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  });

  // Standalone re-ignite endpoint for partial-recovery: operator clicks
  // "Ignite Fleet" in Mission Control when a prior activate's ignition
  // step deferred/failed and they want to retry.
  app.post("/api/instance/:companyId/ignite", async (req, reply) => {
    const ar = authReq(req);
    try { assertBoard(ar); } catch (e) {
      if (e instanceof AuthError) return reply.status(e.statusCode).send({ error: e.message });
      throw e;
    }
    const { companyId } = req.params as { companyId: string };
    assertCompanyAccess(ar, companyId);

    let manifest: CompanyManifest;
    try {
      const path = join(getOnboardingDir(companyId), "company.manifest.json");
      const raw = await readFile(path, "utf8");
      manifest = JSON.parse(raw) as CompanyManifest;
    } catch {
      return reply.status(404).send({ ok: false, error: "manifest not found" });
    }

    // Read the PERSISTED handoff state from paperclip-handoff.json — it
    // carries the real, verified paperclipUrl + paperclipCompanyId + agent
    // map. Re-running handoffToPaperclip() depended on PAPERCLIP_HANDOFF_URL
    // being in the process env, which it often is NOT (and isn't in the
    // standalone /ignite path) — so ignition's Paperclip steps silently
    // skipped and the company stayed orphan-from-planning. Only fall back to
    // re-running handoff when there's no persisted file.
    let handoff: Awaited<ReturnType<typeof handoffToPaperclip>>;
    try {
      const hp = join(getOnboardingDir(companyId), "..", "paperclip-handoff.json");
      const j = JSON.parse(await readFile(hp, "utf8")) as {
        paperclipUrl?: string;
        paperclipCompanyId?: string;
        agents?: Record<string, string>;
      };
      handoff = {
        enabled: true,
        paperclipUrl: j.paperclipUrl ?? process.env.PAPERCLIP_HANDOFF_URL ?? null,
        paperclipCompanyId: j.paperclipCompanyId ?? null,
        // The persisted handoff.json records agents as { slot: agentId } — if
        // it's on disk, the agent was hired, so status is "spawned".
        created: Object.entries(j.agents ?? {}).map(([slot, agentId]) => ({
          slot,
          agentId,
          status: "spawned",
        })),
        skipped: [],
        errors: [],
      } as Awaited<ReturnType<typeof handoffToPaperclip>>;
    } catch {
      // No persisted handoff — fall back to re-running it (idempotent).
      handoff = await handoffToPaperclip(manifest, companyId).catch((e) => ({
        enabled: true,
        paperclipUrl: process.env.PAPERCLIP_HANDOFF_URL ?? null,
        paperclipCompanyId: null,
        created: [],
        skipped: [],
        errors: [{ slot: "<bootstrap>", message: e instanceof Error ? e.message : String(e) }],
      })) as Awaited<ReturnType<typeof handoffToPaperclip>>;
    }

    const ignition = await ignite(manifest, companyId, handoff);
    return reply.send({ ok: true, ignition });
  });

  // Force-rerender AGENTS.md / CONTEXT.md / WORKFLOW.md on disk for every
  // already-mapped agent in this wavex company. Used to refresh fleets that
  // were hired before the manifest-driven CEO bundle / overlay rewrite —
  // activate's handoff path skips already-mapped slots, so the files on disk
  // need an out-of-band refresh.
  app.post("/api/instance/:companyId/rerender-bundles", async (req, reply) => {
    const ar = authReq(req);
    try { assertBoard(ar); } catch (e) {
      if (e instanceof AuthError) return reply.status(e.statusCode).send({ error: e.message });
      throw e;
    }
    const { companyId } = req.params as { companyId: string };
    assertCompanyAccess(ar, companyId);
    try {
      const paperclipUrl = process.env.PAPERCLIP_HANDOFF_URL ?? "http://127.0.0.1:3100";
      const report = await rerenderBundlesForCompany(companyId, paperclipUrl, null);
      return reply.send({ ok: true, ...report });
    } catch (e) {
      return reply.status(500).send({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  });
}
