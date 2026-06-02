/** Professional re-engagement Telegram nudge (WAVAAAAA-63)
 *
 *  Runs hourly. Calls Supabase RPC wavex_os_list_professionals_with_stale_booking
 *  to find professionals (users with >=1 booking_confirmed event) whose last
 *  booking_confirmed was >7 days ago and who haven't been nudged inside the
 *  cadence cooldown. For each candidate it composes a concierge-voice
 *  Telegram message and sends via the bot, then logs the nudge so the
 *  re-activation metric (booking_confirmed within 48h) can be computed.
 *
 *  Dry-run gating:
 *    WAVEX_REENGAGEMENT_DRY_RUN — default "true". Must be set to "false"
 *    (case-insensitive) to actually send Telegram messages. While true,
 *    the job still selects candidates and writes nudge rows with
 *    dry_run=true so the cadence and cohort sizing can be validated
 *    without pinging real users.
 *
 *  Message copy:
 *    Default copy lives in DEFAULT_NUDGE_TEMPLATE below. CRO / EXPANSION
 *    can override it via WAVEX_REENGAGEMENT_MESSAGE without a deploy.
 *    The template supports {{days}} substitution (days since last booking).
 *
 *  Required env vars:
 *    SUPABASE_URL                       — PostgREST endpoint
 *    SUPABASE_SERVICE_ROLE_KEY          — service-role JWT
 *    TELEGRAM_BOT_TOKEN                 — concierge bot token (for real sends)
 *  Optional env vars:
 *    WAVEX_REENGAGEMENT_DRY_RUN         — "true" | "false" (default "true")
 *    WAVEX_REENGAGEMENT_GAP_DAYS        — integer (default 7)
 *    WAVEX_REENGAGEMENT_COOLDOWN_HOURS  — integer (default 168 = 7d)
 *    WAVEX_REENGAGEMENT_BATCH_LIMIT     — integer (default 100)
 *    WAVEX_REENGAGEMENT_MESSAGE         — string with optional {{days}}
 */

interface SupabaseConfig {
  url: string;
  key: string;
}

interface StaleProfessional {
  user_id: string;
  telegram_user_id: string;
  chat_id: string;
  last_booking_at: string;       // ISO timestamp
  last_nudged_at: string | null; // ISO timestamp
}

const DEFAULT_NUDGE_TEMPLATE =
  "Ready to book your next dinner? It's been {{days}} days since your last one — " +
  "want me to line something up?";

function supabaseConfig(): SupabaseConfig | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return { url, key };
}

function isDryRun(): boolean {
  const raw = (process.env.WAVEX_REENGAGEMENT_DRY_RUN ?? "true").toLowerCase();
  return raw !== "false";
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function renderMessage(lastBookingAt: string): string {
  const template = process.env.WAVEX_REENGAGEMENT_MESSAGE ?? DEFAULT_NUDGE_TEMPLATE;
  const ms = Date.now() - new Date(lastBookingAt).getTime();
  const days = Math.max(1, Math.floor(ms / 86_400_000));
  return template.replace(/{{days}}/g, String(days));
}

async function listCandidates(
  cfg: SupabaseConfig,
  gapDays: number,
  cooldownHours: number,
  limit: number,
): Promise<StaleProfessional[]> {
  const res = await fetch(
    `${cfg.url}/rest/v1/rpc/wavex_os_list_professionals_with_stale_booking`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: cfg.key,
        Authorization: `Bearer ${cfg.key}`,
      },
      body: JSON.stringify({ p_gap_days: gapDays, p_cooldown_hours: cooldownHours }),
    },
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(
      `wavex_os_list_professionals_with_stale_booking failed: ${res.status} ${detail}`,
    );
  }
  const rows = (await res.json().catch(() => [])) as StaleProfessional[];
  return rows.slice(0, limit);
}

