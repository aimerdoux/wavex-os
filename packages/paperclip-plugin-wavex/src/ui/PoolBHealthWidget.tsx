/** Mission Control — Pool B Health + Install Funnel ("auto sync").
 *
 *  Answers the five questions the operator wants in their face:
 *    1. Is the Mac actually serving customers right now? (online dot)
 *    2. Which devices are paired + when did each last serve? (table)
 *    3. Are pillar-suggest chips populating? (24h success rate)
 *    4. Are customers following the install path? (funnel: pair → claim → first inference)
 *    5. What's Pool B costing this week? (per-subscription daily roll-up)
 *
 *  All endpoints are board-gated server-side. Polling is 30s aligned to
 *  the server-side cache TTL — refresh button bypasses the cache. */

import { useEffect, useState } from "react";
import { usePluginData, type PluginWidgetProps } from "@wavex-os/plugin-sdk-shim/ui";

const WAVEX_COLOR = "#00d4ff";
const GOOD_COLOR = "#00d97e";
const WARN_COLOR = "#f5a623";
const DANGER_COLOR = "#ff4d4d";
const DIM = "color-mix(in srgb, currentColor 60%, transparent)";

// ── Types matching the server-side rows (see mission-control/pool-b-health.ts)

interface PoolBInferenceRow {
  ran_at: string;
  model: string;
  status: string;
  total_tokens: number;
  cost_usd: number;
  request_id: string;
  device_id: string | null;
  error_class: string | null;
}
interface DeviceStatusRow {
  id: string;
  name: string | null;
  hostname: string | null;
  os_version: string | null;
  created_at: string;
  last_inference_at: string | null;
  is_online: boolean;
}
interface PendingPairingRow {
  user_code: string;
  hostname: string | null;
  status: string;
  created_at: string;
  expires_at: string;
}
interface DailySpendRow {
  day: string;
  subscription_id: string | null;
  tokens: number;
  spend_usd: number;
  errors: number;
  rate_limited: number;
}
interface InstallFunnelSummary {
  pairings_initiated_24h: number;
  pairings_claimed_24h: number;
  devices_first_active_24h: number;
  devices_ever_active: number;
  pillar_suggest_calls_24h: number;
  pillar_suggest_success_24h: number;
}

