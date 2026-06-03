#!/usr/bin/env node
/**
 * Backfill Resend audience contacts from historic auth_events.
 *
 * Finds all wavex_os.auth_events rows where:
 *   resend_fired = false AND event_type = 'signup_confirmed' AND email IS NOT NULL
 * and adds each as a contact in the configured Resend audience, then marks
 * resend_fired = true in the DB.
 *
 * Requires env vars (loaded from ~/.wavex-os/state/.env if not already set):
 *   RESEND_API_KEY         — Resend API key
 *   RESEND_AUDIENCE_ID     — Resend audience UUID
 *   SUPABASE_URL           — project URL
 *   SUPABASE_SERVICE_ROLE_KEY — service-role key (full DB access)
 *
 * Dry-run (safe default — no writes):
 *   node tools/backfill-resend-audience.mjs
 *
 * Live run:
 *   DRY_RUN=false node tools/backfill-resend-audience.mjs
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

// ─── env loading ─────────────────────────────────────────────────────────────

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let val = trimmed.slice(idx + 1).trim();
    val = val.replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = val;
  }
}

loadEnvFile(path.join(os.homedir(), '.wavex-os', 'state', '.env'));

// ─── config ───────────────────────────────────────────────────────────────────

const DRY_RUN = process.env.DRY_RUN !== 'false';
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_AUDIENCE_ID = process.env.RESEND_AUDIENCE_ID;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BATCH_SIZE = 100;
const DELAY_MS = 300; // polite delay between Resend API calls

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
  process.exit(1);
}
if (!DRY_RUN && (!RESEND_API_KEY || !RESEND_AUDIENCE_ID)) {
  console.error('RESEND_API_KEY and RESEND_AUDIENCE_ID are required for live runs.');
  console.error('Run with DRY_RUN=false after setting these in ~/.wavex-os/state/.env');
  process.exit(1);
}

// ─── Supabase helpers ─────────────────────────────────────────────────────────
// wavex_os schema is not exposed via PostgREST — use SECURITY DEFINER RPCs.

async function supabaseRpc(fn, params) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`RPC ${fn} failed: ${res.status} ${detail}`);
  }
  return res.json();
}

async function fetchUnfiredRows() {
  return supabaseRpc('wavex_os_get_unfired_auth_events', { p_limit: BATCH_SIZE });
}

async function markFired(id) {
  await supabaseRpc('wavex_os_mark_auth_event_fired', { p_id: id });
}

// ─── Resend helper ────────────────────────────────────────────────────────────

async function addContact({ email, utmCampaign }) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const body = { email, unsubscribed: false };
    if (utmCampaign) body.data = { utm_campaign: utmCampaign };

    const res = await fetch(
      `https://api.resend.com/audiences/${encodeURIComponent(RESEND_AUDIENCE_ID)}/contacts`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${RESEND_API_KEY}`,
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      },
    );
    clearTimeout(t);
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      // 409 = contact already exists — treat as success for idempotency
      if (res.status === 409) return { ok: true, alreadyExists: true };
      throw new Error(`Resend ${res.status}: ${detail}`);
    }
    return { ok: true, alreadyExists: false };
  } catch (e) {
    clearTimeout(t);
    throw e;
  }
}

// ─── main ─────────────────────────────────────────────────────────────────────

console.log('\n=== Resend Audience Backfill ===');
console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no writes)' : '*** LIVE — writing to Resend + DB ***'}`);
if (!DRY_RUN) console.log(`Audience: ${RESEND_AUDIENCE_ID}`);
console.log('');

let totalProcessed = 0;
let totalFired = 0;
let totalSkipped = 0;
let totalFailed = 0;
let pageOffset = 0;

while (true) {
  const rows = await fetchUnfiredRows(pageOffset);
  if (rows.length === 0) break;

  console.log(`Batch: ${rows.length} rows (total so far: ${totalProcessed})`);

  for (const row of rows) {
    totalProcessed++;
    const label = `${row.email} (id=${row.id.slice(0, 8)}… campaign=${row.utm_campaign ?? 'none'})`;

    if (DRY_RUN) {
      console.log(`  [DRY RUN] Would add: ${label}`);
      totalFired++;
      continue;
    }

    try {
      const result = await addContact({ email: row.email, utmCampaign: row.utm_campaign });
      if (result.alreadyExists) {
        console.log(`  ↩ already exists: ${label}`);
        totalSkipped++;
      } else {
        console.log(`  ✅ added: ${label}`);
        totalFired++;
      }
      await markFired(row.id);
    } catch (e) {
      console.error(`  ❌ failed: ${label} — ${e.message}`);
      totalFailed++;
    }

    if (rows.indexOf(row) < rows.length - 1) {
      await new Promise(r => setTimeout(r, DELAY_MS));
    }
  }

  // If we got a full batch, there may be more rows — but since we mark fired=true,
  // re-querying from offset 0 is correct (processed rows no longer match).
  if (rows.length < BATCH_SIZE) break;
}

console.log('\n=== Summary ===');
console.log(`Processed : ${totalProcessed}`);
if (DRY_RUN) {
  console.log(`Would fire: ${totalFired}`);
  console.log('\nRe-run with DRY_RUN=false to execute.');
} else {
  console.log(`Fired     : ${totalFired}`);
  console.log(`Skipped   : ${totalSkipped} (already in audience)`);
  console.log(`Failed    : ${totalFailed}`);
  if (totalFailed > 0) process.exit(1);
}
