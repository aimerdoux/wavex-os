/**
 * Admin / kill-switch endpoints.
 *
 * Per V2_CAPTURE_C §4 — anti-budget-burn kill switch tied to a Keychain
 * admin token + Telegram command `/freeze-inference`.
 *
 * /admin/freeze   — flip the Redis kill flag; all routes return 503
 * /admin/unfreeze — clear the flag
 * /admin/status   — return current freeze state + today's burn $
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { dropKey, setSize } from "../lib/rate-limit.js";
import {
  hasPoolBOpenAiKey,
  isPoolBEnabled,
  poolBAuditLogPath,
  poolBOpenAiModel,
  poolBProviderMode,
} from "../lib/pool-b-control.js";

interface FreezeBody {
  reason?: string;
}

function requireAdminToken(req: FastifyRequest, reply: FastifyReply): boolean {
  const expected = process.env.WAVEX_INFERENCE_ADMIN_TOKEN;
  const got = req.headers["x-admin-token"];
  if (!expected) {
    reply.code(503).send({ error: "admin_token_not_configured" });
    return false;
  }
  if (typeof got !== "string" || got !== expected) {
    reply.code(403).send({ error: "forbidden" });
    return false;
  }
  return true;
}

async function callServiceRpc<T>(name: string, body: Record<string, unknown>): Promise<{ ok: true; data: T } | { ok: false; status: number; error: string }> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    return { ok: false, status: 503, error: "supabase_not_configured" };
  }
  const resp = await fetch(`${url}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    return { ok: false, status: resp.status, error: `${name}_failed` };
  }
  return { ok: true, data: (await resp.json()) as T };
}

export async function registerAdmin(app: FastifyInstance): Promise<void> {
  app.post<{ Body: FreezeBody }>("/admin/freeze", async (req, reply) => {
    if (!requireAdminToken(req, reply)) return;
    // TODO Phase G.3.b — set Redis key inference:frozen=true
    return reply.send({ frozen: true, reason: req.body?.reason ?? "manual", note: "Phase G.3 stub — Redis backing lands in G.3.b" });
  });

  app.post("/admin/unfreeze", async (req, reply) => {
    if (!requireAdminToken(req, reply)) return;
    return reply.send({ frozen: false });
  });

  app.get("/admin/status", async (req, reply) => {
    if (!requireAdminToken(req, reply)) return;
    return reply.send({
      frozen: false,
      pool_a_burn_today_cents: 0,
      pool_c_burn_today_cents: 0,
      daily_cap_cents: 1000,
      pool_b_streaming_enabled: isPoolBEnabled(),
      pool_b_audit_log_path: poolBAuditLogPath(),
      pool_b_provider_mode: poolBProviderMode(),
      pool_b_openai_model: poolBOpenAiModel(),
      pool_b_openai_key_present: hasPoolBOpenAiKey(),
      note: "Phase G.3 stub — real ledger reads land in G.3.b",
    });
  });

  app.get<{ Querystring: { limit?: string } }>("/admin/pool-b/requests", async (req, reply) => {
    if (!requireAdminToken(req, reply)) return;
    const parsed = Number(req.query.limit ?? "100");
    const limit = Number.isFinite(parsed) ? Math.min(Math.max(Math.floor(parsed), 1), 500) : 100;
    const result = await callServiceRpc<unknown[]>("wavex_os_recent_inference_audit", {
      p_limit: limit,
    });
    if (!result.ok) {
      return reply.code(result.status).send({
        ok: false,
        error: result.error,
      });
    }
    return reply.send({
      ok: true,
      limit,
      rows: result.data,
    });
  });

  // Reset the per-email distinct-install set. Used by the operator to clear
  // their own counter after the dev cycle blew through it (or to help a
  // legitimate customer who got mis-flagged). Takes the email as a query
  // param to keep the response simple.
  app.post<{ Querystring: { email?: string } }>("/admin/reset-email-installs", async (req, reply) => {
    if (!requireAdminToken(req, reply)) return;
    const email = (req.query.email ?? "").trim().toLowerCase();
    if (!email) return reply.code(400).send({ error: "missing_email" });
    const key = `pool-a:email-installs:${email}`;
    const sizeBefore = await setSize(key);
    const dropped = await dropKey(key);
    return reply.send({ email, dropped, distinct_installs_cleared: sizeBefore });
  });
}
