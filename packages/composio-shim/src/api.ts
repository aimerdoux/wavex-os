/** Public surface used by the wavex-os onboarding routes + UI.
 *
 *  Live mode: dispatches to @composio/core when COMPOSIO_API_KEY is set
 *  and WAVEX_COMPOSIO_DISABLED is unset/0. Live OAuth uses
 *  `composio.toolkits.authorize()` which creates an auth config if absent,
 *  initiates a connected-account request, and returns a redirect URL the
 *  UI opens in a new window. Composio handles the OAuth roundtrip.
 *
 *  Disabled mode: every method returns the no-op equivalent (empty array,
 *  null, etc.) so the rest of the onboarding pipeline runs end-to-end
 *  without a Composio account.
 */

import type {
  ApiKeyValidation,
  FeaturedToolkit,
  LiveConnectorRow,
  OAuthInitResult,
} from "./types.js";
import { FEATURED_TOOLKITS } from "./featured-toolkits.js";
import { getComposioApiKey, getComposioMode } from "./mode.js";

// Lazily import @composio/core so disabled mode never loads it.
let cachedClient: import("@composio/core").Composio | null = null;
let cachedClientKey: string | null = null;
async function getClient(): Promise<import("@composio/core").Composio | null> {
  if (getComposioMode() === "disabled") return null;
  const key = getComposioApiKey();
  if (!key) return null;
  // Invalidate the cached client if the env key changed (e.g., the
  // operator just plugged a new key via the setup UI). Without this
  // check we'd keep using the old client until restart.
  if (cachedClient && cachedClientKey === key) return cachedClient;
  const { Composio } = await import("@composio/core");
  cachedClient = new Composio({ apiKey: key });
  cachedClientKey = key;
  return cachedClient;
}

/** Drop the cached client so the next getClient() call re-reads
 *  process.env and rebuilds. Called by the setup endpoint after it
 *  writes a new key to .env + mutates process.env in-memory. */
export function _resetClient(): void {
  cachedClient = null;
  cachedClientKey = null;
}

export function getFeaturedToolkits(): FeaturedToolkit[] {
  return [...FEATURED_TOOLKITS];
}

/** Full Composio catalog (live mode only). Returns hundreds of toolkits
 *  with logos, descriptions, categories. Used by the Mission Control
 *  Connectors directory to populate the browsable grid. In disabled
 *  mode returns null so callers can fall back to FEATURED_TOOLKITS. */
export interface CatalogToolkit {
  slug: string;
  name: string;
  logo?: string;
  description?: string;
  category?: string;
  toolsCount?: number;
  authSchemes?: string[];
  noAuth?: boolean;
}
export async function listAllToolkits(): Promise<CatalogToolkit[] | null> {
  const client = await getClient();
  if (!client) return null;
  try {
    const tk = client.toolkits as unknown as {
      get: (q: Record<string, unknown>) => Promise<
        Array<{
          slug: string;
          name: string;
          meta?: {
            logo?: string;
            description?: string;
            categories?: Array<{ slug: string; name: string }>;
            toolsCount?: number;
          };
          isLocalToolkit?: boolean;
          authSchemes?: string[];
          noAuth?: boolean;
        }>
      >;
    };
    const rows = await tk.get({});
    return rows.map((r) => ({
      slug: r.slug,
      name: r.name,
      logo: r.meta?.logo,
      description: r.meta?.description,
      category: r.meta?.categories?.[0]?.slug,
      toolsCount: r.meta?.toolsCount,
      authSchemes: r.authSchemes,
      noAuth: r.noAuth,
    }));
  } catch (err) {
    console.warn("[composio-shim] listAllToolkits failed:", (err as Error).message);
    return null;
  }
}

export async function listConnections(companyId: string): Promise<LiveConnectorRow[]> {
  const client = await getClient();
  if (!client) return [];
  try {
    // Composio scopes connections by userId. We mint a deterministic
    // userId per wavex-os company so re-listing returns the same set.
    const userId = composioCompanyUser(companyId);
    const resp = (await client.connectedAccounts.list({ userIds: [userId] })) as unknown as {
      items?: Array<{
        id?: string;
        toolkit?: { slug?: string; displayName?: string };
        authConfig?: { id?: string };
        authConfigId?: string;
        toolkitSlug?: string;
        scopes?: string[];
        createdAt?: string;
      }>;
    };
    return (resp.items ?? []).map((c) => ({
      toolkitSlug: String(c.toolkit?.slug ?? c.toolkitSlug ?? ""),
      composioConnectionId: String(c.id ?? ""),
      composioAuthConfigId: c.authConfig?.id ?? c.authConfigId ?? null,
      displayName: c.toolkit?.displayName ?? null,
      scopes: Array.isArray(c.scopes) ? c.scopes : null,
      connectedAt: c.createdAt ? new Date(c.createdAt) : null,
    }));
  } catch (err) {
    console.warn("[composio-shim] listConnections live call failed:", (err as Error).message);
    return [];
  }
}

