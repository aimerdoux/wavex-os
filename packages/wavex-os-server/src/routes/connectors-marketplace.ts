/** GET /api/connectors/marketplace
 *
 *  Connector marketplace endpoint — drives the Paperclip wavex-os
 *  plugin's marketplace widget. Returns the full FEATURED_TOOLKITS
 *  catalog merged with live connection state for the customer's active
 *  company.
 *
 *  Response shape:
 *    {
 *      ok: true,
 *      company_id: string | null,
 *      connectors: Array<{
 *        slug: string,
 *        display_name: string,
 *        category: string,
 *        // resolution: which path is BEST for this connector
 *        path: "mcp" | "oauth" | "key" | "unsupported",
 *        // current state for this company
 *        status: "connected" | "pending" | "available" | "needs_key" | "skipped",
 *        // optional helpers — UI uses these for the action button
 *        oauth_initiate_url?: string,    // POST target to start OAuth
 *        docs_url?: string,               // fallback help link
 *      }>
 *    }
 *
 *  This endpoint is intentionally permissive about companyId — the
 *  Paperclip plugin doesn't know it; we default to whatever active
 *  company exists in ~/.wavex-os/instances/default/companies/ (the
 *  most-recently-modified one).
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { readdir, stat as fsStat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { FEATURED_TOOLKITS, listAllToolkits } from "@wavex-os/composio-shim";
import { listConnectorStates } from "../vault/service.js";
import { assertBoard, AuthError } from "@wavex-os/auth-shim";

type Path = "mcp" | "oauth" | "key" | "unsupported";
type Status = "connected" | "pending" | "available" | "needs_key" | "skipped";

interface MarketplaceConnector {
  slug: string;
  display_name: string;
  category: string;
  path: Path;
  status: Status;
  oauth_initiate_url?: string;
  docs_url?: string;
}

const DOCS_URL_BY_SLUG: Record<string, string> = {
  slack: "https://api.slack.com/apps",
  telegram: "https://core.telegram.org/bots#how-do-i-create-a-bot",
  discord: "https://discord.com/developers/applications",
  gmail: "https://console.cloud.google.com/apis/library/gmail.googleapis.com",
  outlook: "https://learn.microsoft.com/en-us/graph/auth-register-app-v2",
  hubspot: "https://app.hubspot.com/private-apps",
  salesforce: "https://help.salesforce.com/s/articleView?id=sf.connected_app_create.htm",
  stripe: "https://dashboard.stripe.com/apikeys",
  mixpanel: "https://mixpanel.com/settings/project",
  amplitude: "https://app.amplitude.com/settings/projects",
  github: "https://github.com/settings/tokens",
  linear: "https://linear.app/settings/api",
  notion: "https://www.notion.so/my-integrations",
  google_calendar: "https://console.cloud.google.com/apis/library/calendar-json.googleapis.com",
  microsoft_calendar: "https://learn.microsoft.com/en-us/graph/auth-register-app-v2",
  google_drive: "https://console.cloud.google.com/apis/library/drive.googleapis.com",
};

/** Resolve the active companyId — picks the most-recently-modified
 *  company directory under ~/.wavex-os/instances/default/companies.
 *  Returns null if no company exists yet (pre-onboarding). */
async function pickActiveCompanyId(): Promise<string | null> {
  const dir = join(homedir(), ".wavex-os", "instances", "default", "companies");
  if (!existsSync(dir)) return null;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  let bestId: string | null = null;
  let bestMtime = 0;
  for (const id of entries) {
    if (id.startsWith(".")) continue;
    const sub = join(dir, id, "onboarding");
    try {
      const s = await fsStat(sub);
      if (s.mtimeMs > bestMtime) {
        bestMtime = s.mtimeMs;
        bestId = id;
      }
    } catch { /* ignore */ }
  }
  return bestId;
}

/** Map vault CredentialStatus to marketplace Status. */
function mapState(vaultState: { status: string }): Status {
  switch (vaultState.status) {
    case "vaulted_valid": return "connected";
    case "vaulted_unvalidated": return "pending";
    case "pending": return "pending";
    case "skipped": return "skipped";
    default: return "available";
  }
}

/** Best-effort path resolution. The vault doesn't track this; we infer
 *  from heuristics. Real path comes from connector-catalog.ts in the
 *  onboarding UI — for the marketplace we keep it pragmatic. */
function resolvePath(slug: string): Path {
  // OAuth-first connectors (Composio-managed).
  const oauthFirst = new Set([
    "slack", "discord", "hubspot", "salesforce", "stripe",
    "github", "linear", "notion", "google_calendar",
    "microsoft_calendar", "google_drive",
  ]);
  if (oauthFirst.has(slug)) return "oauth";
  // MCP-available (the customer can run a local MCP server).
  const mcpAvailable = new Set(["github", "google_drive", "notion"]);
  if (mcpAvailable.has(slug)) return "mcp";
  // The rest need an API key paste.
  return "key";
}

function authReq(req: FastifyRequest) {
  return { method: req.method, headers: req.headers as Record<string, string> };
}

export function registerConnectorsMarketplaceRoute(app: FastifyInstance): void {
  app.get<{ Querystring: { companyId?: string } }>(
    "/api/connectors/marketplace",
    async (req, reply) => {
      // Board auth (dev mode = bypass per WAVEX_AUTH_MODE).
      const ar = authReq(req);
      try { assertBoard(ar); } catch (e) {
        if (e instanceof AuthError) return reply.status(e.statusCode).send({ error: e.message });
        throw e;
      }

      const requested = req.query.companyId?.trim();
      const companyId = !requested || requested === "auto"
        ? await pickActiveCompanyId()
        : requested;

      const vaultStates: Map<string, { connectorId: string; status: string }> = companyId
        ? await listConnectorStates(companyId).catch(() => new Map())
        : new Map();

      const connectors: MarketplaceConnector[] = FEATURED_TOOLKITS.map((tk) => {
        const path = resolvePath(tk.slug);
        const live = vaultStates.get(tk.slug);
        const status: Status = live ? mapState(live) : "available";
        const out: MarketplaceConnector = {
          slug: tk.slug,
          display_name: tk.displayName,
          category: tk.category,
          path,
          status,
        };
        if (path === "oauth" && companyId) {
          // The UI POSTs to this URL to initiate OAuth. Same shape as
          // the existing onboarding flow.
          out.oauth_initiate_url = "/wavex-os/onboarding/connectors/oauth/initiate";
        }
        if (DOCS_URL_BY_SLUG[tk.slug]) {
          out.docs_url = DOCS_URL_BY_SLUG[tk.slug];
        }
        return out;
      });

      // "Allow all": in live Composio mode, append the full toolkit catalog
      // (hundreds) beyond the curated featured set. Disabled mode → null → the
      // featured fallback is all the user sees.
      const seen = new Set(connectors.map((c) => c.slug));
      const full = await listAllToolkits().catch(() => null);
      if (full) {
        for (const tk of full) {
          if (seen.has(tk.slug)) continue;
          seen.add(tk.slug);
          const live = vaultStates.get(tk.slug);
          const status: Status = live ? mapState(live) : "available";
          const out: MarketplaceConnector = {
            slug: tk.slug,
            display_name: tk.name,
            category: tk.category ?? "other",
            path: "oauth", // Composio-brokered
            status,
          };
          if (companyId) out.oauth_initiate_url = "/wavex-os/onboarding/connectors/oauth/initiate";
          connectors.push(out);
        }
      }

      return reply.send({
        ok: true,
        company_id: companyId,
        connectors,
        source: full ? "live_full_catalog" : "featured_fallback",
      });
    },
  );
}