async function recordNudge(
  cfg: SupabaseConfig,
  args: {
    user_id: string;
    telegram_user_id: string;
    chat_id: string;
    last_booking_at: string;
    message_text: string;
    message_id: string | null;
    dry_run: boolean;
  },
): Promise<void> {
  const res = await fetch(
    `${cfg.url}/rest/v1/rpc/wavex_os_record_professional_reengagement_nudge`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: cfg.key,
        Authorization: `Bearer ${cfg.key}`,
      },
      body: JSON.stringify({
        p_user_id: args.user_id,
        p_telegram_user_id: args.telegram_user_id,
        p_chat_id: args.chat_id,
        p_last_booking_at: args.last_booking_at,
        p_message_text: args.message_text,
        p_message_id: args.message_id,
        p_dry_run: args.dry_run,
      }),
    },
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error(
      `[professional-reengagement] failed to record nudge for user=${args.user_id}: ${res.status} ${detail}`,
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

export interface ReengagementRunResult {
  checked: number;
  sent: number;
  dryRun: number;
  skipped: number;
  errors: number;
}

export async function runProfessionalReengagementJob(): Promise<ReengagementRunResult> {
  const cfg = supabaseConfig();
  if (!cfg) {
    console.warn(
      "[professional-reengagement] Supabase not configured — skipping run",
    );
    return { checked: 0, sent: 0, dryRun: 0, skipped: 0, errors: 0 };
  }

  const dryRun = isDryRun();
  const gapDays = envInt("WAVEX_REENGAGEMENT_GAP_DAYS", 7);
  const cooldownHours = envInt("WAVEX_REENGAGEMENT_COOLDOWN_HOURS", 168);
  const limit = envInt("WAVEX_REENGAGEMENT_BATCH_LIMIT", 100);
  const token = process.env.TELEGRAM_BOT_TOKEN;

  let candidates: StaleProfessional[];
  try {
    candidates = await listCandidates(cfg, gapDays, cooldownHours, limit);
  } catch (err) {
    console.error("[professional-reengagement] candidate query failed:", err);
    return { checked: 0, sent: 0, dryRun: 0, skipped: 0, errors: 1 };
  }

  let sent = 0;
  let dryRunRecorded = 0;
  let skipped = 0;
  let errors = 0;

  for (const c of candidates) {
    const text = renderMessage(c.last_booking_at);

    let send: TelegramSendResult = { ok: true };
    if (dryRun) {
      console.log(
        `[professional-reengagement] [dry-run] user=${c.user_id} chat=${c.chat_id} text=${JSON.stringify(text)}`,
      );
      dryRunRecorded++;
    } else if (!token) {
      console.warn(
        "[professional-reengagement] TELEGRAM_BOT_TOKEN not set — cannot send; recording as skipped",
      );
      skipped++;
      continue;
    } else {
      send = await sendTelegram(token, c.chat_id, text);
      if (!send.ok) {
        console.error(
          `[professional-reengagement] send failed user=${c.user_id}: ${send.error}`,
        );
        errors++;
        continue;
      }
      sent++;
    }

    await recordNudge(cfg, {
      user_id: c.user_id,
      telegram_user_id: c.telegram_user_id,
      chat_id: c.chat_id,
      last_booking_at: c.last_booking_at,
      message_text: text,
      message_id: send.message_id ?? null,
      dry_run: dryRun,
    });
  }

  console.log(
    `[professional-reengagement] checked=${candidates.length} sent=${sent} dryRun=${dryRunRecorded} skipped=${skipped} errors=${errors}`,
  );
  return {
    checked: candidates.length,
    sent,
    dryRun: dryRunRecorded,
    skipped,
    errors,
  };
}

// ─── scheduler ─────────────────────────────────────────────────────────────

const HOUR_MS = 60 * 60 * 1000;
let schedulerHandle: ReturnType<typeof setInterval> | null = null;

export function startProfessionalReengagementScheduler(): void {
  if (schedulerHandle) return;

  void runProfessionalReengagementJob().catch((err) =>
    console.error("[professional-reengagement] initial run failed:", err),
  );

  schedulerHandle = setInterval(() => {
    void runProfessionalReengagementJob().catch((err) =>
      console.error("[professional-reengagement] scheduled run failed:", err),
    );
  }, HOUR_MS);

  schedulerHandle.unref?.();

  console.log(
    `[professional-reengagement] hourly scheduler started (dryRun=${isDryRun()})`,
  );
}

export function stopProfessionalReengagementScheduler(): void {
  if (schedulerHandle) {
    clearInterval(schedulerHandle);
    schedulerHandle = null;
  }
}