export async function validateApiKey(key: string | undefined): Promise<ApiKeyValidation> {
  if (getComposioMode() === "disabled") return { ok: false, reason: "disabled", mode: "dev" };
  const effective = key ?? getComposioApiKey();
  if (!effective) return { ok: false, reason: "COMPOSIO_API_KEY missing" };
  try {
    const { Composio } = await import("@composio/core");
    const c = new Composio({ apiKey: effective });
    // Probe a well-known toolkit. Fails fast on bad key (401), succeeds
    // on any valid key regardless of plan tier.
    await (c.toolkits as unknown as { get: (s: string) => Promise<unknown> }).get("gmail");
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `composio_api_rejected: ${(err as Error).message}` };
  }
}

export async function initOAuth(params: {
  companyId: string;
  userId?: string;
  toolkitSlug: string;
  callbackUrl: string;
}): Promise<OAuthInitResult> {
  const client = await getClient();
  if (!client) {
    return { url: null, pendingConnectionId: null, needsLiveWiring: true };
  }
  try {
    const userId = composioCompanyUser(params.companyId, params.userId);
    // toolkits.authorize handles auth-config creation + connected-account
    // initiation in one call. Returns ConnectionRequest with redirectUrl + id.
    const tk = client.toolkits as unknown as {
      authorize: (
        userId: string,
        toolkitSlug: string,
      ) => Promise<{ id: string; status?: string; redirectUrl?: string | null }>;
    };
    const conn = await tk.authorize(userId, params.toolkitSlug);
    return {
      url: conn.redirectUrl ?? null,
      pendingConnectionId: conn.id ?? null,
    };
  } catch (err) {
    console.warn(
      `[composio-shim] initOAuth(${params.toolkitSlug}) failed:`,
      (err as Error).message,
    );
    return { url: null, pendingConnectionId: null, needsLiveWiring: true };
  }
}

/** Poll Composio for a pending-connection's status. Returns the bucketed
 *  status so the caller can update tools.json accordingly. */
export async function getConnectionStatus(connectionId: string): Promise<{
  status: "active" | "pending" | "failed" | "unknown";
  error?: string;
}> {
  const client = await getClient();
  if (!client) return { status: "unknown", error: "composio_disabled" };
  try {
    const ca = client.connectedAccounts as unknown as {
      get: (id: string) => Promise<{ status?: string }>;
    };
    const conn = await ca.get(connectionId);
    const raw = String(conn.status ?? "").toLowerCase();
    if (["active", "connected", "succeeded"].includes(raw)) return { status: "active" };
    if (["pending", "initiated", "in_progress", "initializing"].includes(raw)) return { status: "pending" };
    if (["failed", "error", "expired", "deleted"].includes(raw)) return { status: "failed" };
    return { status: "unknown", error: `composio_status=${raw}` };
  } catch (err) {
    return { status: "unknown", error: (err as Error).message };
  }
}

/** Health probe: confirms the connection is still active and Composio
 *  can reach the third-party. Used by the connector-health-check agent
 *  during onboarding (and continuously thereafter). */
export async function pingConnection(args: {
  connectionId: string;
  toolkitSlug: string;
}): Promise<{ ok: boolean; error?: string }> {
  const client = await getClient();
  if (!client) return { ok: false, error: "composio_disabled" };
  try {
    const status = await getConnectionStatus(args.connectionId);
    if (status.status !== "active") return { ok: false, error: status.error ?? status.status };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export function composioUserId(companyId: string, userId: string): string {
  return `wavex/${companyId}/${userId}`;
}

/** Deterministic Composio userId scoped to a wavex company. When the caller
 *  doesn't have a stable user id (e.g. avatar onboarding before sign-in),
 *  fall back to a company-scoped "anon" namespace. */
function composioCompanyUser(companyId: string, userId?: string): string {
  return userId ? `wavex/${companyId}/${userId}` : `wavex/${companyId}/anon`;
}
