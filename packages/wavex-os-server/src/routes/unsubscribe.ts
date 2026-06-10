/** CAN-SPAM unsubscribe endpoint (WAV-59).
 *
 *  GET  /api/unsubscribe?token={base64url(email)}
 *  GET  /api/unsubscribe?email={email}
 *    One-click path for email links. Processes the unsubscribe and redirects
 *    to a confirmation page (WAVEX_APP_URL/unsubscribed) or returns 200 JSON
 *    if no app URL is configured.
 *
 *  POST /api/unsubscribe
 *    Body: { token: string } or { email: string }
 *    Returns: { ok: true, email: string } or { ok: false, error: string }
 *
 *  Token format: base64url-encoded email address.
 *  Both GET and POST are required — GET for email click-throughs, POST for
 *  programmatic use (e.g. list-unsubscribe header support). */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

function supabaseConfig(): { url: string; key: string } | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return { url, key };
}

function decodeToken(token: string): string | null {
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    return decoded.includes("@") ? decoded : null;
  } catch {
    return null;
  }
}

function resolveEmail(query: Record<string, unknown>, body?: Record<string, unknown>): string | null {
  const raw = (query.email ?? body?.email ?? "") as string;
  if (raw && raw.includes("@")) return raw.trim().toLowerCase();

  const token = (query.token ?? body?.token ?? "") as string;
  if (token) return decodeToken(token);

  return null;
}

async function markUnsubscribed(cfg: { url: string; key: string }, email: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${cfg.url}/rest/v1/rpc/wavex_os_unsubscribe_contact`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: cfg.key,
      Authorization: `Bearer ${cfg.key}`,
    },
    body: JSON.stringify({ p_email: email }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error(`[unsubscribe] RPC failed ${res.status}: ${detail}`);
    return { ok: false, error: "db_error" };
  }

  const result = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
  if (!result.ok) {
    return { ok: false, error: result.error ?? "unknown" };
  }
  return { ok: true };
}

export function registerUnsubscribeRoute(app: FastifyInstance): void {
  app.get(
    "/api/unsubscribe",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const query = req.query as Record<string, unknown>;
      const email = resolveEmail(query);

      if (!email) {
        return reply.code(400).send({ ok: false, error: "missing_email_or_token" });
      }

      const cfg = supabaseConfig();
      if (!cfg) {
        console.error("[unsubscribe] SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set");
        return reply.code(503).send({ ok: false, error: "service_unavailable" });
      }

      const result = await markUnsubscribed(cfg, email);
      if (!result.ok) {
        return reply.code(500).send({ ok: false, error: result.error });
      }

      const appUrl = (process.env.WAVEX_APP_URL ?? "").replace(/\/$/, "");
      if (appUrl) {
        return reply.redirect(`${appUrl}/unsubscribed?email=${encodeURIComponent(email)}`);
      }

      reply.type("text/html").code(200).send(`
<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Unsubscribed — WaveX</title>
<style>body{font-family:system-ui,sans-serif;max-width:480px;margin:80px auto;text-align:center;color:#222}</style>
</head>
<body>
<h1>You've been unsubscribed</h1>
<p>We've removed <strong>${email.replace(/</g, "&lt;")}</strong> from our mailing list.</p>
<p style="color:#888;font-size:.9em">You won't receive any further emails from WaveX.<br>
If this was a mistake, reply to any previous WaveX email and we'll re-add you.</p>
</body>
</html>`);
    },
  );

  app.post(
    "/api/unsubscribe",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const query = req.query as Record<string, unknown>;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const email = resolveEmail(query, body);

      if (!email) {
        return reply.code(400).send({ ok: false, error: "missing_email_or_token" });
      }

      const cfg = supabaseConfig();
      if (!cfg) {
        console.error("[unsubscribe] SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY not set");
        return reply.code(503).send({ ok: false, error: "service_unavailable" });
      }

      const result = await markUnsubscribed(cfg, email);
      if (!result.ok) {
        return reply.code(500).send({ ok: false, error: result.error });
      }

      return { ok: true, email };
    },
  );
}
