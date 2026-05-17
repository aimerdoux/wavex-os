/**
 * WaveX plugin worker.
 *
 * Registers four data handlers consumed by the UI bundles:
 *
 *   - expert-agents-list  → { agents: Array<{id, displayName, activeHires}> }
 *   - deliverables-list   → { deliverables: Array<{assignedAgent, planRef, ...}> }
 *   - inception-status    → { agentsTotal, agentsReady, finalizedAt, goalKpiId }
 *   - subscription-info   → { tier, status, currentPeriodEnd, expertAgentsHired }
 *
 * Data sources, in order of preference:
 *
 *   1. wavex-os op-omega-server (default http://127.0.0.1:3101) — fetches
 *      finalized manifest + handoff state. Works on the customer's local
 *      install OR an operator-side deployment.
 *
 *   2. Supabase RPCs (wavex_os_ops_*) — only when supabaseUrl +
 *      supabasePublishableKey are configured. Provides cross-customer
 *      aggregates (catalog hires) that the local server can't see alone.
 *
 * No writes. No third-party HTTP. The plugin is intentionally read-only —
 * any state-changing action requires the operator to use Paperclip's
 * native flows (issue creation, agent commands, etc.) so the plugin can
 * never get out of sync with the host.
 */
import { definePlugin, runWorker } from "@wavex-os/plugin-sdk-shim";

interface PluginConfig {
  wavexApiBase?: string;
  supabaseUrl?: string;
  supabasePublishableKey?: string;
}

