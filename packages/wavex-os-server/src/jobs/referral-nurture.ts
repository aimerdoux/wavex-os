/** Referral Day-14 nurture — periodic check, one-shot Telegram DM per member (WAVAAAAAAAA-154)
 *
 *  Runs hourly via startReferralNurtureScheduler(). Queries
 *  wavex_os_list_referral_nurture_candidates() for members whose launch blast
 *  was sent ≥14 days ago, have 0 converted referrals, and haven't received the nurture.
 *
 *  Safe to run repeatedly — idempotent via wavex_os.referral_sends unique constraint.
 *
 *  Dry-run gating (default ON):
 *    WAVEX_REFERRAL_NURTURE_DRY_RUN — default "true". Set to "false" to send live.
 *
 *  Required env vars:
 *    SUPABASE_URL               — PostgREST endpoint
 *    SUPABASE_SERVICE_ROLE_KEY  — service-role JWT
 *    TELEGRAM_BOT_TOKEN         — concierge bot token
 *  Optional env vars:
 *    WAVEX_REFERRAL_NURTURE_DRY_RUN — "true" | "false" (default "true")
 */

interface SupabaseConfig {
  url: string;
  key: string;
}

interface NurtureCandidate {
  user_id: string;
  first_name: string;
  chat_id: string;
  code: string;
  share_url: string;
}

interface TelegramSendResult {
  ok: boolean;
  message_id?: string;
  error?: string;
}

const NURTURE_MESSAGE_TEMPLATE =
  "Hey {FIRST_NAME},\n\n" +
  "Just a quick note — your WaveX referral link is still active.\n\n" +
  "{REFERRAL_URL}\n\n" +
  "If you have already shared it, no action needed — any signups are tracked automatically.\n\n" +
  "If you have not had a chance yet: when a friend subscribes through your link, you get a full month free.\n\n" +
  "— The WaveX Team";

function supabaseConfig(): SupabaseConfig | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return { url, key };
}

function isDryRun(): boolean {
  return (process.env.WAVEX_REFERRAL_NURTURE_DRY_RUN ?? "true").toLowerCase() !== "false";
}

function renderMessage(candidate: NurtureCandidate): string {
  return NURTURE_MESSAGE_TEMPLATE
    .replace("{FIRST_NAME}", candidate.first_name)
    .replace("{REFERRAL_URL}", candidate.share_url);
}

async function listCandidates(cfg: SupabaseConfig): Promise<NurtureCandidate[]> {
  const res = await fetch(
    `${cfg.url}/rest/v1/rpc/wavex_os_list_referral_nurture_candidates`,
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
    throw new Error(`wavex_os_list_referral_nurture_candidates failed: ${res.status} ${detail}`);
  }
  return (await res.json().catch(() => [])) as NurtureCandidate[];
}

async function recordSend(
  cfg: SupabaseConfig,
  args: {
    user_id: string;
    chat_id: string;
    message_text: string;
    message_id: string | null;
    dry_run: boolean;
  },
): Promise<void> {
  const res = await fetch(`${cfg.url}/rest/v1/rpc/wavex_os_record_referral_send`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: cfg.key,
      Authorization: `Bearer ${cfg.key}`,
    },
    body: JSON.stringify({
      p_user_id: args.user_id,
      p_send_type: "nurture_14d",
      p_chat_id: args.chat_id,
      p_message_text: args.message_text,
      p_message_id: args.message_id,
      p_dry_run: args.dry_run,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error(`[referral-nurture] record_send failed user=${args.user_id}: ${res.status} ${detail}`);
  }
}

async function sendTelegram(token: string, chatId: string, text: string): Promise<TelegramSendResult> {
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
    const body = (await res.json().catch(() => null)) as { ok: boolean; result?: { message_id?: number } } | null;
    return { ok: true, message_id: body?.result?.message_id !== undefined ? String(body.result.message_id) : undefined };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(t);
  }
}

async function runNurtureCheck(): Promise<void> {
  const cfg = supabaseConfig();
  if (!cfg) {
    console.warn("[referral-nurture] Supabase not configured — skipping");
    return;
  }

  const dryRun = isDryRun();
  const token = process.env.TELEGRAM_BOT_TOKEN;

  let candidates: NurtureCandidate[];
  try {
    candidates = await listCandidates(cfg);
  } catch (err) {
    console.error("[referral-nurture] candidate query failed:", err);
    return;
  }

  if (candidates.length === 0) return;

  console.info(`[referral-nurture] candidates=${candidates.length} dryRun=${dryRun}`);

  let sent = 0;
  let errors = 0;

  for (const c of candidates) {
    const text = renderMessage(c);

    if (dryRun) {
      console.log(`[referral-nurture] [dry-run] user=${c.user_id} chat=${c.chat_id}`);
      await recordSend(cfg, { user_id: c.user_id, chat_id: c.chat_id, message_text: text, message_id: null, dry_run: true });
      continue;
    }

    if (!token) {
      console.warn("[referral-nurture] TELEGRAM_BOT_TOKEN not set — cannot send; stopping");
      errors++;
      break;
    }

    const result = await sendTelegram(token, c.chat_id, text);
    if (!result.ok) {
      console.error(`[referral-nurture] send failed user=${c.user_id}: ${result.error}`);
      errors++;
      continue;
    }

    await recordSend(cfg, {
      user_id: c.user_id,
      chat_id: c.chat_id,
      message_text: text,
      message_id: result.message_id ?? null,
      dry_run: false,
    });
    sent++;
  }

  console.info(`[referral-nurture] run complete: candidates=${candidates.length} sent=${sent} errors=${errors}`);
}

export function startReferralNurtureScheduler(): void {
  // Check hourly — the DB function only returns candidates when T+14 has passed
  const INTERVAL_MS = 60 * 60 * 1000;

  void runNurtureCheck().catch((err) =>
    console.error("[referral-nurture] initial check failed:", err),
  );

  setInterval(() => {
    void runNurtureCheck().catch((err) =>
      console.error("[referral-nurture] scheduled check failed:", err),
    );
  }, INTERVAL_MS);
}
