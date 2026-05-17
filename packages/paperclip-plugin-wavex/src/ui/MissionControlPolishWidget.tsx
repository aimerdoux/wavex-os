/** Mission Control — Phase 7 polish dashboard.
 *
 *  Combines three views:
 *    - Cost: who spent what
 *    - Capacity: who's carrying how much load
 *    - Weekly export: download a CSV snapshot
 *
 *  Operator picks the tab; everything pulls live from the wavex REST
 *  endpoints. CSV download is a JS-side data URL — no server round-trip
 *  beyond the JSON the operator already has. */

import { useMemo, useState } from "react";
import {
  usePluginAction,
  usePluginData,
  type PluginWidgetProps,
} from "@paperclipai/plugin-sdk/ui";

const WAVEX_COLOR = "#00d4ff";
const WAVEX_BG = "color-mix(in srgb, #00d4ff 6%, transparent)";

interface CostRow {
  nodeId: string;
  nodeName: string;
  costUSD: number;
  events: number;
}
interface CostResponse {
  ok: boolean;
  totals?: { costUSD: number; events: number };
  byNode?: CostRow[];
  error?: string;
}

interface CapacityRow {
  nodeId: string;
  nodeName: string;
  inbound: number;
  outbound: number;
  load: number;
}
interface CapacityResponse {
  ok: boolean;
  rows?: CapacityRow[];
  avg?: number;
  max?: number;
  error?: string;
}

interface WeeklyResponse {
  ok: boolean;
  companyId?: string;
  since?: string;
  until?: string;
  summary?: {
    events: number;
    deliverables: number;
    assignments: number;
    costUSD: number;
  };
  topNodesByCost?: CostRow[];
  topNodesByLoad?: CapacityRow[];
  error?: string;
}

type Tab = "cost" | "capacity" | "weekly";

export function MissionControlPolishWidget({ context }: PluginWidgetProps) {
  const companyId = context.companyId ?? "";
  const [tab, setTab] = useState<Tab>("cost");

  const cost = usePluginData<CostResponse>("mission-control-cost", {
    companyId,
  });
  const capacity = usePluginData<CapacityResponse>(
    "mission-control-capacity",
    { companyId },
  );
  const weekly = usePluginData<WeeklyResponse>(
    "mission-control-weekly-export",
    { companyId },
  );
  const fetchCsv = usePluginAction("mission-control-weekly-export-csv");

  if (!companyId) {
    return (
      <Card label="Mission Control — Operations">
        <div style={{ opacity: 0.7 }}>Select a company.</div>
      </Card>
    );
  }

  return (
    <Card label="Mission Control — Operations">
      <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
        <Tab tab="cost" active={tab} onClick={() => setTab("cost")}>
          Cost
        </Tab>
        <Tab tab="capacity" active={tab} onClick={() => setTab("capacity")}>
          Capacity
        </Tab>
        <Tab tab="weekly" active={tab} onClick={() => setTab("weekly")}>
          Weekly export
        </Tab>
      </div>
      {tab === "cost" ? (
        <CostView
          loading={cost.loading && !cost.data}
          error={cost.error?.message}
          data={cost.data}
        />
      ) : tab === "capacity" ? (
        <CapacityView
          loading={capacity.loading && !capacity.data}
          error={capacity.error?.message}
          data={capacity.data}
        />
      ) : (
        <WeeklyView
          loading={weekly.loading && !weekly.data}
          error={weekly.error?.message}
          data={weekly.data}
          onDownload={async () => {
            const res = (await fetchCsv({ companyId })) as { csv?: string };
            if (!res?.csv) return;
            const blob = new Blob([res.csv], { type: "text/csv" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `mc-weekly-${companyId}.csv`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
          }}
        />
      )}
    </Card>
  );
}

function Tab({
  tab,
  active,
  onClick,
  children,
}: {
  tab: Tab;
  active: Tab;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const on = tab === active;
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: "3px 10px",
        fontSize: 11,
        borderRadius: 4,
        textTransform: "uppercase",
        letterSpacing: "0.05em",
        cursor: "pointer",
        border: `1px solid ${on ? `color-mix(in srgb, ${WAVEX_COLOR} 50%, transparent)` : "rgba(255,255,255,0.12)"}`,
        background: on
          ? `color-mix(in srgb, ${WAVEX_COLOR} 18%, transparent)`
          : "transparent",
        color: on ? WAVEX_COLOR : "#8a8f98",
        fontWeight: 600,
      }}
    >
      {children}
    </button>
  );
}

