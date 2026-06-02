/** Booking fulfillment resolver — timer fallback (WAVAAAAA-218)
 *
 *  Runs hourly. For each booking where
 *    fulfillment_status = 'pending'
 *    AND paid_at IS NOT NULL
 *    AND now() > booking_time + experience_duration + interval '24 hours'
 *  it transitions the row to:
 *    fulfillment_status = 'fulfilled'
 *    fulfilled_at       = now()
 *    fulfillment_source = 'timer_fallback'
 *
 *  Idempotent: the WHERE clause filters out anything non-pending, so a
 *  replay after partner_api or user_confirm has already closed the row
 *  is a no-op. The priority order (partner_api > user_confirm >
 *  timer_fallback > operator_manual) is enforced by ordering of
 *  resolvers: this fallback only fires after 24h, by which point higher-
 *  priority resolvers have had ample time.
 *
 *  Telemetry: emits Mixpanel `booking_fulfillment_resolved` with
 *    { booking_id, source: 'timer_fallback', booking_time,
 *      experience_duration_seconds, resolved_at }.
 *  CDO / TELEMETRY owns the event schema — sibling registration issue.
 *
 *  Required env vars:
 *    SUPABASE_URL                       — PostgREST endpoint
 *    SUPABASE_SERVICE_ROLE_KEY          — service-role JWT
 *  Optional env vars:
 *    MIXPANEL_PROJECT_TOKEN             — if absent, telemetry is skipped
 *    WAVEX_FULFILLMENT_RESOLVER_DRY_RUN — "true" | "false" (default "false")
 *    WAVEX_FULFILLMENT_RESOLVER_BATCH   — integer (default 500)
 */

interface SupabaseConfig {
  url: string;
  key: string;
}

interface PendingBooking {
  id: string;
  booking_time: string;            // ISO timestamp
  experience_duration_seconds: number;
  paid_at: string;
}

function supabaseConfig(): SupabaseConfig | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return { url, key };
}

function isDryRun(): boolean {
  const raw = (process.env.WAVEX_FULFILLMENT_RESOLVER_DRY_RUN ?? "false").toLowerCase();
  return raw === "true";
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

async function selectExpiredPending(
  cfg: SupabaseConfig,
  limit: number,
): Promise<PendingBooking[]> {
  // RPC lives in wavex_os schema (added in this issue's sibling migration
  // wavex_os_list_expired_pending_bookings — defensively inlined here as
  // a PostgREST query against public.bookings until that RPC lands).
  const params = new URLSearchParams({
    select: "id,booking_time,experience_duration_seconds,paid_at",
    fulfillment_status: "eq.pending",
    paid_at: "not.is.null",
    limit: String(limit),
  });
  const res = await fetch(`${cfg.url}/rest/v1/bookings?${params.toString()}`, {
    method: "GET",
    headers: {
      apikey: cfg.key,
      Authorization: `Bearer ${cfg.key}`,
    },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`select pending bookings failed: ${res.status} ${detail}`);
  }
  const rows = (await res.json().catch(() => [])) as PendingBooking[];

  // Filter the "now() > booking_time + duration + 24h" clause client-side
  // because PostgREST cannot express the additive comparison against a
  // computed column directly. The partial index keeps the row count
  // bounded; the filter is O(returned rows).
  const cutoff = Date.now();
  return rows.filter((r) => {
    const bt = new Date(r.booking_time).getTime();
    if (!Number.isFinite(bt)) return false;
    const expiry = bt + (r.experience_duration_seconds * 1000) + (24 * 3600 * 1000);
    return cutoff > expiry;
  });
}

async function markFulfilledTimer(
  cfg: SupabaseConfig,
  bookingId: string,
): Promise<boolean> {
  // Conditional update: WHERE fulfillment_status = 'pending' keeps this
  // idempotent even under concurrent resolvers (partner_api / user_confirm)
  // closing the same row.
  const params = new URLSearchParams({
    id: `eq.${bookingId}`,
    fulfillment_status: "eq.pending",
  });
  const res = await fetch(`${cfg.url}/rest/v1/bookings?${params.toString()}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      apikey: cfg.key,
      Authorization: `Bearer ${cfg.key}`,
      Prefer: "return=representation",
    },
    body: JSON.stringify({
      fulfillment_status: "fulfilled",
      fulfilled_at: new Date().toISOString(),
      fulfillment_source: "timer_fallback",
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error(
      `[booking-fulfillment-resolver] update failed booking=${bookingId}: ${res.status} ${detail}`,
    );
    return false;
  }
  const rows = (await res.json().catch(() => [])) as unknown[];
  return Array.isArray(rows) && rows.length > 0;
}

async function emitMixpanel(
  bookingId: string,
  bookingTime: string,
  durationSeconds: number,
): Promise<void> {
  const token = process.env.MIXPANEL_PROJECT_TOKEN;
  if (!token) return;
  const event = {
    event: "booking_fulfillment_resolved",
    properties: {
      token,
      distinct_id: bookingId,
      booking_id: bookingId,
      source: "timer_fallback",
      booking_time: bookingTime,
      experience_duration_seconds: durationSeconds,
      resolved_at: new Date().toISOString(),
    },
  };
  const payload = Buffer.from(JSON.stringify(event)).toString("base64");
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 5_000);
  try {
    const res = await fetch(
      `https://api.mixpanel.com/track?data=${encodeURIComponent(payload)}`,
      { method: "GET", signal: ctrl.signal },
    );
    if (!res.ok) {
      console.error(
        `[booking-fulfillment-resolver] mixpanel emit failed booking=${bookingId}: ${res.status}`,
      );
    }
  } catch (e) {
    console.error(
      `[booking-fulfillment-resolver] mixpanel emit threw booking=${bookingId}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  } finally {
    clearTimeout(t);
  }
}

export interface FulfillmentResolverRunResult {
  checked: number;
  resolved: number;
  dryRun: number;
  errors: number;
}

export async function runBookingFulfillmentResolverJob(): Promise<FulfillmentResolverRunResult> {
  const cfg = supabaseConfig();
  if (!cfg) {
    console.warn(
      "[booking-fulfillment-resolver] Supabase not configured — skipping run",
    );
    return { checked: 0, resolved: 0, dryRun: 0, errors: 0 };
  }
  const batch = envInt("WAVEX_FULFILLMENT_RESOLVER_BATCH", 500);
  const dry = isDryRun();

  let candidates: PendingBooking[];
  try {
    candidates = await selectExpiredPending(cfg, batch);
  } catch (e) {
    console.error(
      `[booking-fulfillment-resolver] candidate select threw: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return { checked: 0, resolved: 0, dryRun: 0, errors: 1 };
  }

  let resolved = 0;
  let errors = 0;
  for (const row of candidates) {
    if (dry) continue;
    try {
      const updated = await markFulfilledTimer(cfg, row.id);
      if (updated) {
        resolved += 1;
        await emitMixpanel(row.id, row.booking_time, row.experience_duration_seconds);
      }
    } catch (e) {
      errors += 1;
      console.error(
        `[booking-fulfillment-resolver] resolve threw booking=${row.id}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  const result: FulfillmentResolverRunResult = {
    checked: candidates.length,
    resolved,
    dryRun: dry ? candidates.length : 0,
    errors,
  };
  console.info(
    `[booking-fulfillment-resolver] run complete: ${JSON.stringify(result)}`,
  );
  return result;
}
