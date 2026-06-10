/** Connectors OAuth + health-check routes (post-PR#4 live wiring).
 *
 *  Two surfaces:
 *
 *    POST /wavex-os/onboarding/connectors/oauth/initiate
 *      Body: { companyId, userId?, toolkitSlug, callbackUrl? }
 *      → Returns { url, pendingConnectionId, needsLiveWiring? }
 *      UI opens `url` in a popup; the user completes OAuth on Composio's
 *      hosted page; Composio redirects to callbackUrl on success.
 *
 *    GET /wavex-os/onboarding/connectors/oauth/callback
 *      Query: ?pending_connection_id=...&company_id=...&toolkit_slug=...
 *      Composio (or the UI's popup callback) hits this after OAuth
 *      completes. Finalizes the tools.json entry from "pending" → "connected".
 *
 *    POST /wavex-os/onboarding/connectors/health-check
 *      Body: { companyId, avatarId? }
 *      → Returns { results: [{ toolkit, ok, error? }] }
 *      Pings each connection via Composio. Called by the
 *      connector-health-check agent on heartbeat AND by the wizard at
 *      end of onboarding to validate every connector works.
 *
 *  All routes are no-ops in disabled mode (composio-shim returns
 *  needsLiveWiring=true and the UI falls back to manual key entry).
 */
import type { FastifyInstance } from "fastify";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  initOAuth,
  getConnectionStatus,
  pingConnection,
  listConnections,
  getCredentialRequirements,
  connectWithCredentials,
} from "@wavex-os/composio-shim";
import { getInferenceMode } from "@wavex-os/inference-adapter";
import { emitInferenceHookEvent } from "../inference-hooks-client.js";

/** When the customer's stack is in hosted mode (their installer pointed
 *  WAVEX_INFERENCE_HUB_URL at the operator's Mac mini), we PROXY the
 *  OAuth initiate to the hub so the customer's local environment doesn't
 *  need a COMPOSIO_API_KEY. Returns null if hosted mode isn't on, in
 *  which case the caller falls back to local composio-shim. */
/** Mint a Pool-A session token from the hub. Reused by initiate + list proxies. */
async function hubSessionToken(args: { installId: string; email: string }): Promise<{ hub: string; token: string } | null> {
  if (getInferenceMode() !== "hosted") return null;
  const hub = (process.env.WAVEX_INFERENCE_HUB_URL ?? "").replace(/\/+$/, "");
  if (!hub) return null;
  try {
    const sessResp = await fetch(`${hub}/v1/onboarding/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: args.email, install_id: args.installId }),
    });
    if (!sessResp.ok) return null;
    const { token } = (await sessResp.json()) as { token: string };
    return { hub, token };
  } catch {
    return null;
  }
}

async function proxyToHubInitiate(args: {
  toolkitSlug: string;
  installId: string;
  email: string;
  redirectBackUrl?: string;
}): Promise<{ url: string | null; pendingConnectionId: string | null; needsLiveWiring?: boolean; reason?: string } | null> {
  const session = await hubSessionToken(args);
  if (!session) {
    if (getInferenceMode() !== "hosted") return null;
    return { url: null, pendingConnectionId: null, needsLiveWiring: true };
  }
  try {
    const initResp = await fetch(`${session.hub}/v1/connectors/oauth/initiate`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.token}` },
      body: JSON.stringify({
        toolkit_slug: args.toolkitSlug,
        redirect_back_url: args.redirectBackUrl,
      }),
    });
    if (!initResp.ok) {
      const body = (await initResp.json().catch(() => ({}))) as { error?: string };
      return {
        url: null,
        pendingConnectionId: null,
        needsLiveWiring: body.error === "composio_unavailable",
      };
    }
    const r = (await initResp.json()) as { redirect_url: string | null; pending_connection_id: string | null };
    return { url: r.redirect_url, pendingConnectionId: r.pending_connection_id };
  } catch {
    return { url: null, pendingConnectionId: null, needsLiveWiring: true };
  }
}

interface HubConnection {
  id: string | null;
  toolkit_slug: string | undefined;
  display_name: string | null;
  status: string;
  connected_at: string | null;
}

