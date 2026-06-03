/** Booking-intent stale cleanup (WAVAAAA-1195)
 *
 *  Runs every 5 minutes. Calls wavex_os_cancel_stale_booking_intents() to
 *  cancel booking_intents that have been in status='pending' for longer than
 *  30 minutes.
 *
 *  Critically: intents in status='pending_payment' (user is in Stripe redirect)
 *  are NOT cancelled. Only 'pending' intents (where no checkout was ever
 *  initiated) time out. This prevents cancelling live payment sessions.
 *
 *  Required env vars:
 *    SUPABASE_URL             — PostgREST endpoint
 *    SUPABASE_SERVICE_ROLE_KEY — service-role JWT
 *  Optional env vars:
 *    WAVEX_BOOKING_INTENT_TIMEOUT_MINUTES — integer (default 30)
 */

interface SupabaseConfig {
  url: string;
  key: string;
}

function supabaseConfig(): SupabaseConfig | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return { url, key };
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

async function cancelStaleIntents(cfg: SupabaseConfig): Promise<number> {
  const timeoutMinutes = envInt("WAVEX_BOOKING_INTENT_TIMEOUT_MINUTES", 30);
  const res = await fetch(
    `${cfg.url}/rest/v1/rpc/wavex_os_cancel_stale_booking_intents`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: cfg.key,
        Authorization: `Bearer ${cfg.key}`,
      },
      body: JSON.stringify({ p_older_than_minutes: timeoutMinutes }),
    },
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`wavex_os_cancel_stale_booking_intents failed: ${res.status} ${detail}`);
  }
  const data = (await res.json().catch(() => null)) as { cancelled?: number } | null;
  return data?.cancelled ?? 0;
}

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

export function startBookingIntentCleanupScheduler(): void {
  if (cleanupTimer) return;

  const INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes

  const run = async () => {
    const cfg = supabaseConfig();
    if (!cfg) return;
    try {
      const cancelled = await cancelStaleIntents(cfg);
      if (cancelled > 0) {
        console.info(`[booking-intent-cleanup] cancelled ${cancelled} stale pending intent(s)`);
      }
    } catch (e) {
      console.error(
        `[booking-intent-cleanup] run threw: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  };

  // Run once immediately, then on the interval.
  void run();
  cleanupTimer = setInterval(() => void run(), INTERVAL_MS);
}
