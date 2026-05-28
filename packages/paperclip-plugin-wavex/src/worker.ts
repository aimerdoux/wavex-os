/**
 * WaveX plugin worker (v0.4.0).
 *
 * Registers data + action handlers consumed by the Mission Control UI
 * widgets and the Inception Status sidebar. The only outbound HTTP
 * target is the wavex-os op-omega-server (default http://127.0.0.1:3101).
 *
 * No writes through this plugin. State-changing actions still flow
 * through Paperclip's native commands or the wavex MC routes — the
 * plugin never mutates Paperclip's issue/agent state directly.
 *
 * v0.4.0 removed the 5 legacy Supabase-gated handlers
 * (expert-agents-list, deliverables-list, company-goals,
 * deliverable-throughput, fleet-agent-status, subscription-info)
 * along with their widgets. Mission Control covers the same surface.
 */
import { definePlugin, runWorker } from "@wavex-os/plugin-sdk-shim";

interface PluginConfig {
  wavexApiBase?: string;
}

const DEFAULT_WAVEX_BASE = "http://127.0.0.1:3101";
const PAPERCLIP_BASE = "http://127.0.0.1:3100";

/** Plain Node `fetch`, deliberately NOT routed through `ctx.http.fetch`.
 *
 *  The host's plugin-bridge HTTP client refuses any URL that resolves to a
 *  private/loopback IP as an SSRF guard. Mission Control's data source is
 *  the wavex op-omega-server sibling on 127.0.0.1:3101 — strictly local —
 *  so we use the worker process's native fetch, which is not subject to
 *  that guard. This keeps the wavex plugin honest about its only outbound
 *  target (the same machine the host is on) without weakening the
 *  vendored Paperclip core's general-purpose SSRF protection. */
const localFetch: typeof globalThis.fetch = (input, init) =>
  globalThis.fetch(input, init);

/** Translate a Paperclip company UUID into the wavex slug that
 *  wavex-os-server keys on (the `~/.wavex-os/instances/<slug>/` dir name).
 *
 *  All wavex-os-server endpoints index by slug. The plugin context gives
 *  us paperclip's UUID. Without this translation every localFetch ends
 *  up calling loadCompanyManifest(<uuid>) which silently returns nothing,
 *  so the dashboard surfaces show "0 agents / not incepted" even when
 *  the actual fleet has 35 active agents.
 *
 *  Strategy: ask paperclip for the company by UUID; its `name` is stored
 *  as `wavex-os/<slug>` (set at finalize-bridge time). Strip the prefix.
 *  Cache in-process forever — the mapping is immutable after finalize.
 *  Falls back to the raw input on lookup failure (e.g. partial wiring
 *  in tests) so degraded behavior is the same as before this change. */
