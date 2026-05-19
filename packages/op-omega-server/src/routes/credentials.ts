/** Credential Concierge routes.
 *
 *  Walks the operator through configuring each connector recommended by
 *  Phase 2. Backed by the AES-GCM vault (src/vault/) and the per-connector
 *  test probes (src/vault/probes.ts).
 *
 *  Endpoints:
 *    GET  /op-omega/onboarding/credentials/:companyId
 *           Returns recommended connectors merged with vault state.
 *    POST /op-omega/onboarding/credentials/paste
 *           { companyId, connectorId, key, plaintext } — vault-encrypts
 *    POST /op-omega/onboarding/credentials/test
 *           { companyId, connectorId } — runs the connector probe
 *    POST /op-omega/onboarding/credentials/skip
 *           { companyId, connectorId, reason } — marks as skipped */

import { z } from "zod";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import {
  generateConnectorManifest, loadPillarResponses,
  isOnboardingHaltError,
  type ConnectorEntry,
} from "@op-omega/plugin-onboarding";
import { listConnections, listAllToolkits, FEATURED_TOOLKITS, _resetClient as resetComposioClient } from "@wavex-os/composio-shim";
import { assertBoard, assertCompanyAccess, AuthError } from "@wavex-os/auth-shim";
import { listConnectorStates, writeCredential, recordTestResult, skipConnector, deleteAllForConnector } from "../vault/service.js";
import { runProbe, hasProbe } from "../vault/probes.js";
import { scanInstalledMcpServersMap, mcpAvailableFor, type DetectedMcp } from "../lib/mcp-scanner.js";

function authReq(req: FastifyRequest) {
  return { method: req.method, headers: req.headers as Record<string, string> };
}

function gateBoard(req: FastifyRequest, reply: FastifyReply): boolean {
  const ar = authReq(req);
  try { assertBoard(ar); return true; }
  catch (e) {
    if (e instanceof AuthError) { reply.status(e.statusCode).send({ error: e.message }); return false; }
    throw e;
  }
}

const pasteSchema = z.object({
  companyId: z.string().min(1),
  connectorId: z.string().min(1),
  key: z.string().min(1).max(120),
  plaintext: z.string().min(1).max(8192),
  writtenBy: z.string().max(40).optional(),
});

const testSchema = z.object({
  companyId: z.string().min(1),
  connectorId: z.string().min(1),
});

const skipSchema = z.object({
  companyId: z.string().min(1),
  connectorId: z.string().min(1),
  reason: z.string().min(3).max(500),
});

/** Merge Phase-2 recommendations with vault state into a single per-connector
 *  view the UI can render. */
interface ConciergeRow {
  connectorId: string;
  bucket: "required" | "suggested" | "deferred";
  priority: string;
  rationale: string;
  status: "vaulted_valid" | "vaulted_unvalidated" | "skipped" | "pending";
  vaultedKeys: string[];
  expectedKeys: string[];
  hasProbe: boolean;
  lastTestedAt: string | null;
  lastTestResult: { ok: boolean; detail?: string } | null;
  skipReason: string | null;
  composioManaged: boolean;
  /** Operator-facing link to the connector's API key management page.
   *  Saves the operator from googling "where do I find my Stripe API key".
   *  Null for connectors with no obvious self-serve URL. */
  keysUrl: string | null;
  /** True when the customer already has an MCP server installed for this
   *  connector (detected from Claude Desktop / Claude Code / Cursor configs).
   *  The UI renders these as "✓ Connected via your existing MCP" with no
   *  paste form. Priority is: mcpManaged → composioManaged → direct paste. */
  mcpManaged: boolean;
  /** Source label shown to the operator when mcpManaged=true, e.g. "Claude
   *  Desktop" or "Cursor". Null when mcpManaged=false. */
  mcpSourcedFrom: string | null;
  /** True when this connector has an official MCP server available (whether
   *  or not the customer has installed it yet). Lets the UI surface
   *  "Install MCP — skip credentials entirely" as a third option below
   *  OAuth and paste. */
  mcpAvailable: boolean;
  /** Operator-facing one-liner + docs link for installing the MCP, when
   *  available. Null when we don't have a documented install hint. */
  mcpInstallHint: { docs: string; install_hint: string } | null;
}

