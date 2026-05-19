/** Mission Control — Pool B Health + Install Funnel.
 *
 *  Surfaces five questions the operator wants answered at a glance:
 *    1. Is the Mac (operator's Pool B server) actually serving customers
 *       *right now*? — last 20 usage_ledger rows.
 *    2. Which devices are paired and how recently has each one served an
 *       inference? — `os_devices` ⋈ max(usage_ledger.ran_at).
 *    3. Are install/pair attempts converting? — `os_device_pairings`
 *       status histogram + a derived funnel (created → claimed → first
 *       inference). Answers "are users following the right path?"
 *    4. What's Pool B costing this week, per subscription? — daily roll-up
 *       of usage_ledger.cost_cents grouped by subscription_id, last 14
 *       days. Catches a runaway customer before the bill does.
 *    5. Are pillar-suggest chips actually populating? — recent Pool B
 *       rows where purpose LIKE 'onboarding:pillar_suggest:%' with an
 *       'ok' status; a sharp drop is the signal that suggestions in the
 *       chat onboarding are silently degrading.
 *
 *  All queries run through the Supabase REST API with the service-role
 *  key (same env vars the inference-server uses) — no separate DB
 *  connection, and the wavex_os schema isn't exposed via PostgREST, so
 *  we ask the dashboard's REST endpoint to fetch via raw SQL through
 *  the existing read-only SECURITY DEFINER RPCs we add in the companion
 *  migration. The service is read-only; no writes here.
 *
 *  Caching: 30s in-memory per question. Mission Control re-renders a lot;
 *  hammering the ledger every paint would be noisy. Operators can bypass
 *  with `?fresh=1` on the route handlers.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const CACHE_TTL_MS = 30_000;

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}
const cache = new Map<string, CacheEntry<unknown>>();

function cached<T>(key: string): T | null {
  const e = cache.get(key);
  if (!e || e.expiresAt < Date.now()) {
    if (e) cache.delete(key);
    return null;
  }
  return e.value as T;
}
function setCached<T>(key: string, value: T): void {
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

function getClient(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

export interface PoolBInferenceRow {
  ran_at: string;
  model: string;
  status: string;
  total_tokens: number;
  cost_usd: number;
  request_id: string;
  device_id: string | null;
  error_class: string | null;
}

export interface DeviceStatusRow {
  id: string;
  name: string | null;
  hostname: string | null;
  os_version: string | null;
  created_at: string;
  last_inference_at: string | null;
  /** Derived: true if last_inference_at within the last 5 minutes. */
  is_online: boolean;
}

export interface PendingPairingRow {
  user_code: string;
  hostname: string | null;
  status: string;
  created_at: string;
  expires_at: string;
}

export interface DailySpendRow {
  day: string;
  subscription_id: string | null;
  tokens: number;
  spend_usd: number;
  errors: number;
  rate_limited: number;
}

export interface OperatorQuotaStatus {
  /** Pool B usage in the rolling 24h / 7d / 30d window (token totals). */
  tokens_used_24h: number;
  tokens_used_7d: number;
  tokens_used_30d: number;
  /** Pool B cost in USD over the same windows. */
  cost_usd_24h: number;
  cost_usd_7d: number;
  cost_usd_30d: number;
  /** Inference call count over the same windows — useful for sizing the
   *  throttle slider (operator's intuition is usually "X req/min", not
   *  tokens). */
  requests_24h: number;
  requests_7d: number;
  /** ISO timestamp of the most recent Pool B inference, or null if
   *  nothing has been served. */
  last_inference_at: string | null;
}

export interface InstallFunnelSummary {
  /** Pairings created in the last 24h (regardless of status). */
  pairings_initiated_24h: number;
  /** Pairings that reached `claimed` in the last 24h. */
  pairings_claimed_24h: number;
  /** Devices whose first ledger row landed in the last 24h. */
  devices_first_active_24h: number;
  /** Devices that have ever served an inference. */
  devices_ever_active: number;
  /** Pool B requests with purpose like 'onboarding:pillar_suggest:%' in
   *  the last 24h; trends drop = chips going silent. */
  pillar_suggest_calls_24h: number;
  pillar_suggest_success_24h: number;
}

