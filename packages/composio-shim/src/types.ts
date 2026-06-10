/** Composio surface types matching the LiveConnectorRow shape that wavex-os's
 *  Phase 2 generator consumes. When wavex-os is wired to a real Composio
 *  account, these come from @composio/core; otherwise they're empty arrays. */

export interface LiveConnectorRow {
  toolkitSlug: string;
  composioConnectionId: string;
  composioAuthConfigId: string | null;
  displayName: string | null;
  scopes: string[] | null;
  connectedAt: Date | null;
}

export interface FeaturedToolkit {
  slug: string;
  displayName: string;
  category: "comms" | "crm" | "billing" | "analytics" | "dev" | "ops" | "other";
  /** Brand logo URL for the curated/offline catalog. Live Composio mode
   *  supplies its own logos via toolkit.meta.logo; this is the fallback so
   *  the directory still shows real logos when the live catalog is down. */
  logo?: string;
}

export type ApiKeyValidation =
  | { ok: true }
  | { ok: false; reason: string }
  | { ok: false; reason: "disabled"; mode: "dev" };

export interface OAuthInitResult {
  url: string | null;
  pendingConnectionId: string | null;
  /** Set when live mode is on but real Composio wiring isn't in place
   *  yet. UI surfaces a "needs setup" callout instead of failing silently. */
  needsLiveWiring?: boolean;
  /** Why OAuth init produced no URL, so the UI shows an accurate message
   *  instead of mislabelling every failure as "Composio is disabled":
   *  - "disabled": no key / WAVEX_COMPOSIO_DISABLED on
   *  - "requires_custom_credentials": Composio has no managed OAuth for this
   *    toolkit — the customer must supply their own credentials via the
   *    credential-fields flow
   *  - "authorize_failed": live Composio call failed (transient/other) */
  reason?: "disabled" | "requires_custom_credentials" | "authorize_failed";
}

/** One input the customer must fill to connect a toolkit that has no
 *  Composio-managed OAuth (API key, bearer token, custom OAuth app…). */
export interface CredentialField {
  name: string;
  displayName: string;
  type: string;
  required: boolean;
  description?: string | null;
}

export interface CredentialRequirements {
  ok: boolean;
  toolkitSlug: string;
  /** chosen auth scheme, e.g. "API_KEY" | "BEARER_TOKEN" | "BASIC" | "OAUTH2" */
  authScheme: string | null;
  fields: CredentialField[];
  error?: string;
}