function formatRelative(iso: string | null): string {
  if (!iso) return "never";
  const diffMs = Date.now() - new Date(iso).getTime();
  if (diffMs < 0) return "in the future";
  const s = Math.floor(diffMs / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function pct(num: number, denom: number): string {
  if (denom <= 0) return "—";
  return `${Math.round((num / denom) * 100)}%`;
}

export function PoolBHealthWidget(_props: PluginWidgetProps) {
  const [fresh, setFresh] = useState(0);
  const params = { fresh: fresh > 0 ? "1" : undefined };

  const recent  = usePluginData<{ ok: boolean; rows: PoolBInferenceRow[] }>("pool-b-health-recent",   { ...params, limit: 20 });
  const devices = usePluginData<{ ok: boolean; rows: DeviceStatusRow[] }>(  "pool-b-health-devices",  params);
  const pairings = usePluginData<{ ok: boolean; rows: PendingPairingRow[] }>("pool-b-health-pairings", params);
  const spend   = usePluginData<{ ok: boolean; rows: DailySpendRow[] }>(    "pool-b-health-spend",    { ...params, days: 14 });
  const funnel  = usePluginData<{ ok: boolean; summary: InstallFunnelSummary | null }>("pool-b-health-funnel", params);

  // Auto-refresh every 30s aligned with server cache TTL.
  useEffect(() => {
    const t = window.setInterval(() => setFresh((n) => n + 1), 30_000);
    return () => window.clearInterval(t);
  }, []);

  const summary = funnel.data?.summary ?? null;
  const onlineDevices = (devices.data?.rows ?? []).filter((d) => d.is_online).length;
  const totalDevices = (devices.data?.rows ?? []).length;
  const chipSuccessRate = summary
    ? pct(summary.pillar_suggest_success_24h, summary.pillar_suggest_calls_24h)
    : "—";

  return (
    <div style={{ padding: "1rem", fontSize: 13 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.75rem" }}>
        <strong style={{ fontSize: 14, color: WAVEX_COLOR }}>Pool B Health · Auto-sync</strong>
        <button
          type="button"
          onClick={() => setFresh((n) => n + 1)}
          style={{ fontSize: 11, padding: "2px 8px", borderRadius: 4, background: "transparent", border: "1px solid currentColor", color: DIM, cursor: "pointer" }}
          aria-label="Refresh (bypass cache)"
        >
          ↻
        </button>
      </div>

      {/* Headline row — 4 numbers */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8, marginBottom: 12 }}>
        <Stat
          label="Mac online"
          value={`${onlineDevices}/${totalDevices}`}
          color={onlineDevices > 0 ? GOOD_COLOR : totalDevices > 0 ? DANGER_COLOR : WARN_COLOR}
          hint={onlineDevices > 0 ? "active <5m ago" : totalDevices > 0 ? "no Mac in last 5m" : "no devices paired"}
        />
        <Stat
          label="Chips OK 24h"
          value={chipSuccessRate}
          color={summary && summary.pillar_suggest_calls_24h > 0 && summary.pillar_suggest_success_24h >= summary.pillar_suggest_calls_24h * 0.9 ? GOOD_COLOR : WARN_COLOR}
          hint={summary ? `${summary.pillar_suggest_success_24h}/${summary.pillar_suggest_calls_24h} requests` : "—"}
        />
        <Stat
          label="Pair→claim 24h"
          value={summary ? pct(summary.pairings_claimed_24h, summary.pairings_initiated_24h) : "—"}
          color={summary && summary.pairings_initiated_24h > 0 && summary.pairings_claimed_24h >= summary.pairings_initiated_24h * 0.5 ? GOOD_COLOR : WARN_COLOR}
          hint={summary ? `${summary.pairings_claimed_24h}/${summary.pairings_initiated_24h} pairings` : "—"}
        />
        <Stat
          label="New active 24h"
          value={String(summary?.devices_first_active_24h ?? 0)}
          color={summary && summary.devices_first_active_24h > 0 ? GOOD_COLOR : DIM}
          hint={`${summary?.devices_ever_active ?? 0} ever`}
        />
      </div>

      {/* Devices */}
      <Section title="Devices">
        {devices.loading && <Empty>Loading devices…</Empty>}
        {!devices.loading && (devices.data?.rows ?? []).length === 0 && (
          <Empty>No devices paired yet. Customers running <code>wavex-os login</code> will appear here.</Empty>
        )}
        {(devices.data?.rows ?? []).map((d) => (
          <Row key={d.id}>
            <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 4, marginRight: 8, background: d.is_online ? GOOD_COLOR : DIM }} />
            <span style={{ flex: 1 }}>
              <code style={{ color: WAVEX_COLOR }}>{d.name ?? "(unnamed)"}</code>
              <span style={{ marginLeft: 8, opacity: 0.7 }}>{d.hostname ?? "—"}</span>
              <span style={{ marginLeft: 8, opacity: 0.5 }}>{d.os_version ?? ""}</span>
            </span>
            <span style={{ opacity: 0.7 }}>last: {formatRelative(d.last_inference_at)}</span>
          </Row>
        ))}
      </Section>

      {/* Pending pairings (install funnel — who's in the middle of `wavex-os login`?) */}
      <Section title="Pending pairings (not yet claimed)">
        {pairings.loading && <Empty>Loading pairings…</Empty>}
        {!pairings.loading && (pairings.data?.rows ?? []).filter((p) => p.status === "pending").length === 0 && (
          <Empty>No pending pairings. (Past pairings collapse once claimed or expired.)</Empty>
        )}
        {(pairings.data?.rows ?? []).filter((p) => p.status === "pending").map((p) => (
          <Row key={p.user_code}>
            <code style={{ fontWeight: 600 }}>{p.user_code}</code>
            <span style={{ marginLeft: 8, opacity: 0.7, flex: 1 }}>{p.hostname ?? "—"}</span>
            <span style={{ opacity: 0.6 }}>started {formatRelative(p.created_at)}</span>
          </Row>
        ))}
      </Section>

      {/* Recent inferences */}
      <Section title="Last 20 inferences">
        {recent.loading && <Empty>Loading…</Empty>}
        {!recent.loading && (recent.data?.rows ?? []).length === 0 && (
          <Empty>No Pool B activity yet. Once a customer triggers pillar-suggest or narrate, rows land here.</Empty>
        )}
        <div style={{ maxHeight: 220, overflowY: "auto" }}>
          {(recent.data?.rows ?? []).map((r) => (
            <Row key={r.request_id} dense>
              <span style={{ flex: "0 0 80px", opacity: 0.6, fontSize: 11 }}>{formatRelative(r.ran_at)}</span>
              <span style={{ flex: 1, fontSize: 11, opacity: 0.8 }}>{r.model}</span>
              <span style={{ flex: "0 0 80px", textAlign: "right", fontSize: 11 }}>{r.total_tokens.toLocaleString()} tok</span>
              <span style={{ flex: "0 0 70px", textAlign: "right", fontSize: 11 }}>${r.cost_usd.toFixed(3)}</span>
              <span style={{
                flex: "0 0 60px", textAlign: "right", fontSize: 11,
                color: r.status === "ok" ? GOOD_COLOR : r.status === "rate_limited" ? WARN_COLOR : DANGER_COLOR,
              }}>{r.status}</span>
            </Row>
          ))}
        </div>
      </Section>

      {/* Per-day Pool B spend */}
      <Section title="Daily spend (last 14d)">
        {spend.loading && <Empty>Loading spend…</Empty>}
        {!spend.loading && (spend.data?.rows ?? []).length === 0 && (
          <Empty>No spend yet.</Empty>
        )}
        {(spend.data?.rows ?? []).slice(0, 10).map((r, i) => (
          <Row key={i} dense>
            <span style={{ flex: "0 0 90px", opacity: 0.7, fontSize: 11 }}>{r.day}</span>
            <span style={{ flex: 1, fontSize: 11, opacity: 0.6 }}>
              {r.subscription_id ? `sub:${r.subscription_id.slice(0, 8)}…` : "(unknown sub)"}
            </span>
            <span style={{ flex: "0 0 90px", textAlign: "right", fontSize: 11 }}>{r.tokens.toLocaleString()} tok</span>
            <span style={{ flex: "0 0 80px", textAlign: "right", fontSize: 11, fontWeight: 600 }}>${r.spend_usd.toFixed(2)}</span>
            {r.errors > 0 && (
              <span style={{ flex: "0 0 40px", textAlign: "right", fontSize: 11, color: DANGER_COLOR }}>{r.errors} err</span>
            )}
          </Row>
        ))}
      </Section>
    </div>
  );
}

// ── Tiny presentational helpers ───────────────────────────────────────────

interface StatProps { label: string; value: string; color: string; hint?: string }
function Stat({ label, value, color, hint }: StatProps) {
  return (
    <div style={{ padding: "0.5rem", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 6 }}>
      <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", opacity: 0.55 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color, marginTop: 2 }}>{value}</div>
      {hint && <div style={{ fontSize: 10, opacity: 0.5, marginTop: 2 }}>{hint}</div>}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", opacity: 0.55, marginBottom: 4 }}>{title}</div>
      {children}
    </div>
  );
}

function Row({ children, dense }: { children: React.ReactNode; dense?: boolean }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 4,
      padding: dense ? "2px 0" : "4px 0",
      borderBottom: "1px dashed rgba(255,255,255,0.05)",
      fontSize: dense ? 11 : 12,
    }}>
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ opacity: 0.5, fontStyle: "italic", padding: "4px 0", fontSize: 12 }}>{children}</div>;
}
