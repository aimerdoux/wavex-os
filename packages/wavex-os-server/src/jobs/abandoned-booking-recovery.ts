/** Abandoned booking recovery — one-time Telegram nudge (WAVAAAA-1197)
 *
 *  Runs ONCE at server startup. Queries wavex_os_list_abandoned_booking_candidates()
 *  for cancelled booking_intents that have a resolvable Telegram chat_id, composes
 *  a recovery message, and either logs (dry-run) or sends via the Telegram Bot API.
 *
 *  Context: users whose booking_intents were auto-cancelled before the Stripe
 *  checkout flow was added in bfeff1f5 had no payment path and never converted.
 *  This job gives them a single nudge informing them booking is now available.
 *
 *  Dry-run gating (default ON — safe to deploy without CEO approval):
 *    WAVEX_ABANDONED_BOOKING_DRY_RUN — default "true". Set to "false" (case-
 *    insensitive) to send real Telegram messages. While true the job still
 *    selects candidates and logs the recoverable count so the CEO can review
 *    before enabling live sends.
 *
 *  Recovery message:
 *    Default copy lives in DEFAULT_RECOVERY_MESSAGE below. Override via
 *    WAVEX_ABANDONED_BOOKING_MESSAGE (supports {{experience_name}} substitution).
 *    WAVEX_BOOKING_URL sets the booking link included in the message.
 *
 *  Required env vars:
 *    SUPABASE_URL                        — PostgREST endpoint
 *    SUPABASE_SERVICE_ROLE_KEY           — service-role JWT
 *    TELEGRAM_BOT_TOKEN                  — concierge bot token (for real sends)
 *  Optional env vars:
 *    WAVEX_ABANDONED_BOOKING_DRY_RUN     — "true" | "false" (default "true")
 *    WAVEX_BOOKING_URL                   — booking URL included in message
 *    WAVEX_ABANDONED_BOOKING_MESSAGE     — custom message template
 */

interface SupabaseConfig {
  url: string;
  key: string;
}

interface AbandonedCandidate {
  intent_id: string;
  telegram_user_id: string;
  chat_id: string;
  experience_name: string | null;
  experience_price_cents: number;
  currency: string;
  created_at: string;
  cancelled_at: string | null;
}

const DEFAULT_RECOVERY_MESSAGE =
  "Hey! Your booking request{{experience_part}} was cancelled due to a payment " +
  "system issue on our end — we're really sorry about that.\n\n" +
  "Great news: booking is back up and working! You can complete your booking here:\n" +
  "{{booking_url}}\n\n" +
  "Reply here if you have any questions and I'll sort it out for you! 🙌";

function supabaseConfig(): SupabaseConfig | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return { url, key };
}

function isDryRun(): boolean {
  const raw = (process.env.WAVEX_ABANDONED_BOOKING_DRY_RUN ?? "true").toLowerCase();
  return raw !== "false";
}

function renderMessage(candidate: AbandonedCandidate): string {
  const template =
    process.env.WAVEX_ABANDONED_BOOKING_MESSAGE ?? DEFAULT_RECOVERY_MESSAGE;
  const bookingUrl = process.env.WAVEX_BOOKING_URL ?? "[booking link coming soon]";
  const experiencePart = candidate.experience_name
    ? ` for ${candidate.experience_name}`
    : "";
  return template
    .replace(/{{experience_part}}/g, experiencePart)
    .replace(/{{experience_name}}/g, candidate.experience_name ?? "your experience")
    .replace(/{{booking_url}}/g, bookingUrl);
}

async function listCandidates(cfg: SupabaseConfig): Promise<AbandonedCandidate[]> {
  const res = await fetch(
    `${cfg.url}/rest/v1/rpc/wavex_os_list_abandoned_booking_candidates`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: cfg.key,
        Authorization: `Bearer ${cfg.key}`,
      },
      body: "{}",
    },
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `wavex_os_list_abandoned_booking_candidates failed: ${res.status} ${detail}`,
    );
  }
  return (await res.json().catch(() => [])) as AbandonedCandidate[];
}