/** Forward the customer's local request to the hub's /v1/connectors/list,
 *  so the wizard can poll a single endpoint and we keep the per-customer
 *  userId namespacing on the hub. Returns null when not hosted. */
async function proxyToHubList(args: { installId: string; email: string }): Promise<{ connections: HubConnection[] } | null> {
  const session = await hubSessionToken(args);
  if (!session) return null;
  try {
    const resp = await fetch(
      `${session.hub}/v1/connectors/list?install_id=${encodeURIComponent(args.installId)}&email=${encodeURIComponent(args.email)}`,
      { headers: { Authorization: `Bearer ${session.token}` } },
    );
    if (!resp.ok) return { connections: [] };
    return (await resp.json()) as { connections: HubConnection[] };
  } catch {
    return { connections: [] };
  }
}

function installIdFromState(): string {
  try {
    const path = join(homedir(), ".wavex-os", "install.json");
    if (existsSync(path)) {
      const j = JSON.parse(require("node:fs").readFileSync(path, "utf8")) as { install_id?: string };
      if (j.install_id) return j.install_id;
    }
  } catch { /* fall through */ }
  return "anon";
}

interface AvatarToolEntry {
  provider: string;
  ref: string;
  status: "stub" | "pending" | "connected" | "failed";
  connected_at: string;
  pending_connection_id?: string;
  last_health_check?: string;
  last_error?: string;
}
interface AvatarToolsFile {
  connected: AvatarToolEntry[];
  skipped: boolean;
  meta?: Record<string, unknown>;
}

function stateRoot(): string {
  return process.env.WAVEX_OS_STATE_DIR ?? join(homedir(), ".wavex-os");
}
function avatarDir(avatarId: string): string {
  return join(stateRoot(), "instances", "default", "avatars", avatarId);
}

async function readToolsFile(avatarId: string): Promise<AvatarToolsFile | null> {
  const path = join(avatarDir(avatarId), "tools.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, "utf8")) as AvatarToolsFile;
  } catch {
    return null;
  }
}
async function writeToolsFile(avatarId: string, file: AvatarToolsFile): Promise<void> {
  const dir = avatarDir(avatarId);
  // Defensive — when the OAuth flow is invoked with a non-avatar context
  // (e.g. companyId mistakenly passed as avatarId, or the customer hasn't
  // created the avatar yet), the dir won't exist and writeFile would
  // ENOENT-500 the route. Silently no-op in that case; the OAuth still
  // completes successfully on the hub side, and tools.json gets created
  // by the regular avatar onboarding flow when the avatar is initialized.
  if (!existsSync(dir)) return;
  const path = join(dir, "tools.json");
  await writeFile(path, JSON.stringify(file, null, 2), "utf8");
}

interface InitiateBody {
  companyId: string;
  userId?: string;
  avatarId?: string;
  toolkitSlug: string;
  callbackUrl?: string;
}

interface CallbackQuery {
  pending_connection_id?: string;
  company_id?: string;
  avatar_id?: string;
  toolkit_slug?: string;
}

interface HealthCheckBody {
  companyId: string;
  avatarId?: string;
}