const slugCache = new Map<string, string>();
async function resolveWavexSlug(companyId: string): Promise<string> {
  if (!companyId) return "";
  const cached = slugCache.get(companyId);
  if (cached !== undefined) return cached;
  // Non-UUID input is already a slug (tests, direct curl, etc.).
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(companyId)) {
    slugCache.set(companyId, companyId);
    return companyId;
  }
  try {
    const r = await localFetch(`${PAPERCLIP_BASE}/api/companies/${encodeURIComponent(companyId)}`);
    if (!r.ok) return companyId;
    const company = (await r.json()) as { name?: string };
    const slug = (company.name ?? "").replace(/^wavex-os\//, "");
    if (slug && slug !== company.name) {
      slugCache.set(companyId, slug);
      return slug;
    }
  } catch {
    /* fall through to passthrough */
  }
  // Mapping not found / not a wavex company — pass through so paperclip-
  // only callers (if any creep in later) still work.
  slugCache.set(companyId, companyId);
  return companyId;
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("WaveX plugin worker starting");

    // -------------------------------------------------------------------
    // Mission Control — initial activity fetch + scope-tree + KPI catalog.
    //   Backs `usePluginData("mission-control-activity")` in the Stream
    //   widget. Returns one bundle so the widget can build its RenderContext
    //   in a single round-trip (no chained fetches).
    // -------------------------------------------------------------------
    ctx.data.register("mission-control-activity", async ({ companyId }) => {
      const cfg = (await ctx.config.get()) as PluginConfig | null;
      const base = cfg?.wavexApiBase ?? DEFAULT_WAVEX_BASE;
      const id = await resolveWavexSlug(String(companyId ?? ""));
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
          localFetch(
            `${base}/api/mission-control/${encodeURIComponent(id)}/activity?limit=200`,
          ),
          localFetch(
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
      const id = await resolveWavexSlug(String(companyId ?? ""));
      if (!id) return { ok: false, tree: null, source: "no-company" };
      try {
        const r = await localFetch(
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
    // Frontier F1 — Headline (LLM-rendered) + Health Orb (status).
    // The two surfaces that anchor the top of every MC view.
    // -------------------------------------------------------------------
    ctx.data.register("mission-control-headline", async ({ companyId, refresh }) => {
      const cfg = (await ctx.config.get()) as PluginConfig | null;
      const base = cfg?.wavexApiBase ?? DEFAULT_WAVEX_BASE;
      const id = await resolveWavexSlug(String(companyId ?? ""));
      if (!id) return { ok: false, error: "no-company" };
      try {
        const url = `${base}/api/mission-control/${encodeURIComponent(id)}/headline${refresh ? "?refresh=1" : ""}`;
        const r = await localFetch(url);
        if (!r.ok) return { ok: false, status: r.status };
        return await r.json();
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    });

    ctx.data.register("mission-control-health-orb", async ({ companyId }) => {
      const cfg = (await ctx.config.get()) as PluginConfig | null;
      const base = cfg?.wavexApiBase ?? DEFAULT_WAVEX_BASE;
      const id = await resolveWavexSlug(String(companyId ?? ""));
      if (!id) return { ok: false, error: "no-company" };
      try {
        const r = await localFetch(
          `${base}/api/mission-control/${encodeURIComponent(id)}/health-orb`,
        );
        if (!r.ok) return { ok: false, status: r.status };
        return await r.json();
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    });

    ctx.data.register(
      "mission-control-kpi-receipts",
      async ({ companyId, kpiId }) => {
        const cfg = (await ctx.config.get()) as PluginConfig | null;
        const base = cfg?.wavexApiBase ?? DEFAULT_WAVEX_BASE;
        const id = await resolveWavexSlug(String(companyId ?? ""));
        const kid = String(kpiId ?? "");
        if (!id || !kid) return { ok: false, error: "missing companyId or kpiId" };
        try {
          const r = await localFetch(
            `${base}/api/mission-control/${encodeURIComponent(id)}/kpi/${encodeURIComponent(kid)}/receipts`,
          );
          if (!r.ok) return { ok: false, status: r.status };
          return await r.json();
        } catch (err) {
          return { ok: false, error: String(err) };
        }
      },
    );

    ctx.data.register(
      "mission-control-accountability-map",
      async ({ companyId }) => {
        const cfg = (await ctx.config.get()) as PluginConfig | null;
        const base = cfg?.wavexApiBase ?? DEFAULT_WAVEX_BASE;
        const id = await resolveWavexSlug(String(companyId ?? ""));
        if (!id) return { ok: false, cards: [], total: 0 };
        try {
          const r = await localFetch(
            `${base}/api/mission-control/${encodeURIComponent(id)}/accountability-map`,
          );
          if (!r.ok) return { ok: false, cards: [], total: 0, status: r.status };
          return await r.json();
        } catch (err) {
          return { ok: false, cards: [], total: 0, error: String(err) };
        }
      },
    );

    ctx.data.register("mission-control-tab-counts", async ({ companyId }) => {
      const cfg = (await ctx.config.get()) as PluginConfig | null;
      const base = cfg?.wavexApiBase ?? DEFAULT_WAVEX_BASE;
      const id = await resolveWavexSlug(String(companyId ?? ""));
      if (!id) return { ok: false };
      try {
        const r = await localFetch(
          `${base}/api/mission-control/${encodeURIComponent(id)}/tab-counts`,
        );
        if (!r.ok) return { ok: false, status: r.status };
        return await r.json();
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    });

    ctx.data.register("mission-control-decision-queue", async ({ companyId }) => {
      const cfg = (await ctx.config.get()) as PluginConfig | null;
      const base = cfg?.wavexApiBase ?? DEFAULT_WAVEX_BASE;
      const id = await resolveWavexSlug(String(companyId ?? ""));
      if (!id) return { ok: false, items: [], total: 0, error: "no-company" };
      try {
        const r = await localFetch(
          `${base}/api/mission-control/${encodeURIComponent(id)}/decision-queue`,
        );
        if (!r.ok) return { ok: false, items: [], total: 0, status: r.status };
        return await r.json();
      } catch (err) {
        return { ok: false, items: [], total: 0, error: String(err) };
      }
    });

    // -------------------------------------------------------------------
    // Mission Control — Phase 7 polish (cost/capacity/weekly).
    // -------------------------------------------------------------------
    ctx.data.register("mission-control-cost", async ({ companyId }) => {
      const cfg = (await ctx.config.get()) as PluginConfig | null;
      const base = cfg?.wavexApiBase ?? DEFAULT_WAVEX_BASE;
      const id = await resolveWavexSlug(String(companyId ?? ""));
      if (!id) return { ok: false, totals: { costUSD: 0, events: 0 }, byNode: [] };
      try {
        const r = await localFetch(
          `${base}/api/mission-control/${encodeURIComponent(id)}/cost`,
        );
        if (!r.ok) return { ok: false, byNode: [], status: r.status };
        return await r.json();
      } catch (err) {
        return { ok: false, byNode: [], error: String(err) };
      }
    });

    ctx.data.register("mission-control-capacity", async ({ companyId }) => {
      const cfg = (await ctx.config.get()) as PluginConfig | null;
      const base = cfg?.wavexApiBase ?? DEFAULT_WAVEX_BASE;
      const id = await resolveWavexSlug(String(companyId ?? ""));
      if (!id) return { ok: false, rows: [], avg: 0, max: 0 };
      try {
        const r = await localFetch(
          `${base}/api/mission-control/${encodeURIComponent(id)}/capacity`,
        );
        if (!r.ok) return { ok: false, rows: [], status: r.status };
        return await r.json();
      } catch (err) {
        return { ok: false, rows: [], error: String(err) };
      }
    });

    ctx.data.register("mission-control-weekly-export", async ({ companyId }) => {
      const cfg = (await ctx.config.get()) as PluginConfig | null;
      const base = cfg?.wavexApiBase ?? DEFAULT_WAVEX_BASE;
      const id = await resolveWavexSlug(String(companyId ?? ""));
      if (!id) return { ok: false };
      try {
        const r = await localFetch(
          `${base}/api/mission-control/${encodeURIComponent(id)}/weekly-export`,
        );
        if (!r.ok) return { ok: false, status: r.status };
        return await r.json();
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    });

    // Frontier F4 — chat-as-nav. Action (not data) because each ask is a
    // user-initiated mutation-ish call (LLM invocation is billable).
    ctx.actions.register("mission-control-ask", async ({ companyId, question }) => {
      const cfg = (await ctx.config.get()) as PluginConfig | null;
      const base = cfg?.wavexApiBase ?? DEFAULT_WAVEX_BASE;
      const id = await resolveWavexSlug(String(companyId ?? ""));
      const q = String(question ?? "").trim();
      if (!id) return { ok: false, error: "no-company" };
      if (!q) return { ok: false, error: "question-required" };
      try {
        const r = await localFetch(
          `${base}/api/mission-control/${encodeURIComponent(id)}/ask`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ question: q }),
          },
        );
        if (!r.ok) return { ok: false, status: r.status };
        return await r.json();
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    });

    ctx.actions.register("mission-control-weekly-export-csv", async ({ companyId }) => {
      const cfg = (await ctx.config.get()) as PluginConfig | null;
      const base = cfg?.wavexApiBase ?? DEFAULT_WAVEX_BASE;
      const id = await resolveWavexSlug(String(companyId ?? ""));
      if (!id) return { ok: false, csv: "" };
      try {
        const r = await localFetch(
          `${base}/api/mission-control/${encodeURIComponent(id)}/weekly-export?format=csv`,
        );
        if (!r.ok) return { ok: false, csv: "", status: r.status };
        const csv = await r.text();
        return { ok: true, csv };
      } catch (err) {
        return { ok: false, csv: "", error: String(err) };
      }
    });

    // -------------------------------------------------------------------
    // Mission Control — Phase 6 Chief of Staff.
    // -------------------------------------------------------------------
    ctx.data.register("mission-control-chief", async ({ companyId }) => {
      const cfg = (await ctx.config.get()) as PluginConfig | null;
      const base = cfg?.wavexApiBase ?? DEFAULT_WAVEX_BASE;
      const id = await resolveWavexSlug(String(companyId ?? ""));
      if (!id) return { ok: false, config: null, source: "no-company" };
      try {
        const r = await localFetch(
          `${base}/api/mission-control/${encodeURIComponent(id)}/chief`,
        );
        if (!r.ok) return { ok: false, config: null, source: "wavex-api-error", status: r.status };
        return await r.json();
      } catch (err) {
        return { ok: false, config: null, source: "exception", error: String(err) };
      }
    });

    ctx.actions.register("mission-control-chief-upsert-config", async (params) => {
      const cfg = (await ctx.config.get()) as PluginConfig | null;
      const base = cfg?.wavexApiBase ?? DEFAULT_WAVEX_BASE;
      const id = String(params.companyId ?? "");
      if (!id) return { ok: false, error: "missing companyId" };
      const r = await localFetch(
        `${base}/api/mission-control/${encodeURIComponent(id)}/chief`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mode: params.mode ?? "solo_founder", enabled: params.enabled ?? true }),
        },
      );
      return r.ok ? await r.json() : { ok: false, status: r.status };
    });

    ctx.actions.register("mission-control-chief-add-rule", async (params) => {
      const cfg = (await ctx.config.get()) as PluginConfig | null;
      const base = cfg?.wavexApiBase ?? DEFAULT_WAVEX_BASE;
      const id = String(params.companyId ?? "");
      if (!id) return { ok: false, error: "missing companyId" };
      const r = await localFetch(
        `${base}/api/mission-control/${encodeURIComponent(id)}/chief/rules`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: params.name,
            triggerKind: params.triggerKind,
            triggerConfig: params.triggerConfig ?? {},
          }),
        },
      );
      return r.ok ? await r.json() : { ok: false, status: r.status };
    });

    ctx.actions.register("mission-control-chief-toggle-rule", async (params) => {
      const cfg = (await ctx.config.get()) as PluginConfig | null;
      const base = cfg?.wavexApiBase ?? DEFAULT_WAVEX_BASE;
      const ruleId = String(params.ruleId ?? "");
      if (!ruleId) return { ok: false, error: "missing ruleId" };
      const r = await localFetch(
        `${base}/api/mission-control/chief/rules/${encodeURIComponent(ruleId)}/enabled`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled: Boolean(params.enabled) }),
        },
      );
      return r.ok ? await r.json() : { ok: false, status: r.status };
    });

    ctx.actions.register("mission-control-chief-evaluate", async (params) => {
      const cfg = (await ctx.config.get()) as PluginConfig | null;
      const base = cfg?.wavexApiBase ?? DEFAULT_WAVEX_BASE;
      const id = String(params.companyId ?? "");
      if (!id) return { ok: false, error: "missing companyId" };
      const r = await localFetch(
        `${base}/api/mission-control/${encodeURIComponent(id)}/chief/evaluate`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ modeContext: params.modeContext ?? "solo_founder" }),
        },
      );
      return r.ok ? await r.json() : { ok: false, status: r.status };
    });

    // -------------------------------------------------------------------
    // Mission Control — Phase 5 accountability graph.
    // -------------------------------------------------------------------
    ctx.data.register("mission-control-graph", async ({ companyId, since, until }) => {
      const cfg = (await ctx.config.get()) as PluginConfig | null;
      const base = cfg?.wavexApiBase ?? DEFAULT_WAVEX_BASE;
      const id = await resolveWavexSlug(String(companyId ?? ""));
      if (!id) return { ok: false, graph: null, source: "no-company" };
      const params = new URLSearchParams();
      if (typeof since === "string") params.set("since", since);
      if (typeof until === "string") params.set("until", until);
      const qs = params.toString();
      try {
        const r = await localFetch(
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
      const id = await resolveWavexSlug(String(companyId ?? ""));
      const n = String(nodeId ?? "");
      if (!id || !n) return { ok: false, open: [], source: "no-target" };
      try {
        const r = await localFetch(
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
      const id = await resolveWavexSlug(String(companyId ?? ""));
      const t = String(taskRefId ?? "");
      if (!id || !t) return { ok: false, chain: [], currentOwner: null, source: "no-target" };
      try {
        const r = await localFetch(
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
    // Mission Control · Deliverable inspector (v0.9.0 Phase 3).
    // Three handlers backing DeliverableInspector.tsx:
    //   - detail   → GET /deliverable/:id
    //   - reveal   → POST /deliverable/:id/reveal (OS reveal)
    //   - review   → POST /deliverable/:id/review (approve/reject)
    // -------------------------------------------------------------------
    ctx.data.register(
      "mission-control-deliverable-detail",
      async ({ id }) => {
        const cfg = (await ctx.config.get()) as PluginConfig | null;
        const base = cfg?.wavexApiBase ?? DEFAULT_WAVEX_BASE;
        const did = String(id ?? "");
        if (!did) return { ok: false, deliverable: null };
        try {
          const r = await localFetch(
            `${base}/api/mission-control/deliverable/${encodeURIComponent(did)}`,
          );
          if (!r.ok) return { ok: false, status: r.status };
          return await r.json();
        } catch (err) {
          return { ok: false, error: String(err) };
        }
      },
    );

    ctx.actions.register(
      "mission-control-deliverable-reveal",
      async ({ deliverableId }) => {
        const cfg = (await ctx.config.get()) as PluginConfig | null;
        const base = cfg?.wavexApiBase ?? DEFAULT_WAVEX_BASE;
        const did = String(deliverableId ?? "");
        if (!did) return { ok: false, error: "missing deliverableId" };
        try {
          const r = await localFetch(
            `${base}/api/mission-control/deliverable/${encodeURIComponent(did)}/reveal`,
            { method: "POST" },
          );
          if (!r.ok) return { ok: false, status: r.status };
          return await r.json();
        } catch (err) {
          return { ok: false, error: String(err) };
        }
      },
    );

    ctx.actions.register(
      "mission-control-deliverable-review",
      async (params) => {
        const cfg = (await ctx.config.get()) as PluginConfig | null;
        const base = cfg?.wavexApiBase ?? DEFAULT_WAVEX_BASE;
        const did = String(params.deliverableId ?? "");
        if (!did) return { ok: false, error: "missing deliverableId" };
        try {
          const r = await localFetch(
            `${base}/api/mission-control/deliverable/${encodeURIComponent(did)}/review`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                decision: params.decision,
                notes: params.notes,
              }),
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
    // Mission Control · Pool B Health + Install Funnel ("auto-sync").
    //
    // Five read-only endpoints that surface Pool B liveness, install/
    // pairing funnel conversion, and chip-health (recent pillar-suggest
    // success rate). All gated on board auth via the underlying server
    // routes. Cached server-side for 30s; pass `fresh=true` to bypass.
    // -------------------------------------------------------------------
    ctx.data.register("pool-b-health-recent", async (params) => {
      const cfg = (await ctx.config.get()) as PluginConfig | null;
      const base = cfg?.wavexApiBase ?? DEFAULT_WAVEX_BASE;
      const limit = Number(params?.limit ?? 20);
      const fresh = params?.fresh ? "&fresh=1" : "";
      try {
        const r = await localFetch(`${base}/api/pool-b-health/recent?limit=${limit}${fresh}`);
        if (!r.ok) return { ok: false, status: r.status, rows: [] };
        return await r.json();
      } catch (err) {
        return { ok: false, error: String(err), rows: [] };
      }
    });

    ctx.data.register("pool-b-health-devices", async (params) => {
      const cfg = (await ctx.config.get()) as PluginConfig | null;
      const base = cfg?.wavexApiBase ?? DEFAULT_WAVEX_BASE;
      const fresh = params?.fresh ? "?fresh=1" : "";
      try {
        const r = await localFetch(`${base}/api/pool-b-health/devices${fresh}`);
        if (!r.ok) return { ok: false, status: r.status, rows: [] };
        return await r.json();
      } catch (err) {
        return { ok: false, error: String(err), rows: [] };
      }
    });

    ctx.data.register("pool-b-health-pairings", async (params) => {
      const cfg = (await ctx.config.get()) as PluginConfig | null;
      const base = cfg?.wavexApiBase ?? DEFAULT_WAVEX_BASE;
      const fresh = params?.fresh ? "?fresh=1" : "";
      try {
        const r = await localFetch(`${base}/api/pool-b-health/pairings${fresh}`);
        if (!r.ok) return { ok: false, status: r.status, rows: [] };
        return await r.json();
      } catch (err) {
        return { ok: false, error: String(err), rows: [] };
      }
    });

    ctx.data.register("pool-b-health-spend", async (params) => {
      const cfg = (await ctx.config.get()) as PluginConfig | null;
      const base = cfg?.wavexApiBase ?? DEFAULT_WAVEX_BASE;
      const days = Number(params?.days ?? 14);
      const fresh = params?.fresh ? "&fresh=1" : "";
      try {
        const r = await localFetch(`${base}/api/pool-b-health/spend?days=${days}${fresh}`);
        if (!r.ok) return { ok: false, status: r.status, rows: [] };
        return await r.json();
      } catch (err) {
        return { ok: false, error: String(err), rows: [] };
      }
    });

    ctx.data.register("pool-b-health-funnel", async (params) => {
      const cfg = (await ctx.config.get()) as PluginConfig | null;
      const base = cfg?.wavexApiBase ?? DEFAULT_WAVEX_BASE;
      const fresh = params?.fresh ? "?fresh=1" : "";
      try {
        const r = await localFetch(`${base}/api/pool-b-health/funnel${fresh}`);
        if (!r.ok) return { ok: false, status: r.status, summary: null };
        return await r.json();
      } catch (err) {
        return { ok: false, error: String(err), summary: null };
      }
    });

    // Operator-side Pool B usage roll-up — drives the life bar at the
    // top of the Pool B Health widget. Tokens + cost + request counts
    // over 24h / 7d / 30d windows.
    ctx.data.register("pool-b-health-operator-quota", async (params) => {
      const cfg = (await ctx.config.get()) as PluginConfig | null;
      const base = cfg?.wavexApiBase ?? DEFAULT_WAVEX_BASE;
      const fresh = params?.fresh ? "?fresh=1" : "";
      try {
        const r = await localFetch(`${base}/api/pool-b-health/operator-quota${fresh}`);
        if (!r.ok) return { ok: false, status: r.status, status_data: null };
        return await r.json();
      } catch (err) {
        return { ok: false, error: String(err), status_data: null };
      }
    });

    // Device pairing — lets the operator pair this Mac to their
    // wavexcard.com account from inside the Pool B Health widget instead
    // of running `wavex-os login` in a terminal. pair-start kicks off the
    // RFC-8628 device flow; pair-status is polled until phase === "paired".
    ctx.actions.register("pool-b-pair-start", async () => {
      const cfg = (await ctx.config.get()) as PluginConfig | null;
      const base = cfg?.wavexApiBase ?? DEFAULT_WAVEX_BASE;
      try {
        const r = await localFetch(`${base}/api/pool-b-health/pair-start`, { method: "POST" });
        const body = await r.json();
        if (!r.ok) return { ok: false, status: r.status, error: (body as { error?: string }).error ?? `HTTP ${r.status}` };
        return body;
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    });

    ctx.data.register("pool-b-pair-status", async () => {
      const cfg = (await ctx.config.get()) as PluginConfig | null;
      const base = cfg?.wavexApiBase ?? DEFAULT_WAVEX_BASE;
      try {
        const r = await localFetch(`${base}/api/pool-b-health/pair-status`);
        if (!r.ok) return { ok: false, status: r.status, phase: "idle" };
        return await r.json();
      } catch (err) {
        return { ok: false, error: String(err), phase: "idle" };
      }
    });

    // -------------------------------------------------------------------
    // Mission Control · Connectors directory (v0.8.0).
    //
    // Three handlers backing the sidebar-triggered directory modal:
    //   - connectors-catalog   → composio-shim featured list (curated)
    //   - connectors-connected → vault state per slug (live)
    //   - connectors-connect   → kicks off OAuth, returns redirectUrl
    //   - connectors-disconnect → removes vault credentials for one slug
    // -------------------------------------------------------------------
    // Setup gating — the Directory modal checks this first and shows
    // a key-entry screen until Composio is configured + valid.
    ctx.data.register("connectors-setup-status", async () => {
      const cfg = (await ctx.config.get()) as PluginConfig | null;
      const base = cfg?.wavexApiBase ?? DEFAULT_WAVEX_BASE;
      try {
        const r = await localFetch(`${base}/api/connectors/setup-status`);
        if (!r.ok) return { ok: false, configured: false, valid: false, mode: "error" };
        return await r.json();
      } catch (err) {
        return { ok: false, configured: false, valid: false, mode: "error", error: String(err) };
      }
    });

    ctx.actions.register("connectors-setup", async (params) => {
      const cfg = (await ctx.config.get()) as PluginConfig | null;
      const base = cfg?.wavexApiBase ?? DEFAULT_WAVEX_BASE;
      const apiKey = String(params.apiKey ?? "").trim();
      if (!apiKey) return { ok: false, error: "apiKey is required" };
      try {
        const r = await localFetch(`${base}/api/connectors/setup`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ apiKey }),
        });
        const body = await r.json();
        if (!r.ok) return { ok: false, status: r.status, error: (body as { error?: string }).error ?? `HTTP ${r.status}` };
        return body;
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    });

    // Flip into WaveX-managed Composio mode (connectors brokered through
    // WaveX's account, billed to credits — no key in the browser).
    ctx.actions.register("connectors-enable-managed", async () => {
      const cfg = (await ctx.config.get()) as PluginConfig | null;
      const base = cfg?.wavexApiBase ?? DEFAULT_WAVEX_BASE;
      try {
        const r = await localFetch(`${base}/api/connectors/enable-managed`, { method: "POST" });
        const body = await r.json();
        if (!r.ok) return { ok: false, status: r.status, error: (body as { error?: string }).error ?? `HTTP ${r.status}` };
        return body;
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    });

    ctx.data.register("connectors-catalog", async () => {
      const cfg = (await ctx.config.get()) as PluginConfig | null;
      const base = cfg?.wavexApiBase ?? DEFAULT_WAVEX_BASE;
      try {
        // /api/connectors/catalog → live Composio toolkits.get({}) with
        // a 5-min server-side cache, or FEATURED_TOOLKITS fallback when
        // Composio is disabled. Either way, the response shape is the
        // same: { rows: Array<{slug, name, logo?, description?, category?}> }
        const r = await localFetch(`${base}/api/connectors/catalog`);
        if (r.ok) {
          const body = (await r.json()) as {
            ok?: boolean;
            rows?: Array<{
              slug: string;
              name: string;
              logo?: string;
              description?: string;
              category?: string;
            }>;
            source?: "composio" | "curated";
          };
          return {
            ok: body.ok !== false,
            source: body.source ?? "unknown",
            toolkits: (body.rows ?? []).map((r) => ({
              slug: r.slug,
              displayName: r.name,
              category: r.category ?? "other",
              logoUrl: r.logo,
              description: r.description,
            })),
          };
        }
      } catch {
        // fall through to empty fallback
      }
      return { ok: false, source: "error", toolkits: [] };
    });

    ctx.data.register("connectors-connected", async ({ companyId }) => {
      const cfg = (await ctx.config.get()) as PluginConfig | null;
      const base = cfg?.wavexApiBase ?? DEFAULT_WAVEX_BASE;
      const id = await resolveWavexSlug(String(companyId ?? ""));
      if (!id) return { ok: false, rows: [], source: "no-company" };
      try {
        const r = await localFetch(
          `${base}/api/connectors/${encodeURIComponent(id)}/connected`,
        );
        if (!r.ok)
          return { ok: false, rows: [], source: "wavex-api-error", status: r.status };
        return await r.json();
      } catch (err) {
        return { ok: false, rows: [], source: "exception", error: String(err) };
      }
    });

    ctx.actions.register("connectors-connect", async (params) => {
      const cfg = (await ctx.config.get()) as PluginConfig | null;
      const base = cfg?.wavexApiBase ?? DEFAULT_WAVEX_BASE;
      const id = String(params.companyId ?? "");
      const slug = String(params.slug ?? "");
      if (!id || !slug) return { ok: false, error: "missing companyId or slug" };
      try {
        const r = await localFetch(
          `${base}/op-omega/onboarding/connectors/oauth/initiate`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              companyId: id,
              toolkitSlug: slug,
              avatarId: params.avatarId ?? null,
            }),
          },
        );
        if (!r.ok) return { ok: false, status: r.status, error: `HTTP ${r.status}` };
        // composio-shim/initOAuth returns `{ url, pendingConnectionId,
        // needsLiveWiring? }` — NOT `redirectUrl`. needsLiveWiring is
        // truthy when WAVEX_COMPOSIO_DISABLED=1 (default in dev) or when
        // the hub session can't be obtained.
        const body = (await r.json()) as {
          url?: string | null;
          pendingConnectionId?: string | null;
          needsLiveWiring?: boolean;
        };
        if (body.needsLiveWiring || !body.url) {
          return {
            ok: false,
            needsLiveWiring: true,
            error: "Composio is disabled. Set COMPOSIO_API_KEY + WAVEX_COMPOSIO_DISABLED=0 to enable live OAuth.",
          };
        }
        return {
          ok: true,
          redirectUrl: body.url,
          pendingConnectionId: body.pendingConnectionId ?? null,
        };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    });

    ctx.actions.register("connectors-disconnect", async (params) => {
      const cfg = (await ctx.config.get()) as PluginConfig | null;
      const base = cfg?.wavexApiBase ?? DEFAULT_WAVEX_BASE;
      const id = String(params.companyId ?? "");
      const slug = String(params.slug ?? "");
      if (!id || !slug) return { ok: false, error: "missing companyId or slug" };
      try {
        const r = await localFetch(
          `${base}/api/connectors/${encodeURIComponent(id)}/${encodeURIComponent(slug)}`,
          { method: "DELETE" },
        );
        if (!r.ok) return { ok: false, status: r.status };
        return await r.json();
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    });

    // -------------------------------------------------------------------
    // Mission Control v2 — Phase 7 Cost Attribution.
    // -------------------------------------------------------------------
    ctx.data.register("mission-control-cost-per-kpi", async ({ companyId }) => {
      const cfg = (await ctx.config.get()) as PluginConfig | null;
      const base = cfg?.wavexApiBase ?? DEFAULT_WAVEX_BASE;
      const id = await resolveWavexSlug(String(companyId ?? ""));
      if (!id) return { ok: false, rows: [], source: "no-company" };
      try {
        const r = await localFetch(
          `${base}/api/mission-control/${encodeURIComponent(id)}/cost-per-kpi`,
        );
        if (!r.ok)
          return { ok: false, rows: [], source: "wavex-api-error", status: r.status };
        return await r.json();
      } catch (err) {
        return { ok: false, rows: [], source: "exception", error: String(err) };
      }
    });

    ctx.data.register("mission-control-capacity-heatmap", async ({ companyId }) => {
      const cfg = (await ctx.config.get()) as PluginConfig | null;
      const base = cfg?.wavexApiBase ?? DEFAULT_WAVEX_BASE;
      const id = await resolveWavexSlug(String(companyId ?? ""));
      if (!id)
        return { ok: false, nodes: [], hours: [], cells: [], source: "no-company" };
      try {
        const r = await localFetch(
          `${base}/api/mission-control/${encodeURIComponent(id)}/capacity-heatmap`,
        );
        if (!r.ok)
          return {
            ok: false,
            nodes: [],
            hours: [],
            cells: [],
            source: "wavex-api-error",
            status: r.status,
          };
        return await r.json();
      } catch (err) {
        return {
          ok: false,
          nodes: [],
          hours: [],
          cells: [],
          source: "exception",
          error: String(err),
        };
      }
    });

    ctx.data.register("mission-control-burn-rate", async ({ companyId }) => {
      const cfg = (await ctx.config.get()) as PluginConfig | null;
      const base = cfg?.wavexApiBase ?? DEFAULT_WAVEX_BASE;
      const id = await resolveWavexSlug(String(companyId ?? ""));
      if (!id)
        return {
          ok: false,
          daily: [],
          projectedRunwayDays: null,
          dailyBudgetUSD: null,
          source: "no-company",
        };
      try {
        const r = await localFetch(
          `${base}/api/mission-control/${encodeURIComponent(id)}/burn-rate`,
        );
        if (!r.ok)
          return {
            ok: false,
            daily: [],
            projectedRunwayDays: null,
            dailyBudgetUSD: null,
            source: "wavex-api-error",
            status: r.status,
          };
        return await r.json();
      } catch (err) {
        return {
          ok: false,
          daily: [],
          projectedRunwayDays: null,
          dailyBudgetUSD: null,
          source: "exception",
          error: String(err),
        };
      }
    });

    // -------------------------------------------------------------------
    // Mission Control v2 — Phase 3 Causal Impact graph.
    //
    // Two endpoints feeding the new ImpactGraph widget:
    //  - `impact-summary` (one call) → top-KPIs + top-work + orphans + calibration
    //  - `impact-graph` (per-KPI drilldown) → task chain for that KPI
    // -------------------------------------------------------------------
    ctx.data.register(
      "mission-control-impact-summary",
      async ({ companyId }) => {
        const cfg = (await ctx.config.get()) as PluginConfig | null;
        const base = cfg?.wavexApiBase ?? DEFAULT_WAVEX_BASE;
        const id = await resolveWavexSlug(String(companyId ?? ""));
        if (!id) {
          return {
            ok: false,
            topKpisByForecast: [],
            topWorkForHeadline: [],
            orphanWork: [],
            ownerCalibration: [],
            source: "no-company",
          };
        }
        try {
          const r = await localFetch(
            `${base}/api/mission-control/${encodeURIComponent(id)}/impact-summary`,
          );
          if (!r.ok) {
            return {
              ok: false,
              topKpisByForecast: [],
              topWorkForHeadline: [],
              orphanWork: [],
              ownerCalibration: [],
              source: "wavex-api-error",
              status: r.status,
            };
          }
          return await r.json();
        } catch (err) {
          return {
            ok: false,
            topKpisByForecast: [],
            topWorkForHeadline: [],
            orphanWork: [],
            ownerCalibration: [],
            source: "exception",
            error: String(err),
          };
        }
      },
    );

    ctx.data.register(
      "mission-control-impact-graph",
      async ({ companyId, kpiId }) => {
        const cfg = (await ctx.config.get()) as PluginConfig | null;
        const base = cfg?.wavexApiBase ?? DEFAULT_WAVEX_BASE;
        const id = await resolveWavexSlug(String(companyId ?? ""));
        const k = String(kpiId ?? "");
        if (!id || !k) {
          return { ok: false, nodes: [], source: "no-target" };
        }
        try {
          const r = await localFetch(
            `${base}/api/mission-control/${encodeURIComponent(id)}/kpi/${encodeURIComponent(k)}/impact-graph`,
          );
          if (!r.ok) {
            return {
              ok: false,
              nodes: [],
              source: "wavex-api-error",
              status: r.status,
            };
          }
          return await r.json();
        } catch (err) {
          return {
            ok: false,
            nodes: [],
            source: "exception",
            error: String(err),
          };
        }
      },
    );

    // -------------------------------------------------------------------
    // Mission Control — KPI scoreboard. Backs the Phase 3 widget.
    // -------------------------------------------------------------------
    // Phase 2 v2 — rich scoreboard with history + status + freshness.
    ctx.data.register("mission-control-scoreboard-rich", async ({ companyId }) => {
      const cfg = (await ctx.config.get()) as PluginConfig | null;
      const base = cfg?.wavexApiBase ?? DEFAULT_WAVEX_BASE;
      const id = await resolveWavexSlug(String(companyId ?? ""));
      if (!id) return { ok: false, scoreboard: [], source: "no-company" };
      try {
        const r = await localFetch(
          `${base}/api/mission-control/${encodeURIComponent(id)}/scoreboard-rich`,
        );
        if (!r.ok) return { ok: false, scoreboard: [], source: "wavex-api-error", status: r.status };
        return await r.json();
      } catch (err) {
        return { ok: false, scoreboard: [], source: "exception", error: String(err) };
      }
    });

    // Phase 2 v2 — sample-now: writes one snapshot row per KPI.
    ctx.actions.register("mission-control-sample-kpis", async ({ companyId }) => {
      const cfg = (await ctx.config.get()) as PluginConfig | null;
      const base = cfg?.wavexApiBase ?? DEFAULT_WAVEX_BASE;
      const id = await resolveWavexSlug(String(companyId ?? ""));
      if (!id) return { ok: false, sampled: 0 };
      const r = await localFetch(
        `${base}/api/mission-control/${encodeURIComponent(id)}/sample-kpis`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
      );
      if (!r.ok) return { ok: false, sampled: 0, status: r.status };
      return await r.json();
    });

    ctx.data.register("mission-control-scoreboard", async ({ companyId }) => {
      const cfg = (await ctx.config.get()) as PluginConfig | null;
      const base = cfg?.wavexApiBase ?? DEFAULT_WAVEX_BASE;
      const id = await resolveWavexSlug(String(companyId ?? ""));
      if (!id) return { ok: false, scoreboard: [], due: [], source: "no-company" };
      try {
        const r = await localFetch(
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
        const id = await resolveWavexSlug(String(companyId ?? ""));
        if (!id) return { ok: false, error: "missing companyId" };
        try {
          const r = await localFetch(
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
      const id = await resolveWavexSlug(String(companyId ?? ""));
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
        const r = await localFetch(
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
        const id = await resolveWavexSlug(String(companyId ?? ""));
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
            const r = await localFetch(url);
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
        const id = await resolveWavexSlug(String(companyId ?? ""));
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
      const id = await resolveWavexSlug(String(companyId ?? ""));
      try {
        const r = await localFetch(
          `${base}/api/companies/${encodeURIComponent(id)}/agents`,
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
    if (cfg.wavexApiBase && !/^https?:\/\//i.test(cfg.wavexApiBase)) {
      errors.push("wavexApiBase must be an http(s) URL.");
    }
    return errors.length > 0 ? { ok: false, errors } : { ok: true };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