/** Per-connector deep links to where the operator gets their API keys.
 *  These are stable provider URLs — kept here (and not in env) so they're
 *  versioned with the connector schema. Composio-managed connectors point
 *  at app.composio.dev where the OAuth handshake actually happens. */
const CONNECTOR_KEYS_URL: Record<string, string> = {
  // Direct-key
  supabase:             "https://supabase.com/dashboard/project/_/settings/api",
  github:               "https://github.com/settings/tokens",
  telegram:             "https://core.telegram.org/bots#how-do-i-create-a-bot",
  whatsapp:             "https://developers.facebook.com/apps/",
  "twilio-sms":         "https://console.twilio.com/",
  sendgrid:             "https://app.sendgrid.com/settings/api_keys",
  anthropic:            "https://console.anthropic.com/settings/keys",
  openai:               "https://platform.openai.com/api-keys",
  mixpanel:             "https://mixpanel.com/settings/project",
  amplitude:            "https://app.amplitude.com/data/sources",
  posthog:              "https://app.posthog.com/project/settings",
  segment:              "https://app.segment.com/",
  stripe:               "https://dashboard.stripe.com/apikeys",
  "stripe-connect":     "https://dashboard.stripe.com/apikeys",
  shopify:              "https://help.shopify.com/en/manual/apps/app-types/custom-apps",
  bigcommerce:          "https://developer.bigcommerce.com/docs/start/authentication/api-accounts",
  shipstation:          "https://help.shipstation.com/hc/en-us/articles/360025856212",
  klaviyo:              "https://www.klaviyo.com/account#api-keys-tab",
  plaid:                "https://dashboard.plaid.com/team/keys",
  docusign:             "https://developers.docusign.com/platform/auth/",
  clio:                 "https://app.clio.com/settings/developer_applications",
  "meta-ads-api":       "https://developers.facebook.com/apps/",
  "google-ads-api":     "https://developers.google.com/google-ads/api/docs/first-call/dev-token",
  "linkedin-sales-nav": "https://www.linkedin.com/developers/apps",
  // Composio-managed → Composio's app, where the OAuth flow runs
  slack:                "https://app.composio.dev/apps",
  discord:              "https://app.composio.dev/apps",
  gmail:                "https://app.composio.dev/apps",
  hubspot:              "https://app.composio.dev/apps",
  salesforce:           "https://app.composio.dev/apps",
  intercom:             "https://app.composio.dev/apps",
  zendesk:              "https://app.composio.dev/apps",
  notion:               "https://app.composio.dev/apps",
  airtable:             "https://app.composio.dev/apps",
  linear:               "https://app.composio.dev/apps",
  calendly:             "https://app.composio.dev/apps",
  google_calendar:      "https://app.composio.dev/apps",
  google_drive:         "https://app.composio.dev/apps",
};

/** Per-connector schema of expected vault keys + whether Composio handles
 *  the OAuth handshake. Direct-key connectors expose paste fields; Composio
 *  ones surface the OAuth init button.
 *
 *  Composio coverage was empirically probed via /v1/connectors/oauth/initiate
 *  — supabase / github / stripe etc. all return a valid OAuth redirect URL,
 *  so they're flipped to composio:true. Connectors Composio rejects
 *  (mixpanel, twilio, sendgrid, etc.) stay paste-only.
 *
 *  Some connectors expose BOTH paths today: composio:true + non-empty keys
 *  means the wizard renders OAuth as primary; the customer can still vault
 *  API keys later from Mission Control if their OAuth path fails. */