async function recordNudge(
  cfg: SupabaseConfig,
  args: {
    intent_id: string;
    telegram_user_id: string;
    chat_id: string;
    message_text: string;
    message_id: string | null;
    dry_run: boolean;
  },
): Promise<void> {
  const res = await fetch(
    `${cfg.url}/rest/v1/rpc/wavex_os_record_abandoned_booking_nudge`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: cfg.key,
        Authorization: `Bearer ${cfg.key}`,
      },
      body: JSON.stringify({
        p_intent_id: args.intent_id,
        p_telegram_user_id: args.telegram_user_id,
        p_chat_id: args.chat_id,
        p_message_text: args.message_text,
        p_message_id: args.message_id,
        p_dry_run: args.dry_run,
      }),
    },
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error(
      `[abandoned-booking-recovery] failed to record nudge intent=${args.intent_id}: ${res.status} ${detail}`,
    );
  }
}

interface TelegramSendResult {
  ok: boolean;
  message_id?: string;
  error?: string;
}

async function sendTelegram(
  token: string,
  chatId: string,
  text: string,
): Promise<TelegramSendResult> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text }),
        signal: ctrl.signal,
      },
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return { ok: false, error: `${res.status} ${detail}` };
    }
    const body = (await res.json().catch(() => null)) as
      | { ok: boolean; result?: { message_id?: number } }
      | null;
    const mid = body?.result?.message_id;
    return { ok: true, message_id: mid !== undefined ? String(mid) : undefined };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(t);
  }
}

export interface AbandonedBookingRecoveryResult {
  recoverable: number;  // total candidates found (with reachable chat_id)
  sent: number;
  dryRun: number;
  skipped: number;
  errors: number;
}

export async function runAbandonedBookingRecoveryJob(): Promise<AbandonedBookingRecoveryResult> {
  const cfg = supabaseConfig();
  if (!cfg) {
    console.warn(
      "[abandoned-booking-recovery] Supabase not configured — skipping run",
    );
    return { recoverable: 0, sent: 0, dryRun: 0, skipped: 0, errors: 0 };
  }

  const dryRun = isDryRun();
  const token = process.env.TELEGRAM_BOT_TOKEN;

  let candidates: AbandonedCandidate[];
  try {
    candidates = await listCandidates(cfg);
  } catch (err) {
    console.error("[abandoned-booking-recovery] candidate query failed:", err);
    return { recoverable: 0, sent: 0, dryRun: 0, skipped: 0, errors: 1 };
  }

  console.info(
    `[abandoned-booking-recovery] recoverable=${candidates.length} dryRun=${dryRun}`,
  );

  let sent = 0;
  let dryRunRecorded = 0;
  let skipped = 0;
  let errors = 0;

  for (const c of candidates) {
    const text = renderMessage(c);

    let send: TelegramSendResult = { ok: true };
    if (dryRun) {
      console.log(
        `[abandoned-booking-recovery] [dry-run] intent=${c.intent_id} chat=${c.chat_id} msg=${JSON.stringify(text)}`,
      );
      dryRunRecorded++;
    } else if (!token) {
      console.warn(
        "[abandoned-booking-recovery] TELEGRAM_BOT_TOKEN not set — cannot send; skipping",
      );
      skipped++;
      continue;
    } else {
      send = await sendTelegram(token, c.chat_id, text);
      if (!send.ok) {
        console.error(
          `[abandoned-booking-recovery] send failed intent=${c.intent_id}: ${send.error}`,
        );
        errors++;
        continue;
      }
      sent++;
    }

    await recordNudge(cfg, {
      intent_id: c.intent_id,
      telegram_user_id: c.telegram_user_id,
      chat_id: c.chat_id,
      message_text: text,
      message_id: send.message_id ?? null,
      dry_run: dryRun,
    });
  }

  const result: AbandonedBookingRecoveryResult = {
    recoverable: candidates.length,
    sent,
    dryRun: dryRunRecorded,
    skipped,
    errors,
  };
  console.info(
    `[abandoned-booking-recovery] run complete: ${JSON.stringify(result)}`,
  );
  return result;
}