export function registerConnectorRoutes(app: FastifyInstance): void {
  // ── 1. Initiate OAuth ─────────────────────────────────────────────────
  app.post<{ Body: InitiateBody }>(
    "/wavex-os/onboarding/connectors/oauth/initiate",
    async (req, reply) => {
      const { companyId, userId, avatarId, toolkitSlug, callbackUrl } = req.body ?? ({} as InitiateBody);
      if (!companyId || !toolkitSlug) {
        return reply.code(400).send({ error: "companyId + toolkitSlug required" });
      }
      const origin = `${req.protocol}://${req.headers.host}`;
      const cbUrl =
        callbackUrl ??
        `${origin}/wavex-os/onboarding/connectors/oauth/callback` +
          `?company_id=${encodeURIComponent(companyId)}` +
          (avatarId ? `&avatar_id=${encodeURIComponent(avatarId)}` : "") +
          `&toolkit_slug=${encodeURIComponent(toolkitSlug)}`;
      // Try hub-proxy first (hosted mode); fall back to local composio-shim.
      const hubResult = await proxyToHubInitiate({
        toolkitSlug,
        installId: installIdFromState(),
        email: (userId as string | undefined) ?? "anon@wavex-os.local",
        redirectBackUrl: `${origin}/onboarding?companyId=${encodeURIComponent(companyId)}&connector_oauth=ok&toolkit=${encodeURIComponent(toolkitSlug)}`,
      });
      const result = hubResult ?? await initOAuth({
        companyId,
        userId,
        toolkitSlug,
        callbackUrl: cbUrl,
      });

      // Real connector failures (not "needs credentials" classifications)
      // land on the inference surface so the middleware fixer sees them.
      if (result.needsLiveWiring && result.reason === "authorize_failed") {
        emitInferenceHookEvent({
          type: "connector_failed",
          companyId,
          errorCode: "composio_authorize_failed",
          detail: `toolkit=${toolkitSlug}`,
        });
      }

      // Optimistically record pending in tools.json so the UI can poll
      // /wavex-os/onboarding/avatar/:id (which already returns tools) to
      // detect when this entry transitions to "connected".
      if (avatarId && result.pendingConnectionId) {
        const cur = (await readToolsFile(avatarId)) ?? { connected: [], skipped: false };
        const without = cur.connected.filter((c) => c.provider !== toolkitSlug);
        cur.connected = [
          ...without,
          {
            provider: toolkitSlug,
            ref: result.pendingConnectionId,
            status: "pending",
            connected_at: new Date().toISOString(),
            pending_connection_id: result.pendingConnectionId,
          },
        ];
        await writeToolsFile(avatarId, cur);
      }

      return reply.send(result);
    },
  );

  // ── 1a. Custom-credentials flow (toolkits without Composio-managed OAuth) ─
  //
  // GET returns the form fields the customer must fill (auth scheme +
  // creation/initiation fields merged); POST creates a use_custom_auth
  // auth config + connected account with those credentials. Backs the
  // Directory's "requires_custom_credentials" path (e.g. Amplitude).
  app.get<{ Params: { toolkitSlug: string }; Querystring: { fieldsFor?: string } }>(
    "/wavex-os/onboarding/connectors/credential-requirements/:toolkitSlug",
    async (req, reply) => {
      const slug = (req.params.toolkitSlug ?? "").trim().toLowerCase();
      if (!slug) return reply.code(400).send({ error: "toolkitSlug required" });
      const fieldsFor = req.query.fieldsFor === "initiation" ? "initiation" : "all";
      return reply.send(await getCredentialRequirements(slug, { fieldsFor }));
    },
  );

  app.post<{
    Body: {
      companyId: string;
      userId?: string;
      toolkitSlug: string;
      authScheme: string;
      credentials: Record<string, string>;
    };
  }>(
    "/wavex-os/onboarding/connectors/connect-with-credentials",
    async (req, reply) => {
      const { companyId, userId, toolkitSlug, authScheme, credentials } = req.body ?? {};
      if (!companyId || !toolkitSlug || !authScheme || !credentials || Object.keys(credentials).length === 0) {
        return reply.code(400).send({ error: "companyId + toolkitSlug + authScheme + credentials required" });
      }
      const result = await connectWithCredentials({ companyId, userId, toolkitSlug, authScheme, credentials });
      return reply.send(result);
    },
  );

  // ── 1b. List the customer's hub-tracked connections (hosted mode only) ─
  //
  // Used by the wizard's Credential Concierge to poll for "pending → active"
  // transitions after it opens the OAuth popup. In non-hosted mode this is
  // a no-op (returns []) — the local composio-shim already exposes its own
  // list via the avatar tools.json + listConnections() health-check route.
  app.get<{ Querystring: { userId?: string; email?: string } }>(
    "/wavex-os/onboarding/connectors/list",
    async (req, reply) => {
      const installId = installIdFromState();
      const email = (req.query.email ?? req.query.userId ?? "").trim() || "anon@wavex-os.local";
      const hub = await proxyToHubList({ installId, email });
      if (hub) return reply.send(hub);
      return reply.send({ connections: [] });
    },
  );

  // ── 2. OAuth callback (Composio hits this) ────────────────────────────
  app.get<{ Querystring: CallbackQuery }>(
    "/wavex-os/onboarding/connectors/oauth/callback",
    async (req, reply) => {
      const { pending_connection_id, avatar_id, toolkit_slug } = req.query;
      if (!pending_connection_id || !toolkit_slug) {
        return reply
          .type("text/html")
          .send(htmlClose("Missing connection id or toolkit_slug in callback"));
      }
      const status = await getConnectionStatus(pending_connection_id);
      if (avatar_id) {
        const cur = (await readToolsFile(avatar_id)) ?? { connected: [], skipped: false };
        const idx = cur.connected.findIndex((c) => c.provider === toolkit_slug);
        const newEntry: AvatarToolEntry = {
          provider: toolkit_slug,
          ref: pending_connection_id,
          status: status.status === "active" ? "connected" : status.status === "pending" ? "pending" : "failed",
          connected_at: new Date().toISOString(),
          pending_connection_id,
          last_health_check: new Date().toISOString(),
          ...(status.error ? { last_error: status.error } : {}),
        };
        if (idx === -1) cur.connected.push(newEntry);
        else cur.connected[idx] = newEntry;
        await writeToolsFile(avatar_id, cur);
      }
      // Return a tiny HTML page that closes itself; the wizard polls
      // /api/avatar/:id to detect the connection completion.
      return reply.type("text/html").send(htmlClose(`Connected ${toolkit_slug}. You can close this window.`));
    },
  );

  // ── 3. Health-check ───────────────────────────────────────────────────
  app.post<{ Body: HealthCheckBody }>(
    "/wavex-os/onboarding/connectors/health-check",
    async (req, reply) => {
      const { companyId, avatarId } = req.body ?? ({} as HealthCheckBody);
      if (!companyId) return reply.code(400).send({ error: "companyId required" });

      const tools = avatarId ? await readToolsFile(avatarId) : null;
      const fromAvatar = (tools?.connected ?? []).filter(
        (c) => c.status === "connected" || c.status === "pending",
      );

      // Belt + suspenders: also list Composio-side connections in case the
      // avatar tools.json is stale.
      const composioRows = await listConnections(companyId);

      const set = new Map<string, { ref: string; toolkit: string }>();
      for (const t of fromAvatar) {
        if (t.pending_connection_id || t.ref) {
          set.set(t.pending_connection_id ?? t.ref, { ref: t.pending_connection_id ?? t.ref, toolkit: t.provider });
        }
      }
      for (const c of composioRows) {
        if (c.composioConnectionId) {
          set.set(c.composioConnectionId, { ref: c.composioConnectionId, toolkit: c.toolkitSlug });
        }
      }

      const results: Array<{
        toolkit: string;
        connection_id: string;
        ok: boolean;
        error?: string;
      }> = [];
      for (const { ref, toolkit } of set.values()) {
        const r = await pingConnection({ connectionId: ref, toolkitSlug: toolkit });
        results.push({ toolkit, connection_id: ref, ok: r.ok, ...(r.error ? { error: r.error } : {}) });
      }

      // Update tools.json with latest health-check timestamps + errors.
      if (avatarId && tools) {
        for (const r of results) {
          const idx = tools.connected.findIndex(
            (c) => c.pending_connection_id === r.connection_id || c.ref === r.connection_id,
          );
          if (idx === -1) continue;
          tools.connected[idx] = {
            ...tools.connected[idx],
            last_health_check: new Date().toISOString(),
            status: r.ok ? "connected" : "failed",
            ...(r.error ? { last_error: r.error } : { last_error: undefined }),
          };
        }
        await writeToolsFile(avatarId, tools);
      }

      return reply.send({
        company_id: companyId,
        avatar_id: avatarId ?? null,
        checked_at: new Date().toISOString(),
        results,
        all_healthy: results.length > 0 && results.every((r) => r.ok),
      });
    },
  );
}

function htmlClose(message: string): string {
  return `<!doctype html><meta charset="utf-8"><title>WaveX OAuth</title>
<style>body{font-family:system-ui;padding:48px;text-align:center;}</style>
<p>${message}</p>
<script>setTimeout(() => window.close(), 1500);</script>`;
}