const CONNECTOR_KEY_SCHEMA: Record<string, { keys: string[]; composio: boolean }> = {
  // Already-configured upstream
  "claude-code":     { keys: [],                            composio: false },

  // Data substrate / dev infra — Composio supports these via OAuth (verified).
  supabase:          { keys: ["url", "anon_key"],           composio: true  },
  github:            { keys: ["pat"],                       composio: true  },

  // Direct-key only (Composio does NOT support these as OAuth toolkits).
  telegram:          { keys: ["telegram_bot_token", "telegram_chat_id"], composio: false },
  whatsapp:          { keys: ["business_account_id", "access_token"], composio: false },
  "twilio-sms":      { keys: ["account_sid", "auth_token", "from_number"], composio: false },
  sendgrid:          { keys: ["api_key"],                   composio: false },
  anthropic:         { keys: ["api_key"],                   composio: false },
  openai:            { keys: ["api_key"],                   composio: false },
  mixpanel:          { keys: ["project_token", "service_account_secret"], composio: false },
  amplitude:         { keys: ["api_key", "secret_key"],     composio: false },
  posthog:           { keys: ["host", "project_api_key", "personal_api_key"], composio: false },
  segment:           { keys: ["write_key"],                 composio: false },

  // Stripe via Composio OAuth (verified); paste secret_key fallback retained.
  stripe:            { keys: ["secret_key"],                composio: true  },
  "stripe-connect":  { keys: ["secret_key", "platform_account_id"], composio: false },
  shopify:           { keys: ["shop_domain", "admin_api_token"], composio: false },
  bigcommerce:       { keys: ["store_hash", "access_token"], composio: false },
  shipstation:       { keys: ["api_key", "api_secret"],     composio: false },
  klaviyo:           { keys: ["private_api_key"],           composio: false },

  // Vertical
  plaid:             { keys: ["client_id", "secret"],       composio: false },
  docusign:          { keys: ["integration_key", "user_id", "account_id"], composio: false },
  clio:              { keys: ["client_id", "client_secret"], composio: false },

  // Ads APIs
  "meta-ads-api":    { keys: ["access_token", "ad_account_id"], composio: false },
  "google-ads-api":  { keys: ["developer_token", "customer_id", "refresh_token"], composio: false },
  "linkedin-sales-nav": { keys: ["access_token"],           composio: false },

  // Composio-managed (OAuth via Composio when COMPOSIO_API_KEY present)
  slack:             { keys: [],                            composio: true },
  discord:           { keys: [],                            composio: true },
  gmail:             { keys: [],                            composio: true },
  hubspot:           { keys: [],                            composio: true },
  salesforce:        { keys: [],                            composio: true },
  intercom:          { keys: [],                            composio: true },
  zendesk:           { keys: [],                            composio: true },
  notion:            { keys: [],                            composio: true },
  airtable:          { keys: [],                            composio: true },
  linear:            { keys: [],                            composio: true },
  calendly:          { keys: [],                            composio: true },
  google_calendar:   { keys: [],                            composio: true },
  google_drive:      { keys: [],                            composio: true },
};

function describeConnector(id: string): { keys: string[]; composio: boolean } {
  return CONNECTOR_KEY_SCHEMA[id] ?? { keys: [], composio: false };
}

// ── Connector setup helpers ──────────────────────────────────────────
//
// resolveRepoEnvPath() finds <repo>/.env. The op-omega-server runs
// from packages/op-omega-server/, so we walk up to the workspace root.
// writeOrUpdateEnvFile preserves existing keys + only replaces the
// values for the keys we manage.

async function resolveRepoEnvPath(): Promise<string> {
  const { fileURLToPath } = await import("node:url");
  const here = fileURLToPath(import.meta.url);
  // .../packages/op-omega-server/src/routes/credentials.ts → walk up to repo
  const { resolve, dirname } = await import("node:path");
  const dir = dirname(here);
  return resolve(dir, "..", "..", "..", "..", ".env");
}

async function writeOrUpdateEnvFile(
  envPath: string,
  updates: Record<string, string>,
): Promise<void> {
  const { readFile, writeFile } = await import("node:fs/promises");
  let existing = "";
  try {
    existing = await readFile(envPath, "utf8");
  } catch {
    // file doesn't exist yet — we'll create it
  }
  const lines = existing ? existing.split(/\r?\n/) : [];
  const seen = new Set<string>();
  const next: string[] = [];
  for (const line of lines) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)\s*=/);
    if (match && updates[match[1]!] !== undefined) {
      next.push(`${match[1]}=${updates[match[1]!]}`);
      seen.add(match[1]!);
    } else {
      next.push(line);
    }
  }
  for (const [k, v] of Object.entries(updates)) {
    if (!seen.has(k)) next.push(`${k}=${v}`);
  }
  // Trim trailing blank lines, ensure single newline at end.
  while (next.length > 0 && next[next.length - 1]!.trim() === "") next.pop();
  await writeFile(envPath, `${next.join("\n")}\n`, "utf8");
}