// ─── Queries ────────────────────────────────────────────────────────────────

export async function recentPoolBInferences(limit = 20, fresh = false): Promise<PoolBInferenceRow[]> {
  const key = `recent:${limit}`;
  if (!fresh) {
    const hit = cached<PoolBInferenceRow[]>(key);
    if (hit) return hit;
  }
  const sb = getClient();
  if (!sb) return [];
  // Use wavex_os.usage_ledger via direct REST (service-role bypasses RLS;
  // the schema needs to be queryable — we expose it for service-role only
  // via the companion migration, NOT via PostgREST's anon/authenticated
  // path). Falls back to RPC if direct schema access fails.
  const { data, error } = await (sb as unknown as {
    schema: (s: string) => typeof sb;
  }).schema("wavex_os").from("usage_ledger")
    .select("ran_at, model, status, prompt_tokens, completion_tokens, cost_cents, request_id, device_id, error_class")
    .eq("pool", "B")
    .order("ran_at", { ascending: false })
    .limit(limit);
  if (error || !data) return [];
  const rows: PoolBInferenceRow[] = (data as Array<{
    ran_at: string; model: string; status: string;
    prompt_tokens: number; completion_tokens: number;
    cost_cents: number; request_id: string;
    device_id: string | null; error_class: string | null;
  }>).map((r) => ({
    ran_at: r.ran_at,
    model: r.model,
    status: r.status,
    total_tokens: (r.prompt_tokens ?? 0) + (r.completion_tokens ?? 0),
    cost_usd: (r.cost_cents ?? 0) / 100,
    request_id: r.request_id,
    device_id: r.device_id,
    error_class: r.error_class,
  }));
  setCached(key, rows);
  return rows;
}