function CostView({
  loading,
  error,
  data,
}: {
  loading: boolean;
  error?: string;
  data: CostResponse | null | undefined;
}) {
  if (loading) return <div style={{ opacity: 0.6, fontSize: 13 }}>Loading…</div>;
  if (error) return <div style={{ color: "#ff6b6b", fontSize: 13 }}>{error}</div>;
  const total = data?.totals?.costUSD ?? 0;
  const rows = data?.byNode ?? [];
  const max = Math.max(0.001, ...rows.map((r) => r.costUSD));
  return (
    <>
      <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 6 }}>
        Total ${total.toFixed(2)} across {data?.totals?.events ?? 0} events
      </div>
      <ul style={listStyle}>
        {rows.slice(0, 10).map((r) => (
          <li key={r.nodeId} style={{ fontSize: 12, padding: "4px 0" }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                marginBottom: 3,
              }}
            >
              <span>{r.nodeName}</span>
              <span style={{ opacity: 0.75 }}>
                ${r.costUSD.toFixed(2)} · {r.events} evt
              </span>
            </div>
            <Bar value={r.costUSD} max={max} />
          </li>
        ))}
      </ul>
    </>
  );
}

function CapacityView({
  loading,
  error,
  data,
}: {
  loading: boolean;
  error?: string;
  data: CapacityResponse | null | undefined;
}) {
  if (loading) return <div style={{ opacity: 0.6, fontSize: 13 }}>Loading…</div>;
  if (error) return <div style={{ color: "#ff6b6b", fontSize: 13 }}>{error}</div>;
  const rows = data?.rows ?? [];
  const max = Math.max(0.001, ...rows.map((r) => r.load));
  return (
    <>
      <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 6 }}>
        avg load {(data?.avg ?? 0).toFixed(1)} · max {data?.max ?? 0}
      </div>
      <ul style={listStyle}>
        {rows.slice(0, 10).map((r) => (
          <li key={r.nodeId} style={{ fontSize: 12, padding: "4px 0" }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                marginBottom: 3,
              }}
            >
              <span>{r.nodeName}</span>
              <span style={{ opacity: 0.75 }}>
                in {r.inbound} · out {r.outbound} · load {r.load}
              </span>
            </div>
            <Bar value={r.load} max={max} />
          </li>
        ))}
      </ul>
    </>
  );
}

function WeeklyView({
  loading,
  error,
  data,
  onDownload,
}: {
  loading: boolean;
  error?: string;
  data: WeeklyResponse | null | undefined;
  onDownload: () => void;
}) {
  if (loading) return <div style={{ opacity: 0.6, fontSize: 13 }}>Loading…</div>;
  if (error) return <div style={{ color: "#ff6b6b", fontSize: 13 }}>{error}</div>;
  const summary = data?.summary;
  return (
    <div>
      {data?.since ? (
        <div style={{ fontSize: 11, opacity: 0.65, marginBottom: 8 }}>
          {new Date(data.since).toLocaleDateString()} →{" "}
          {new Date(data.until ?? "").toLocaleDateString()}
        </div>
      ) : null}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 6,
          marginBottom: 10,
        }}
      >
        <Stat label="Events" value={summary?.events ?? 0} />
        <Stat label="Deliverables" value={summary?.deliverables ?? 0} />
        <Stat label="Assignments" value={summary?.assignments ?? 0} />
        <Stat
          label="Cost USD"
          value={`$${(summary?.costUSD ?? 0).toFixed(2)}`}
        />
      </div>
      <button type="button" onClick={onDownload} style={primaryButtonStyle}>
        download CSV
      </button>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div
      style={{
        padding: "6px 8px",
        background: "rgba(255,255,255,0.04)",
        borderRadius: 4,
        border: "1px solid rgba(255,255,255,0.07)",
      }}
    >
      <div
        style={{
          fontSize: 10,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          opacity: 0.6,
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 16, fontWeight: 600, color: WAVEX_COLOR }}>
        {value}
      </div>
    </div>
  );
}

function Bar({ value, max }: { value: number; max: number }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div
      style={{
        height: 6,
        borderRadius: 3,
        background: "rgba(255,255,255,0.06)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          width: `${pct}%`,
          height: "100%",
          background: WAVEX_COLOR,
          borderRadius: 3,
        }}
      />
    </div>
  );
}

function Card({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-label={label}
      style={{
        padding: "12px 14px",
        borderRadius: 6,
        border: `1px solid color-mix(in srgb, ${WAVEX_COLOR} 25%, transparent)`,
        background: WAVEX_BG,
      }}
    >
      <div
        style={{
          fontSize: 11,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          opacity: 0.7,
          marginBottom: 8,
          color: WAVEX_COLOR,
        }}
      >
        {label}
      </div>
      {children}
    </section>
  );
}

const listStyle: React.CSSProperties = {
  margin: 0,
  padding: 0,
  listStyle: "none",
};
const primaryButtonStyle: React.CSSProperties = {
  background: `color-mix(in srgb, ${WAVEX_COLOR} 18%, transparent)`,
  color: WAVEX_COLOR,
  border: `1px solid color-mix(in srgb, ${WAVEX_COLOR} 45%, transparent)`,
  borderRadius: 4,
  padding: "4px 10px",
  cursor: "pointer",
  fontSize: 12,
  fontWeight: 600,
};