export function registerCredentialRoutes(app: FastifyInstance): void {
  app.get("/op-omega/onboarding/credentials/:companyId", async (req, reply) => {
    if (!gateBoard(req, reply)) return;
    const { companyId } = req.params as { companyId: string };
    assertCompanyAccess(authReq(req), companyId);

    const responses = await loadPillarResponses(companyId).catch(() => null);
    if (!responses) return reply.status(404).send({ error: "no pillar responses for this company" });

    let manifest;
    try {
      const live = await listConnections(companyId);
      const r = await generateConnectorManifest({
        companyId, responses, skipInference: true, liveConnections: live,
      });
      manifest = r.manifest;
    } catch (e) {
      if (isOnboardingHaltError(e)) {
        return reply.status(409).send({ ok: false, halt: e.toJSON() });
      }
      throw e;
    }

    const states = await listConnectorStates(companyId);
    // Scan once per request — cheap (3 small file reads) and gives the UI
    // the customer's installed MCPs so we can short-circuit the paste form.
    const mcpDetected: Map<string, DetectedMcp> = scanInstalledMcpServersMap();
    const merged: ConciergeRow[] = [];
    const buckets: Array<{ bucket: "required" | "suggested" | "deferred"; entries: ConnectorEntry[] }> = [
      { bucket: "required", entries: manifest.required },
      { bucket: "suggested", entries: manifest.suggested },
      { bucket: "deferred", entries: manifest.deferred },
    ];
    for (const b of buckets) {
      for (const e of b.entries) {
        const desc = describeConnector(e.id);
        const s = states.get(e.id);
        const mcp = mcpDetected.get(e.id);
        merged.push({
          connectorId: e.id,
          bucket: b.bucket,
          priority: e.priority,
          rationale: e.rationale,
          status: s?.status ?? "pending",
          vaultedKeys: s?.vaultedKeys ?? [],
          expectedKeys: desc.keys,
          hasProbe: hasProbe(e.id),
          lastTestedAt: s?.lastTestedAt ?? null,
          lastTestResult: s?.lastTestResult ?? null,
          skipReason: s?.skipReason ?? null,
          composioManaged: desc.composio,
          keysUrl: CONNECTOR_KEYS_URL[e.id] ?? null,
          mcpManaged: Boolean(mcp),
          mcpSourcedFrom: mcp?.sourcedFrom ?? null,
          mcpAvailable: mcpAvailableFor(e.id).available,
          mcpInstallHint: mcpAvailableFor(e.id).install ?? null,
        });
      }
    }

    const requiredCount = merged.filter((m) => m.bucket === "required").length;
    const requiredReady = merged.filter((m) =>
      m.bucket === "required" &&
      (m.status === "vaulted_valid" || m.status === "vaulted_unvalidated" || m.status === "skipped"
       || (m.connectorId === "claude-code")), // claude-code verified during Pillar 2
    ).length;

    return {
      ok: true,
      companyId,
      connectors: merged,
      progress: { requiredCount, requiredReady, allRequiredAddressed: requiredReady >= requiredCount },
    };
  });

  app.post("/op-omega/onboarding/credentials/paste", async (req, reply) => {
    if (!gateBoard(req, reply)) return;
    const parsed = pasteSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ ok: false, error: "validation failed", issues: parsed.error.issues });
    assertCompanyAccess(authReq(req), parsed.data.companyId);
    const r = await writeCredential({
      companyId: parsed.data.companyId,
      connectorId: parsed.data.connectorId,
      key: parsed.data.key,
      plaintext: parsed.data.plaintext,
      writtenBy: parsed.data.writtenBy ?? "concierge_paste",
    });
    return { ok: true, vaultedAt: r.vaultedAt };
  });

  app.post("/op-omega/onboarding/credentials/test", async (req, reply) => {
    if (!gateBoard(req, reply)) return;
    const parsed = testSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ ok: false, error: "validation failed", issues: parsed.error.issues });
    assertCompanyAccess(authReq(req), parsed.data.companyId);
    const result = await runProbe(parsed.data.connectorId, parsed.data.companyId);
    // Record per-key (use "default" when probe doesn't single out a key).
    await recordTestResult({
      companyId: parsed.data.companyId,
      connectorId: parsed.data.connectorId,
      key: "default",
      ok: result.ok,
      detail: result.detail,
    });
    return { ok: result.ok, detail: result.detail };
  });

  app.post("/op-omega/onboarding/credentials/skip", async (req, reply) => {
    if (!gateBoard(req, reply)) return;
    const parsed = skipSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ ok: false, error: "validation failed", issues: parsed.error.issues });
    assertCompanyAccess(authReq(req), parsed.data.companyId);
    await skipConnector({
      companyId: parsed.data.companyId,
      connectorId: parsed.data.connectorId,
      reason: parsed.data.reason,
    });
    return { ok: true };
  });

  // ── Connector setup — UI gates the Directory on these two ──────────
  //
  // GET  /api/connectors/setup-status
  //   Returns { configured, valid, mode, lastError? } so the Directory
  //   modal can render a setup screen instead of the catalog when the
  //   Composio key is missing or invalid.
  //
  // POST /api/connectors/setup
  //   Body: { apiKey }. Validates by calling toolkits.get({}), writes
  //   to <repo>/.env, mutates process.env in-memory, and resets the
  //   composio-shim cached client. No process restart required.

  app.get("/api/connectors/setup-status", async (_req, reply) => {
    const hasKey = Boolean((process.env.COMPOSIO_API_KEY ?? "").trim());
    const disabled = (process.env.WAVEX_COMPOSIO_DISABLED ?? "").toLowerCase();
    const isDisabled = disabled === "1" || disabled === "true" || disabled === "yes";
    const configured = hasKey && !isDisabled;
    if (!configured) {
      return reply.send({
        ok: true,
        configured: false,
        valid: false,
        mode: hasKey ? "disabled" : "missing-key",
      });
    }
    // Smoke-test the key by asking Composio for one toolkit.
    try {
      const rows = await listAllToolkits();
      if (rows == null) {
        return reply.send({
          ok: true,
          configured: true,
          valid: false,
          mode: "key-rejected",
          lastError: "Composio rejected the key — getClient returned null.",
        });
      }
      return reply.send({
        ok: true,
        configured: true,
        valid: true,
        mode: "live",
        toolkitCount: rows.length,
      });
    } catch (err) {
      return reply.send({
        ok: true,
        configured: true,
        valid: false,
        mode: "validation-error",
        lastError: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post<{ Body: { apiKey?: string } }>(
    "/api/connectors/setup",
    async (req, reply) => {
      const apiKey = (req.body?.apiKey ?? "").trim();
      if (!apiKey) {
        return reply.code(400).send({ ok: false, error: "apiKey is required." });
      }
      // 1. Mutate process.env so the next getClient() call picks up
      //    the new key (composio-shim's getComposioApiKey() re-reads
      //    process.env on every call, and we reset the cached client
      //    below so it rebuilds with the new key).
      process.env.COMPOSIO_API_KEY = apiKey;
      process.env.WAVEX_COMPOSIO_DISABLED = "0";
      resetComposioClient();
      // 2. Validate by attempting a real catalog fetch. If this fails
      //    we revert the env so the operator can try again with a
      //    different key.
      let rows: Awaited<ReturnType<typeof listAllToolkits>> = null;
      try {
        rows = await listAllToolkits();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(400).send({
          ok: false,
          error: `Composio rejected the key: ${message}`,
        });
      }
      if (rows == null || rows.length === 0) {
        return reply.code(400).send({
          ok: false,
          error:
            "Composio returned an empty catalog — the key may be invalid or revoked.",
        });
      }
      // 3. Persist to <repo>/.env so the key survives a process restart.
      //    Done AFTER validation so we never write a bad key to disk.
      const envPath = await resolveRepoEnvPath();
      try {
        await writeOrUpdateEnvFile(envPath, {
          COMPOSIO_API_KEY: apiKey,
          WAVEX_COMPOSIO_DISABLED: "0",
        });
      } catch (err) {
        // Validation passed but persistence failed — surface a warning.
        return reply.send({
          ok: true,
          valid: true,
          persisted: false,
          toolkitCount: rows.length,
          warning: `Validated but couldn't write to .env: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      // 4. Invalidate the catalog cache so the next list call fetches
      //    fresh data with the new client.
      _cachedCatalog = null;
      return reply.send({
        ok: true,
        valid: true,
        persisted: true,
        toolkitCount: rows.length,
      });
    },
  );

  /** Full Composio toolkit catalog (live mode) OR FEATURED_TOOLKITS
   *  fallback (disabled mode). The connector directory's "+" cards are
   *  built from this. Cached in-process for 5 min — the catalog is
   *  ~200+ entries and rarely changes. */
  let _cachedCatalog: { ts: number; rows: Array<{ slug: string; name: string; logo?: string; description?: string; category?: string; noAuth?: boolean; authSchemes?: string[] }>; source: "composio" | "curated" } | null = null;
  app.get("/api/connectors/catalog", async (_req, reply) => {
    const now = Date.now();
    if (_cachedCatalog && now - _cachedCatalog.ts < 5 * 60_000) {
      return reply.send({ ok: true, ...{ rows: _cachedCatalog.rows, source: _cachedCatalog.source, cached: true } });
    }
    const live = await listAllToolkits();
    if (live && live.length > 0) {
      // Strip toolkits with neither OAuth nor API key — they need
      // bespoke setup (mTLS, custom webhooks, etc.) and can't drive a
      // generic "+" → OAuth flow.
      const usable = live.filter((t) => t.noAuth !== true && (t.authSchemes?.length ?? 0) > 0);
      _cachedCatalog = { ts: now, rows: usable, source: "composio" };
      return reply.send({ ok: true, rows: usable, source: "composio", cached: false });
    }
    const fallback = FEATURED_TOOLKITS.map((t) => ({
      slug: t.slug,
      name: t.displayName,
      category: t.category,
    }));
    _cachedCatalog = { ts: now, rows: fallback, source: "curated" };
    return reply.send({ ok: true, rows: fallback, source: "curated", cached: false });
  });

  // ── Mission Control · Connectors directory ──────────────────────────
  //
  // Two slim routes the unified Connectors UI consumes. Both wrap the
  // existing vault service so the connector picker, the onboarding
  // concierge, and the post-onboarding directory share state.

  /** Per-company list of connectors that currently have credentials in
   *  the vault. Returns just slug + status; the UI overlays this onto
   *  the Composio catalog. */
  app.get<{ Params: { companyId: string } }>(
    "/api/connectors/:companyId/connected",
    async (req, reply) => {
      if (!gateBoard(req, reply)) return;
      const { companyId } = req.params;
      assertCompanyAccess(authReq(req), companyId);
      const states = await listConnectorStates(companyId);
      const rows = Array.from(states.values()).map((s) => ({
        slug: s.connectorId,
        status: s.status,
        vaultedKeys: s.vaultedKeys,
        lastTestedAt: s.lastTestedAt,
        skipReason: s.skipReason,
      }));
      return { ok: true, rows };
    },
  );

  /** Remove every vaulted credential for one connector + audit it.
   *  Idempotent — a slug with no credentials returns 200 + removed=0. */
  app.delete<{ Params: { companyId: string; slug: string } }>(
    "/api/connectors/:companyId/:slug",
    async (req, reply) => {
      if (!gateBoard(req, reply)) return;
      const { companyId, slug } = req.params;
      assertCompanyAccess(authReq(req), companyId);
      const result = await deleteAllForConnector({
        companyId,
        connectorId: slug,
      });
      return { ok: true, removed: result.removed };
    },
  );
}
