#!/usr/bin/env node
/**
 * Resend audience backfill — WAVAAAA-1209
 *
 * Fetches all wavex_os.auth_events rows where:
 *   resend_fired = false AND event_type = 'signup_confirmed' AND email IS NOT NULL
 * then adds each as a Resend contact, then marks the row resend_fired=true.
 *
 * Usage:
 *   node scripts/resend-backfill.mjs [--dry-run] [--batch 100]
 *
 * Reads env from ~/.wavex-os/state/.env if RESEND_API_KEY is not already set.
 */

import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// ─── env loader ────────────────────────────────────────────────────────────

function loadDotEnv(path) {
  try {
    const raw = readFileSync(path, "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx < 0) continue;
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim();
      if (key && !(key in process.env)) process.env[key] = val;
    }
  } catch {
    // ignore missing file
  }
}

loadDotEnv(join(homedir(), ".wavex-os", "state", ".env"));

// ─── config ────────────────────────────────────────────────────────────────

const RESEND_API_KEY   = process.env.RESEND_API_KEY;
const RESEND_AUDIENCE_ID = process.env.RESEND_AUDIENCE_ID;
const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPABASE_KEY     = process.env.SUPABASE_SERVICE_ROLE_KEY;

const args    = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const BATCH   = (() => {
  const i = args.indexOf("--batch");
  return i >= 0 && args[i + 1] ? parseInt(args[i + 1], 10) : 100;
})();

// ─── guards ────────────────────────────────────────────────────────────────

function fatal(msg) { console.error(`[backfill] FATAL: ${msg}`); process.exit(1); }

if (!SUPABASE_URL)  fatal("SUPABASE_URL not set");
if (!SUPABASE_KEY)  fatal("SUPABASE_SERVICE_ROLE_KEY not set");
if (!RESEND_API_KEY && !DRY_RUN) fatal("RESEND_API_KEY not set (use --dry-run to preview without sending)");
if (!RESEND_AUDIENCE_ID && !DRY_RUN) fatal("RESEND_AUDIENCE_ID not set (use --dry-run to preview without sending)");

// ─── Supabase helpers ──────────────────────────────────────────────────────

async function rpc(funcName, params = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${funcName}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
    },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`RPC ${funcName} failed: ${res.status} ${detail}`);
  }
  return res.json();
}

// ─── Resend helper ─────────────────────────────────────────────────────────

async function addResendContact(email, utmCampaign) {
  if (DRY_RUN) {
    console.log(`[backfill] DRY-RUN: would add contact email=${email} utm=${utmCampaign ?? "(none)"}`);
    return true;
  }

  const body = { email, unsubscribed: false };
  if (utmCampaign) body.data = { utm_campaign: utmCampaign };

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(
      `https://api.resend.com/audiences/${encodeURIComponent(RESEND_AUDIENCE_ID)}/contacts`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${RESEND_API_KEY}`,
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      }
    );
    clearTimeout(t);
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error(`[backfill] Resend error for ${email}: ${res.status} ${detail}`);
      return false;
    }
    return true;
  } catch (e) {
    clearTimeout(t);
    console.error(`[backfill] Resend fetch error for ${email}: ${e.message}`);
    return false;
  }
}

// ─── main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log(`[backfill] Starting${DRY_RUN ? " (DRY-RUN)" : ""} batch=${BATCH}`);

  let total = 0, succeeded = 0, failed = 0;

  while (true) {
    const rows = await rpc("wavex_os_get_unfired_auth_events", { p_limit: BATCH });
    if (!rows.length) break;

    console.log(`[backfill] Processing ${rows.length} row(s)...`);

    for (const row of rows) {
      const ok = await addResendContact(row.email, row.utm_campaign);
      total++;
      if (ok) {
        if (!DRY_RUN) {
          await rpc("wavex_os_mark_auth_event_fired", { p_id: row.id });
        }
        console.log(`[backfill] ✓ ${row.email} (id=${row.id})`);
        succeeded++;
      } else {
        console.warn(`[backfill] ✗ ${row.email} (id=${row.id}) — will retry on next run`);
        failed++;
      }
    }

    // If the batch wasn't full, we've exhausted the queue
    if (rows.length < BATCH) break;
  }

  console.log(`[backfill] Done — total=${total} succeeded=${succeeded} failed=${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => { console.error("[backfill] Unexpected error:", err); process.exit(1); });
