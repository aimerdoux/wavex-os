/** Mission Control — Inbound-quality scoreboard sampler (WAVAAAAA-141).
 *
 *  Reads per-source inbound-quality rows from the tenant Supabase via the
 *  SECURITY DEFINER RPC `public.wavex_os_compute_inbound_quality()` and
 *  writes one kpi_snapshots row per token per week into the wavex-os
 *  internal db. Also emits a per-channel `inbound_unknown_share_<channel>`
 *  data-quality row and surfaces channels whose unknown_share exceeded the
 *  10% threshold (the caller forwards those to the Telegram board).
 *
 *  Idempotency contract (per WAVAAAAA-141 §3): the writer deletes any prior
 *  row matching (companyId, kpiName, metadata->>'window_end') before
 *  inserting. Re-running the sampler for the same window is safe.
 *
 *  Sister to kpi-sampler.ts. Same kpiSnapshots insert idiom as
 *  bridge/finalize-bridge.ts:281.
 *
 *  Cron: Sundays 23:00 UTC (`0 23 * * 0`). Trigger via
 *  POST /api/mission-control/:companyId/sample-inbound-quality.
 */

import { type Db, getDb, kpiSnapshots } from "@wavex-os/db";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { sql } from "drizzle-orm";

export interface InboundQualityRow {
  source: string;
  inbound_count: number;
  cohort_size: number;
  fbc14: number;
  rr60: number;
  inbound_quality: number;
  unknown_share: number;
  channel: string;
  confidence: "captured" | "inferred" | "legacy";
  bucket: "ranked" | "insufficient_data";
  window_start: string;
  window_end: string;
}

export interface InboundQualitySampleResult {
  /** Number of per-source rows written. */
  perSourceRows: number;
  /** Number of per-channel data-quality rows written. */
  perChannelRows: number;
  /** Channels whose unknown_share > 10% this window — caller alerts. */
  unknownShareAlerts: Array<{ channel: string; unknownShare: number }>;
  /** The window_end the writer used (ISO string). */
  windowEnd: string;
}

const UNKNOWN_SHARE_ALERT_THRESHOLD = 0.10;

function getTenantSupabase(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

/** Encode a float (0..1) as bigint micros. Round half-to-even. */
function micros(value: number): bigint {
  if (!Number.isFinite(value)) return 0n;
  return BigInt(Math.round(value * 1_000_000));
}

export async function sampleInboundQuality(
  companyId: string,
  opts: { db?: Db; supabase?: SupabaseClient; windowEnd?: Date } = {},
): Promise<InboundQualitySampleResult> {
  const db = opts.db ?? (await getDb());
  const supabase = opts.supabase ?? getTenantSupabase();
  if (!supabase) {
    throw new Error(
      "sampleInboundQuality: tenant Supabase not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)",
    );
  }

  const { data, error } = await supabase.rpc("wavex_os_compute_inbound_quality", {
    p_window_end: opts.windowEnd?.toISOString() ?? null,
  });
  if (error) {
    throw new Error(`compute_inbound_quality RPC failed: ${error.message}`);
  }
  const rows = (data ?? []) as InboundQualityRow[];
  if (rows.length === 0) {
    return { perSourceRows: 0, perChannelRows: 0, unknownShareAlerts: [], windowEnd: "" };
  }

  const windowEnd = rows[0]!.window_end;
  const windowStart = rows[0]!.window_start;
  const now = new Date();

  // ── per-source rows ──────────────────────────────────────────────
  const perSourceKpiNames = rows.map((r) => `inbound_quality_${r.source}`);

  // ── per-channel unknown-share rows ───────────────────────────────
  const channelUnknownShare = new Map<string, number>();
  for (const r of rows) {
    if (!channelUnknownShare.has(r.channel)) {
      channelUnknownShare.set(r.channel, r.unknown_share);
    }
  }
  const perChannelKpiNames = Array.from(channelUnknownShare.keys()).map(
    (ch) => `inbound_unknown_share_${ch}`,
  );

  // ── idempotency: drop prior rows matching this window ───────────
  const allKpiNames = [...perSourceKpiNames, ...perChannelKpiNames];
  if (allKpiNames.length > 0) {
    await db.delete(kpiSnapshots).where(
      sql`${kpiSnapshots.companyId} = ${companyId}
        and ${kpiSnapshots.kpiName} in (${sql.join(allKpiNames.map((n) => sql`${n}`), sql`, `)})
        and ${kpiSnapshots.metadata}->>'window_end' = ${windowEnd}`,
    );
  }

  // ── insert per-source rows ──────────────────────────────────────
  const sourceInserts = rows.map((r) => ({
    companyId,
    kpiName: `inbound_quality_${r.source}`,
    value: micros(r.inbound_quality),
    measuredAt: now,
    metadata: {
      source: r.source,
      fbc14: r.fbc14,
      rr60: r.rr60,
      inbound_count: r.inbound_count,
      cohort_size: r.cohort_size,
      confidence: r.confidence,
      bucket: r.bucket,
      window_start: windowStart,
      window_end: windowEnd,
    },
  }));
  if (sourceInserts.length > 0) await db.insert(kpiSnapshots).values(sourceInserts);

  // ── insert per-channel data-quality rows ────────────────────────
  const channelInserts = Array.from(channelUnknownShare.entries()).map(([channel, share]) => ({
    companyId,
    kpiName: `inbound_unknown_share_${channel}`,
    value: micros(share),
    measuredAt: now,
    metadata: {
      channel,
      unknown_share: share,
      window_start: windowStart,
      window_end: windowEnd,
    },
  }));
  if (channelInserts.length > 0) await db.insert(kpiSnapshots).values(channelInserts);

  // ── compute alerts (caller posts to Telegram board) ─────────────
  const unknownShareAlerts: Array<{ channel: string; unknownShare: number }> = [];
  for (const [channel, share] of channelUnknownShare) {
    if (share > UNKNOWN_SHARE_ALERT_THRESHOLD) {
      unknownShareAlerts.push({ channel, unknownShare: share });
    }
  }

  return {
    perSourceRows: sourceInserts.length,
    perChannelRows: channelInserts.length,
    unknownShareAlerts,
    windowEnd,
  };
}