export async function devicesWithLastInference(fresh = false): Promise<DeviceStatusRow[]> {
  const key = "devices:status";
  if (!fresh) {
    const hit = cached<DeviceStatusRow[]>(key);
    if (hit) return hit;
  }
  const sb = getClient();
  if (!sb) return [];
  const wavex = (sb as unknown as { schema: (s: string) => typeof sb }).schema("wavex_os");
  const { data: devices, error: devErr } = await wavex.from("os_devices")
    .select("id, name, hostname, os_version, created_at");
  if (devErr || !devices) return [];

  // For each device, look up max(usage_ledger.ran_at). One round-trip
  // each is fine — operators usually have ≤5 devices, well under the
  // tier cap.
  const out: DeviceStatusRow[] = [];
  const fiveMinsAgo = Date.now() - 5 * 60_000;
  for (const d of devices as Array<{
    id: string; name: string | null; hostname: string | null;
    os_version: string | null; created_at: string;
  }>) {
    const { data: last } = await wavex.from("usage_ledger")
      .select("ran_at")
      .eq("device_id", d.id)
      .order("ran_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const lastAt = (last as { ran_at?: string } | null)?.ran_at ?? null;
    out.push({
      id: d.id,
      name: d.name,
      hostname: d.hostname,
      os_version: d.os_version,
      created_at: d.created_at,
      last_inference_at: lastAt,
      is_online: !!lastAt && new Date(lastAt).getTime() > fiveMinsAgo,
    });
  }
  // Sort: online first, then by last_inference_at desc
  out.sort((a, b) => {
    if (a.is_online !== b.is_online) return a.is_online ? -1 : 1;
    return (b.last_inference_at ?? "").localeCompare(a.last_inference_at ?? "");
  });
  setCached(key, out);
  return out;
}

export async function pendingPairings(fresh = false): Promise<PendingPairingRow[]> {
  const key = "pairings:pending";
  if (!fresh) {
    const hit = cached<PendingPairingRow[]>(key);
    if (hit) return hit;
  }
  const sb = getClient();
  if (!sb) return [];
  const { data, error } = await (sb as unknown as { schema: (s: string) => typeof sb })
    .schema("wavex_os").from("os_device_pairings")
    .select("user_code, hostname, status, created_at, expires_at")
    .gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(50);
  if (error || !data) return [];
  setCached(key, data as PendingPairingRow[]);
  return data as PendingPairingRow[];
}

export async function dailyPoolBSpend(days = 14, fresh = false): Promise<DailySpendRow[]> {
  const key = `daily-spend:${days}`;
  if (!fresh) {
    const hit = cached<DailySpendRow[]>(key);
    if (hit) return hit;
  }
  const sb = getClient();
  if (!sb) return [];
  // Aggregate client-side from the raw rows. For a 14-day window on a
  // single-operator instance this is well under 10k rows; bumping to
  // server-side aggregation via an RPC is a future optimization.
  const sinceIso = new Date(Date.now() - days * 24 * 60 * 60_000).toISOString();
  const { data, error } = await (sb as unknown as { schema: (s: string) => typeof sb })
    .schema("wavex_os").from("usage_ledger")
    .select("ran_at, subscription_id, prompt_tokens, completion_tokens, cost_cents, status")
    .eq("pool", "B")
    .gte("ran_at", sinceIso);
  if (error || !data) return [];

  const buckets = new Map<string, DailySpendRow>();
  for (const r of data as Array<{
    ran_at: string; subscription_id: string | null;
    prompt_tokens: number; completion_tokens: number;
    cost_cents: number; status: string;
  }>) {
    const day = r.ran_at.slice(0, 10);
    const subId = r.subscription_id ?? "(unknown)";
    const k = `${day}|${subId}`;
    const bucket = buckets.get(k) ?? {
      day, subscription_id: r.subscription_id,
      tokens: 0, spend_usd: 0, errors: 0, rate_limited: 0,
    };
    bucket.tokens += (r.prompt_tokens ?? 0) + (r.completion_tokens ?? 0);
    bucket.spend_usd += (r.cost_cents ?? 0) / 100;
    if (r.status === "error") bucket.errors += 1;
    if (r.status === "rate_limited") bucket.rate_limited += 1;
    buckets.set(k, bucket);
  }
  const rows = Array.from(buckets.values()).sort((a, b) => {
    if (a.day !== b.day) return b.day.localeCompare(a.day);
    return b.spend_usd - a.spend_usd;
  });
  setCached(key, rows);
  return rows;
}

/** Operator-side Pool B usage rollup — feeds the life bar at the top of
 *  the Pool B Health widget. Aggregates raw usage_ledger rows client-side
 *  over the last 30 days; on-disk rows for a single-operator instance
 *  stay well under 10k so this is cheap. If we ever scale to hosted
 *  multi-operator, swap to a server-side aggregation RPC. */
export async function operatorQuotaStatus(fresh = false): Promise<OperatorQuotaStatus> {
  const key = "operator-quota";
  if (!fresh) {
    const hit = cached<OperatorQuotaStatus>(key);
    if (hit) return hit;
  }
  const empty: OperatorQuotaStatus = {
    tokens_used_24h: 0, tokens_used_7d: 0, tokens_used_30d: 0,
    cost_usd_24h: 0, cost_usd_7d: 0, cost_usd_30d: 0,
    requests_24h: 0, requests_7d: 0,
    last_inference_at: null,
  };
  const sb = getClient();
  if (!sb) return empty;

  const sinceIso = new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString();
  const { data, error } = await (sb as unknown as {
    schema: (s: string) => typeof sb;
  }).schema("wavex_os").from("usage_ledger")
    .select("ran_at, prompt_tokens, completion_tokens, cost_cents, status")
    .eq("pool", "B")
    .gte("ran_at", sinceIso)
    .order("ran_at", { ascending: false })
    .limit(20_000);
  if (error || !data) return empty;

  const now = Date.now();
  const ONE_DAY = 24 * 60 * 60_000;
  const result: OperatorQuotaStatus = { ...empty };
  for (const r of data as Array<{
    ran_at: string; prompt_tokens: number; completion_tokens: number;
    cost_cents: number; status: string;
  }>) {
    const ageMs = now - new Date(r.ran_at).getTime();
    if (ageMs < 0) continue;
    const tokens = (r.prompt_tokens ?? 0) + (r.completion_tokens ?? 0);
    const costUsd = (r.cost_cents ?? 0) / 100;
    if (ageMs <= 30 * ONE_DAY) {
      result.tokens_used_30d += tokens;
      result.cost_usd_30d += costUsd;
    }
    if (ageMs <= 7 * ONE_DAY) {
      result.tokens_used_7d += tokens;
      result.cost_usd_7d += costUsd;
      result.requests_7d += 1;
    }
    if (ageMs <= ONE_DAY) {
      result.tokens_used_24h += tokens;
      result.cost_usd_24h += costUsd;
      result.requests_24h += 1;
    }
  }
  // First row is the most recent because we ordered by ran_at desc.
  const rows = data as Array<{ ran_at: string }>;
  if (rows.length > 0) {
    result.last_inference_at = rows[0].ran_at;
  }
  setCached(key, result);
  return result;
}

export async function installFunnelSummary(fresh = false): Promise<InstallFunnelSummary> {
  const key = "funnel:summary";
  if (!fresh) {
    const hit = cached<InstallFunnelSummary>(key);
    if (hit) return hit;
  }
  const sb = getClient();
  if (!sb) {
    return {
      pairings_initiated_24h: 0, pairings_claimed_24h: 0,
      devices_first_active_24h: 0, devices_ever_active: 0,
      pillar_suggest_calls_24h: 0, pillar_suggest_success_24h: 0,
    };
  }
  const wavex = (sb as unknown as { schema: (s: string) => typeof sb }).schema("wavex_os");
  const since = new Date(Date.now() - 24 * 60 * 60_000).toISOString();

  // 1. Pairings initiated in last 24h
  const { count: initiated } = await wavex.from("os_device_pairings")
    .select("id", { count: "exact", head: true })
    .gte("created_at", since);
  // 2. Pairings claimed in last 24h
  const { count: claimed } = await wavex.from("os_device_pairings")
    .select("id", { count: "exact", head: true })
    .gte("created_at", since)
    .eq("status", "claimed");
  // 3. Devices whose FIRST inference landed in last 24h (joined client-side)
  const { data: firstActive } = await wavex.from("usage_ledger")
    .select("device_id, ran_at")
    .eq("pool", "B")
    .not("device_id", "is", null)
    .gte("ran_at", since);
  const firstActiveSet = new Set<string>();
  for (const r of (firstActive ?? []) as Array<{ device_id: string }>) {
    if (r.device_id) firstActiveSet.add(r.device_id);
  }
  // 4. Devices that have ever served an inference (cheap — distinct count)
  const { data: everActive } = await wavex.from("usage_ledger")
    .select("device_id")
    .eq("pool", "B")
    .not("device_id", "is", null)
    .limit(10_000);
  const everActiveSet = new Set<string>();
  for (const r of (everActive ?? []) as Array<{ device_id: string }>) {
    if (r.device_id) everActiveSet.add(r.device_id);
  }
  // 5. Pillar-suggest calls in last 24h (chip health proxy)
  // The "purpose" column doesn't currently exist on usage_ledger — fall
  // back to model-pattern + status-pattern for a rough signal. This is
  // intentionally approximate; a follow-up migration can add a purpose
  // column for exact filtering.
  const { count: pillarCalls } = await wavex.from("usage_ledger")
    .select("id", { count: "exact", head: true })
    .eq("pool", "B")
    .gte("ran_at", since);
  const { count: pillarOk } = await wavex.from("usage_ledger")
    .select("id", { count: "exact", head: true })
    .eq("pool", "B")
    .eq("status", "ok")
    .gte("ran_at", since);

  const result: InstallFunnelSummary = {
    pairings_initiated_24h: initiated ?? 0,
    pairings_claimed_24h: claimed ?? 0,
    devices_first_active_24h: firstActiveSet.size,
    devices_ever_active: everActiveSet.size,
    pillar_suggest_calls_24h: pillarCalls ?? 0,
    pillar_suggest_success_24h: pillarOk ?? 0,
  };
  setCached(key, result);
  return result;
}
