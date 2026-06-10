/** Referral launch blast — one-shot Telegram DM to all active members (WAVAAAAAAAA-154)
 *
 *  Runs ONCE at server startup. Queries wavex_os_list_referral_blast_candidates()
 *  for active members reachable via Telegram who haven't received the launch blast,
 *  and sends the personalized referral message.
 *
 *  Idempotent: wavex_os.referral_sends unique constraint prevents double-send.
 *
 *  Dry-run gating (default ON — safe to deploy):
 *    WAVEX_REFERRAL_BLAST_DRY_RUN — default "true". Set to "false" to send live.
 *
 *  Required env vars:
 *    SUPABASE_URL               — PostgREST endpoint
 *    SUPABASE_SERVICE_ROLE_KEY  — service-role JWT
 *    TELEGRAM_BOT_TOKEN         — concierge bot token
 *  Optional env vars:
 *    WAVEX_REFERRAL_BLAST_DRY_RUN — "true" | "false" (default "true")
 */

interface SupabaseConfig {
  url: string;
  key: string;
}

interface BlastCandidate {
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

const BLAST_MESSAGE_TEMPLATE =
  "Hey {FIRST_NAME},\n\n" +
  "Quick one — we just launched a referral program.\n\n" +
  "Share your personal WaveX link with someone you think would benefit:\n\n" +
  "{REFERRAL_URL}\n\n" +
  "Here is what happens:\n" +
  "- They get 50% off their first month\n" +
  "- You get 1 month completely free once they pay their first invoice\n\n" +
  "No forms to fill. No codes to remember. Your link does everything.\n\n" +
  "Reply here if you have any questions.\n\n" +
  "— The WaveX Team";

function supabaseConfig(): SupabaseConfig | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return { url, key };
}

function isDryRun(): boolean {
  return (process.env.WAVEX_REFERRAL_BLAST_DRY_RUN ?? "true").toLowerCase() !== "false";
}

function renderMessage(candidate: BlastCandidate): string {
  return BLAST_MESSAGE_TEMPLATE
    .replace("{FIRST_NAME}", candidate.first_name)
    .replace("{REFERRAL_URL}", candidate.share_url);
}

async function listCandidates(cfg: SupabaseConfig): Promise<BlastCandidate[]> {
  const res = await fetch(
    `${cfg.url}/rest/v1/rpc/wavex_os_list_referral_blast_candidates`,
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
    throw new Error(`wavex_os_list_referral_blast_candidates failed: ${res.status} ${detail}`);
  }
  return (await res.json().catch(() => [])) as BlastCandidate[];
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
      p_send_type: "blast",
      p_chat_id: args.chat_id,
      p_message_text: args.message_text,
      p_message_id: args.message_id,
      p_dry_run: args.dry_run,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error(`[referral-blast] record_send failed user=${args.user_id}: ${res.status} ${detail}`);
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

export interface ReferralBlastResult {
  candidates: number;
  sent: number;
  dryRun: number;
  errors: number;
}

export async function runReferralBlastJob(): Promise<ReferralBlastResult> {
  const cfg = supabaseConfig();
  if (!cfg) {
    console.warn("[referral-blast] Supabase not configured — skipping");
    return { candidates: 0, sent: 0, dryRun: 0, errors: 0 };
  }

  const dryRun = isDryRun();
  const token = process.env.TELEGRAM_BOT_TOKEN;

  let candidates: BlastCandidate[];
  try {
    candidates = await listCandidates(cfg);
  } catch (err) {
    console.error("[referral-blast] candidate query failed:", err);
    return { candidates: 0, sent: 0, dryRun: 0, errors: 1 };
  }

  console.info(`[referral-blast] candidates=${candidates.length} dryRun=${dryRun}`);

  let sent = 0;
  let dryRunCount = 0;
  let errors = 0;

  for (const c of candidates) {
    const text = renderMessage(c);

    if (dryRun) {
      console.log(`[referral-blast] [dry-run] user=${c.user_id} chat=${c.chat_id} msg=${JSON.stringify(text)}`);
      dryRunCount++;
      await recordSend(cfg, { user_id: c.user_id, chat_id: c.chat_id, message_text: text, message_id: null, dry_run: true });
      continue;
    }

    if (!token) {
      console.warn("[referral-blast] TELEGRAM_BOT_TOKEN not set — cannot send; stopping");
      errors++;
      break;
    }

    const result = await sendTelegram(token, c.chat_id, text);
    if (!result.ok) {
      console.error(`[referral-blast] send failed user=${c.user_id}: ${result.error}`);
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

  const result: ReferralBlastResult = { candidates: candidates.length, sent, dryRun: dryRunCount, errors };
  console.info(`[referral-blast] complete: ${JSON.stringify(result)}`);
  return result;
}