const DEFAULT_WAVEX_BASE = "http://127.0.0.1:3101";

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("WaveX plugin worker starting");

    // -------------------------------------------------------------------
    // expert-agents-list — reads catalog + hire counts from Supabase RPC
    //   (falls back to an empty list when supabase config is absent).
    // -------------------------------------------------------------------
    ctx.data.register("expert-agents-list", async () => {
      const cfg = (await ctx.config.get()) as PluginConfig | null;
      if (!cfg?.supabaseUrl || !cfg.supabasePublishableKey) {
        return { agents: [], source: "no-supabase-config" };
      }
      try {
        const r = await ctx.http.fetch(
          `${cfg.supabaseUrl}/rest/v1/rpc/wavex_os_ops_catalog_hire_counts`,
          {
            method: "POST",
            headers: {
              apikey: cfg.supabasePublishableKey,
              Authorization: `Bearer ${cfg.supabasePublishableKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({}),
          },
        );
        if (!r.ok) {
          ctx.logger.warn("ops_catalog_hire_counts RPC failed", { status: r.status });
          return { agents: [], source: "rpc-failed", status: r.status };
        }
        type Row = { catalog_id: string; display_name: string; active_hires: number };
        const data = (await r.json()) as Row[];
        return {
          agents: data.map((row) => ({
            id: row.catalog_id,
            displayName: row.display_name,
            activeHires: row.active_hires,
          })),
          source: "supabase",
        };
      } catch (err) {
        ctx.logger.error("expert-agents-list handler crashed", { err: String(err) });
        return { agents: [], source: "exception", error: String(err) };
      }
    });

    // -------------------------------------------------------------------
    // deliverables-list — recent deliverable_ledger rows from Supabase RPC
    //   (falls back to an empty list when supabase config is absent).
    // -------------------------------------------------------------------
    ctx.data.register("deliverables-list", async () => {
      const cfg = (await ctx.config.get()) as PluginConfig | null;
      if (!cfg?.supabaseUrl || !cfg.supabasePublishableKey) {
        return { deliverables: [], source: "no-supabase-config" };
      }
      try {
        const r = await ctx.http.fetch(
          `${cfg.supabaseUrl}/rest/v1/rpc/wavex_os_ops_deliverable_summary`,
          {
            method: "POST",
            headers: {
              apikey: cfg.supabasePublishableKey,
              Authorization: `Bearer ${cfg.supabasePublishableKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({}),
          },
        );
        if (!r.ok) {
          ctx.logger.warn("ops_deliverable_summary RPC failed", { status: r.status });
          return { deliverables: [], source: "rpc-failed", status: r.status };
        }
        type Row = {
          id: string;
          assigned_agent: string | null;
          plan_ref: string | null;
          expected_response: string | null;
          kind: string;
          status: string;
          issue_id: string | null;
          total_tokens: number;
        };
        const data = (await r.json()) as Row[];
        return {
          deliverables: data.map((row) => ({
            id: row.id,
            assignedAgent: row.assigned_agent,
            planRef: row.plan_ref,
            expectedResponse: row.expected_response,
            kind: row.kind,
            status: row.status,
            issueId: row.issue_id,
            totalTokens: row.total_tokens,
          })),
          source: "supabase",
        };
      } catch (err) {
        ctx.logger.error("deliverables-list handler crashed", { err: String(err) });
        return { deliverables: [], source: "exception", error: String(err) };
      }
    });

    // -------------------------------------------------------------------
    // company-goals — Mission Control goal/KPI progress from the
    //   wavex_os_ops_company_goals RPC (current → target per goal).
    //   Empty list when supabase config absent or no manifests provisioned.
    // -------------------------------------------------------------------
    ctx.data.register("company-goals", async () => {
      const cfg = (await ctx.config.get()) as PluginConfig | null;
      if (!cfg?.supabaseUrl || !cfg.supabasePublishableKey) {
        return { goals: [], source: "no-supabase-config" };
      }
      try {
        const r = await ctx.http.fetch(
          `${cfg.supabaseUrl}/rest/v1/rpc/wavex_os_ops_company_goals`,
          {
            method: "POST",
            headers: {
              apikey: cfg.supabasePublishableKey,
              Authorization: `Bearer ${cfg.supabasePublishableKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({}),
          },
        );
        if (!r.ok) {
          ctx.logger.warn("ops_company_goals RPC failed", { status: r.status });
          return { goals: [], source: "rpc-failed", status: r.status };
        }
        type Row = {
          company_id: string;
          goal_id: string;
          label: string;
          metric: string;
          current_value: number | null;
          target_value: number | null;
          unit: string;
          status: string;
        };
        const data = (await r.json()) as Row[];
        return {
          goals: data.map((row) => ({
            id: `${row.company_id}:${row.goal_id}`,
            label: row.label,
            metric: row.metric,
            current: row.current_value ?? 0,
            target: row.target_value ?? 0,
            unit: row.unit,
            status: row.status,
          })),
          source: "supabase",
        };
      } catch (err) {
        ctx.logger.error("company-goals handler crashed", { err: String(err) });
        return { goals: [], source: "exception", error: String(err) };
      }
    });

    // -------------------------------------------------------------------
    // deliverable-throughput — same RPC as deliverables-list, but the worker
    //   pre-aggregates: count by status + total token cost. Keeps the chart
    //   widget render cheap (no client-side reduce over 50 rows each tick).
    // -------------------------------------------------------------------
    ctx.data.register("deliverable-throughput", async () => {
      const cfg = (await ctx.config.get()) as PluginConfig | null;
      if (!cfg?.supabaseUrl || !cfg.supabasePublishableKey) {
        return { byStatus: {}, totalTokens: 0, total: 0, source: "no-supabase-config" };
      }
      try {
        const r = await ctx.http.fetch(
          `${cfg.supabaseUrl}/rest/v1/rpc/wavex_os_ops_deliverable_summary`,
          {
            method: "POST",
            headers: {
              apikey: cfg.supabasePublishableKey,
              Authorization: `Bearer ${cfg.supabasePublishableKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({}),
          },
        );
        if (!r.ok) {
          ctx.logger.warn("ops_deliverable_summary RPC failed (throughput)", {
            status: r.status,
          });
          return { byStatus: {}, totalTokens: 0, total: 0, source: "rpc-failed", status: r.status };
        }
        type Row = { status: string; total_tokens: number };
        const data = (await r.json()) as Row[];
        const byStatus: Record<string, number> = {};
        let totalTokens = 0;
        for (const row of data) {
          byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
          totalTokens += Number(row.total_tokens ?? 0);
        }
        return { byStatus, totalTokens, total: data.length, source: "supabase" };
      } catch (err) {
        ctx.logger.error("deliverable-throughput handler crashed", { err: String(err) });
        return {
          byStatus: {},
          totalTokens: 0,
          total: 0,
          source: "exception",
          error: String(err),
        };
      }
    });

    // -------------------------------------------------------------------
    // fleet-agent-status — running/idle/error agent counts aggregated from
    //   the wavex_os_ops_fleet_health RPC (sums across all reporting devices).
    //   The RPC exposes agent_count + agents_error; agents_running/agents_idle
    //   are read opportunistically (forward-compat) and otherwise derived:
    //   running ≈ devices reporting a "running" fleet_status, idle = rest.
    // -------------------------------------------------------------------
    ctx.data.register("fleet-agent-status", async () => {
      const cfg = (await ctx.config.get()) as PluginConfig | null;
      if (!cfg?.supabaseUrl || !cfg.supabasePublishableKey) {
        return {
          running: 0,
          idle: 0,
          error: 0,
          devices: 0,
          source: "no-supabase-config",
        };
      }
      try {
        const r = await ctx.http.fetch(
          `${cfg.supabaseUrl}/rest/v1/rpc/wavex_os_ops_fleet_health`,
          {
            method: "POST",
            headers: {
              apikey: cfg.supabasePublishableKey,
              Authorization: `Bearer ${cfg.supabasePublishableKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({}),
          },
        );
        if (!r.ok) {
          ctx.logger.warn("ops_fleet_health RPC failed (agent-status)", {
            status: r.status,
          });
          return {
            running: 0,
            idle: 0,
            error: 0,
            devices: 0,
            source: "rpc-failed",
            status: r.status,
          };
        }
        type Row = {
          fleet_status: string | null;
          agent_count: number | null;
          agents_error: number | null;
          agents_idle?: number | null;
          agents_running?: number | null;
        };
        const data = (await r.json()) as Row[];
        let running = 0;
        let idle = 0;
        let errored = 0;
        for (const row of data) {
          const total = Number(row.agent_count ?? 0);
          const errc = Number(row.agents_error ?? 0);
          errored += errc;
          if (row.agents_running != null || row.agents_idle != null) {
            // Forward-compat: RPC gained explicit running/idle columns.
            const runc = Number(row.agents_running ?? 0);
            running += runc;
            idle +=
              row.agents_idle != null
                ? Number(row.agents_idle)
                : Math.max(0, total - errc - runc);
          } else {
            // Today's RPC: split the device's non-errored agents by whether
            // the device's fleet_status reads as actively running.
            const healthy = Math.max(0, total - errc);
            if ((row.fleet_status ?? "").toLowerCase().includes("run")) {
              running += healthy;
            } else {
              idle += healthy;
            }
          }
        }
        return {
          running,
          idle,
          error: errored,
          devices: data.length,
          source: "supabase",
        };
      } catch (err) {
        ctx.logger.error("fleet-agent-status handler crashed", { err: String(err) });
        return {
          running: 0,
          idle: 0,
          error: 0,
          devices: 0,
          source: "exception",
          errorMessage: String(err),
        };
      }
    });

    // -------------------------------------------------------------------
    // Mission Control — initial activity fetch + scope-tree + KPI catalog.
    //   Backs `usePluginData("mission-control-activity")` in the Stream
    //   widget. Returns one bundle so the widget can build its RenderContext
    //   in a single round-trip (no chained fetches).
    // -------------------------------------------------------------------
    ctx.data.register("mission-control-activity", async ({ companyId }) => {
      const cfg = (await ctx.config.get()) as PluginConfig | null;
      const base = cfg?.wavexApiBase ?? DEFAULT_WAVEX_BASE;
      const id = String(companyId ?? "");
      if (!id) {
        return {
          ok: false,
          events: [],
          scopeNodes: [],
          kpis: [],
          mode: "solo_founder" as const,
          source: "no-company",
        };
      }
      try {
        const [actRes, treeRes] = await Promise.all([
          ctx.http.fetch(
            `${base}/api/mission-control/${encodeURIComponent(id)}/activity?limit=200`,
          ),
          ctx.http.fetch(
            `${base}/api/mission-control/${encodeURIComponent(id)}/scope-tree`,
          ),
        ]);
        const actBody = (await actRes.json().catch(() => ({}))) as {
          ok?: boolean;
          events?: unknown[];
          error?: string;
        };
        const treeBody = (await treeRes.json().catch(() => ({}))) as {
          ok?: boolean;
          tree?: {
            mode?: string;
            nodes?: Array<{
              id: string;
              kind: string;
              name: string;
              parentId?: string;
              childIds?: string[];
            }>;
            kpis?: Array<{ id: string; name: string }>;
          };
        };
        return {
          ok: actBody.ok !== false,
          events: Array.isArray(actBody.events) ? actBody.events : [],
          scopeNodes: treeBody.tree?.nodes ?? [],
          kpis: treeBody.tree?.kpis ?? [],
          mode: (treeBody.tree?.mode as "solo_founder" | "avatar" | "hybrid") ??
            "solo_founder",
          source: "wavex-api",
        };
      } catch (err) {
        return {
          ok: false,
          events: [],
          scopeNodes: [],
          kpis: [],
          mode: "solo_founder" as const,
          source: "exception",
          error: String(err),
        };
      }
    });

    // -------------------------------------------------------------------
    // Mission Control — scope tree only (cheap re-fetch for the future
    //   ScopeNode profile page; Stream widget gets it bundled above).
    // -------------------------------------------------------------------
    ctx.data.register("mission-control-scope-tree", async ({ companyId }) => {
      const cfg = (await ctx.config.get()) as PluginConfig | null;
      const base = cfg?.wavexApiBase ?? DEFAULT_WAVEX_BASE;
      const id = String(companyId ?? "");
      if (!id) return { ok: false, tree: null, source: "no-company" };
      try {
        const r = await ctx.http.fetch(
          `${base}/api/mission-control/${encodeURIComponent(id)}/scope-tree`,
        );
        if (!r.ok) {
          return { ok: false, tree: null, source: "wavex-api-error", status: r.status };
        }
        const body = await r.json();
        return { ok: true, ...(body as Record<string, unknown>), source: "wavex-api" };
      } catch (err) {
        return { ok: false, tree: null, source: "exception", error: String(err) };
      }
    });

    // -------------------------------------------------------------------
    // Mission Control — Phase 5 accountability graph.
    // -------------------------------------------------------------------
    ctx.data.register("mission-control-graph", async ({ companyId, since, until }) => {
      const cfg = (await ctx.config.get()) as PluginConfig | null;
      const base = cfg?.wavexApiBase ?? DEFAULT_WAVEX_BASE;
      const id = String(companyId ?? "");
      if (!id) return { ok: false, graph: null, source: "no-company" };
      const params = new URLSearchParams();
      if (typeof since === "string") params.set("since", since);
      if (typeof until === "string") params.set("until", until);
      const qs = params.toString();
      try {
        const r = await ctx.http.fetch(
          `${base}/api/mission-control/${encodeURIComponent(id)}/graph${qs ? `?${qs}` : ""}`,
        );
        if (!r.ok) {
          return { ok: false, graph: null, source: "wavex-api-error", status: r.status };
        }
        return await r.json();
      } catch (err) {
        return { ok: false, graph: null, source: "exception", error: String(err) };
      }
    });

    // -------------------------------------------------------------------
    // Mission Control — Phase 4 chain handlers.
    // -------------------------------------------------------------------
    ctx.data.register("mission-control-node-open-assignments", async ({ companyId, nodeId }) => {
      const cfg = (await ctx.config.get()) as PluginConfig | null;
      const base = cfg?.wavexApiBase ?? DEFAULT_WAVEX_BASE;
      const id = String(companyId ?? "");
      const n = String(nodeId ?? "");
      if (!id || !n) return { ok: false, open: [], source: "no-target" };
      try {
        const r = await ctx.http.fetch(
          `${base}/api/mission-control/${encodeURIComponent(id)}/node/${encodeURIComponent(n)}/open-assignments`,
        );
        if (!r.ok) return { ok: false, open: [], source: "wavex-api-error", status: r.status };
        const body = (await r.json()) as { ok?: boolean; open?: unknown[] };
        return { ok: body.ok !== false, open: Array.isArray(body.open) ? body.open : [], source: "wavex-api" };
      } catch (err) {
        return { ok: false, open: [], source: "exception", error: String(err) };
      }
    });

    ctx.data.register("mission-control-task-chain", async ({ companyId, taskRefId }) => {
      const cfg = (await ctx.config.get()) as PluginConfig | null;
      const base = cfg?.wavexApiBase ?? DEFAULT_WAVEX_BASE;
      const id = String(companyId ?? "");
      const t = String(taskRefId ?? "");
      if (!id || !t) return { ok: false, chain: [], currentOwner: null, source: "no-target" };
      try {
        const r = await ctx.http.fetch(
          `${base}/api/mission-control/${encodeURIComponent(id)}/tasks/${encodeURIComponent(t)}/chain`,
        );
        if (!r.ok) return { ok: false, chain: [], currentOwner: null, source: "wavex-api-error", status: r.status };
        const body = (await r.json()) as { ok?: boolean; chain?: unknown[]; currentOwner?: string | null };
        return {
          ok: body.ok !== false,
          chain: Array.isArray(body.chain) ? body.chain : [],
          currentOwner: body.currentOwner ?? null,
          source: "wavex-api",
        };
      } catch (err) {
        return { ok: false, chain: [], currentOwner: null, source: "exception", error: String(err) };
      }
    });

    // -------------------------------------------------------------------
    // Mission Control — KPI scoreboard. Backs the Phase 3 widget.
    // -------------------------------------------------------------------
    ctx.data.register("mission-control-scoreboard", async ({ companyId }) => {
      const cfg = (await ctx.config.get()) as PluginConfig | null;
      const base = cfg?.wavexApiBase ?? DEFAULT_WAVEX_BASE;
      const id = String(companyId ?? "");
      if (!id) return { ok: false, scoreboard: [], due: [], source: "no-company" };
      try {
        const r = await ctx.http.fetch(
          `${base}/api/mission-control/${encodeURIComponent(id)}/scoreboard`,
        );
        if (!r.ok) {
          return { ok: false, scoreboard: [], due: [], source: "wavex-api-error", status: r.status };
        }
        const body = (await r.json()) as {
          ok?: boolean;
          scoreboard?: unknown[];
          due?: unknown[];
        };
        return {
          ok: body.ok !== false,
          scoreboard: Array.isArray(body.scoreboard) ? body.scoreboard : [],
          due: Array.isArray(body.due) ? body.due : [],
          source: "wavex-api",
        };
      } catch (err) {
        return { ok: false, scoreboard: [], due: [], source: "exception", error: String(err) };
      }
    });

    // Manual "announce all due impacts" — fires Stream notices for any
    // unmeasured impacts whose horizon elapsed.
    ctx.actions.register(
      "mission-control-announce-due",
      async ({ companyId }) => {
        const cfg = (await ctx.config.get()) as PluginConfig | null;
        const base = cfg?.wavexApiBase ?? DEFAULT_WAVEX_BASE;
        const id = String(companyId ?? "");
        if (!id) return { ok: false, error: "missing companyId" };
        try {
          const r = await ctx.http.fetch(
            `${base}/api/mission-control/${encodeURIComponent(id)}/measure-due`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({}),
            },
          );
          if (!r.ok) return { ok: false, status: r.status };
          return await r.json();
        } catch (err) {
          return { ok: false, error: String(err) };
        }
      },
    );

    // -------------------------------------------------------------------
    // Mission Control — deliverables list. Backs the Phase 2 table widget.
    // -------------------------------------------------------------------
    ctx.data.register("mission-control-deliverables", async ({ companyId, kind, taskRefId, status, limit }) => {
      const cfg = (await ctx.config.get()) as PluginConfig | null;
      const base = cfg?.wavexApiBase ?? DEFAULT_WAVEX_BASE;
      const id = String(companyId ?? "");
      if (!id) {
        return { ok: false, deliverables: [], source: "no-company" };
      }
      const params = new URLSearchParams();
      if (typeof kind === "string") params.set("kind", kind);
      if (typeof taskRefId === "string") params.set("taskRefId", taskRefId);
      if (typeof status === "string") params.set("status", status);
      if (typeof limit === "number") params.set("limit", String(limit));
      const qs = params.toString();
      try {
        const r = await ctx.http.fetch(
          `${base}/api/mission-control/${encodeURIComponent(id)}/deliverables${qs ? `?${qs}` : ""}`,
        );
        if (!r.ok) {
          return { ok: false, deliverables: [], source: "wavex-api-error", status: r.status };
        }
        const body = (await r.json()) as { ok?: boolean; deliverables?: unknown[]; error?: string };
        return {
          ok: body.ok !== false,
          deliverables: Array.isArray(body.deliverables) ? body.deliverables : [],
          error: body.error,
          source: "wavex-api",
        };
      } catch (err) {
        return { ok: false, deliverables: [], source: "exception", error: String(err) };
      }
    });

    // -------------------------------------------------------------------
    // Mission Control — live stream. Polls the activity endpoint with a
    //   `since` cursor and re-publishes new rows onto the `mission-control-
    //   stream` channel. Polling beats subscribing to the wavex SSE
    //   endpoint inside the worker because the plugin SDK's ctx.http
    //   doesn't expose response streaming; the 2s cadence is well below
    //   any user-perceptible latency for a demo wedge.
    //
    //   Action key is used so the UI can lazily "subscribe" by invoking
    //   it once per (companyId) — the worker then takes over and pushes
    //   on its own schedule. Returns immediately; the loop runs in the
    //   background until the UI closes the stream.
    // -------------------------------------------------------------------
    const streamPollers = new Map<string, NodeJS.Timeout>();
    ctx.actions.register(
      "mission-control-stream-subscribe",
      async ({ companyId }) => {
        const id = String(companyId ?? "");
        if (!id) return { ok: false, error: "missing companyId" };
        if (streamPollers.has(id)) {
          return { ok: true, alreadyRunning: true };
        }
        const cfg = (await ctx.config.get()) as PluginConfig | null;
        const base = cfg?.wavexApiBase ?? DEFAULT_WAVEX_BASE;
        let since: string | null = new Date().toISOString();
        ctx.streams.open("mission-control-stream", id);
        const tick = async (): Promise<void> => {
          try {
            const url = `${base}/api/mission-control/${encodeURIComponent(id)}/activity?since=${encodeURIComponent(since ?? "")}&order=asc&limit=200`;
            const r = await ctx.http.fetch(url);
            if (!r.ok) return;
            const body = (await r.json()) as {
              ok?: boolean;
              events?: Array<{ id: string; at: string }>;
            };
            const events = body.events ?? [];
            if (events.length === 0) return;
            for (const e of events) {
              ctx.streams.emit("mission-control-stream", e);
            }
            const last = events[events.length - 1];
            if (last?.at) since = last.at;
          } catch (err) {
            ctx.logger.warn("mission-control stream poll failed", {
              err: String(err),
            });
          }
        };
        // Fire once immediately, then on a 2s interval.
        void tick();
        const handle = setInterval(() => {
          void tick();
        }, 2000);
        streamPollers.set(id, handle);
        return { ok: true };
      },
    );
    ctx.actions.register(
      "mission-control-stream-unsubscribe",
      async ({ companyId }) => {
        const id = String(companyId ?? "");
        const handle = streamPollers.get(id);
        if (handle) {
          clearInterval(handle);
          streamPollers.delete(id);
          ctx.streams.close("mission-control-stream");
        }
        return { ok: true };
      },
    );

    // -------------------------------------------------------------------
    // inception-status — reads /api/companies/<id>/agents from op-omega
    //   server. Returns ready/total counts + manifest goal/signed_at.
    // -------------------------------------------------------------------
    ctx.data.register("inception-status", async ({ companyId }) => {
      const cfg = (await ctx.config.get()) as PluginConfig | null;
      const base = cfg?.wavexApiBase ?? DEFAULT_WAVEX_BASE;
      try {
        const r = await ctx.http.fetch(
          `${base}/api/companies/${encodeURIComponent(String(companyId))}/agents`,
        );
        if (!r.ok) {
          return {
            agentsTotal: 0,
            agentsReady: 0,
            source: "wavex-api-error",
            status: r.status,
          };
        }
        const list = (await r.json()) as Array<{ slot: string; status: string }>;
        const ready = list.filter(
          (a) => a.status === "active" || a.status === "ready" || a.status === "idle",
        ).length;
        return {
          agentsTotal: list.length,
          agentsReady: ready,
          source: "wavex-api",
        };
      } catch (err) {
        return {
          agentsTotal: 0,
          agentsReady: 0,
          source: "exception",
          error: String(err),
        };
      }
    });

    // -------------------------------------------------------------------
    // subscription-info — looks at the subscriptions table + hire count.
    // -------------------------------------------------------------------
    ctx.data.register("subscription-info", async () => {
      const cfg = (await ctx.config.get()) as PluginConfig | null;
      if (!cfg?.supabaseUrl || !cfg.supabasePublishableKey) {
        return { configured: false };
      }
      try {
        const [hireRes, lastWebhookRes] = await Promise.all([
          ctx.http.fetch(
            `${cfg.supabaseUrl}/rest/v1/rpc/wavex_os_ops_catalog_hire_counts`,
            {
              method: "POST",
              headers: {
                apikey: cfg.supabasePublishableKey,
                Authorization: `Bearer ${cfg.supabasePublishableKey}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({}),
            },
          ),
          ctx.http.fetch(
            `${cfg.supabaseUrl}/rest/v1/rpc/wavex_os_ops_last_webhook_at`,
            {
              method: "POST",
              headers: {
                apikey: cfg.supabasePublishableKey,
                Authorization: `Bearer ${cfg.supabasePublishableKey}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({}),
            },
          ),
        ]);
        type HireRow = { catalog_id: string; active_hires: number };
        type WebhookRow = { processed_at: string; type: string };
        const hires = hireRes.ok ? ((await hireRes.json()) as HireRow[]) : [];
        const webhook = lastWebhookRes.ok
          ? ((await lastWebhookRes.json()) as WebhookRow[])
          : [];
        return {
          configured: true,
          expertAgentsHired: hires.reduce((acc, h) => acc + (h.active_hires ?? 0), 0),
          lastStripeWebhookAt: webhook[0]?.processed_at ?? null,
          lastStripeWebhookType: webhook[0]?.type ?? null,
        };
      } catch (err) {
        return { configured: true, error: String(err) };
      }
    });
  },

  async onHealth() {
    return {
      status: "ok",
      message: "WaveX plugin worker idle (read-only data handlers registered)",
    };
  },

  async onValidateConfig(config: Record<string, unknown>) {
    const cfg = config as PluginConfig;
    const errors: string[] = [];
    if (cfg.supabaseUrl && !cfg.supabasePublishableKey) {
      errors.push("Supabase URL is set but publishable key is missing.");
    }
    if (cfg.supabasePublishableKey?.startsWith("sb_service_")) {
      errors.push(
        "Refusing a service-role key. Use a publishable/anon key instead — the worker only needs RPC read access.",
      );
    }
    return errors.length > 0 ? { ok: false, errors } : { ok: true };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
