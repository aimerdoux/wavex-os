/** Mission Control — Accountability Map (Frontier F6).
 *
 *  Replaces the abstract Accountability Graph with a scannable card
 *  grid. Each card answers the operator's question in 5 seconds:
 *
 *    "Who is this? What do they own? Are they OK? What did they do?"
 *
 *  Click a card → opens Receipts for the agent's top-owned KPI.
 *  If they own no KPIs, the card is non-interactive but still visible
 *  so the operator can see capacity.
 *
 *  Sort order: critical → at-risk → healthy, then by activity desc.
 *  Polls every 30s.
 */

import { useEffect, useMemo, useState } from "react";
import { usePluginData, type PluginWidgetProps } from "@paperclipai/plugin-sdk/ui";
import { ReceiptsPanel } from "./ReceiptsPanel.js";

const MINT = "#4ec9b0";
const GOOD = "#4ade80";
const WARN = "#ffd166";
const URGENT = "#ff6b6b";
const TEXT = "rgba(255,255,255,0.92)";
const TEXT_MUTED = "rgba(255,255,255,0.62)";
const TEXT_DIM = "rgba(255,255,255,0.45)";
const SURFACE = "rgba(255,255,255,0.025)";
const SURFACE_ALT = "rgba(255,255,255,0.04)";
const BORDER = "rgba(255,255,255,0.08)";

type Health = "healthy" | "at-risk" | "critical";
type KpiStatus = "on-track" | "at-risk" | "off-track" | "unknown";

interface OwnedKpi {
  kpiId: string;
  status: KpiStatus;
  current: number | null;
  target: number | null;
}

interface Card {
  nodeId: string;
  name: string;
  role: string;
  kind: string;
  health: Health;
  isBottleneck: boolean;
  ownedKpis: OwnedKpi[];
  openWork: number;
  reviewables: number;
  activityCount: number;
  recentActivity: string | null;
  recentAt: string | null;
  costUSD7d: number;
  topKpiId: string | null;
}

interface MapResponse {
  ok: boolean;
  cards?: Card[];
  total?: number;
  generatedAt?: string;
}

const HEALTH_COLOR: Record<Health, string> = {
  healthy: GOOD,
  "at-risk": WARN,
  critical: URGENT,
};

const HEALTH_LABEL: Record<Health, string> = {
  healthy: "Healthy",
  "at-risk": "At risk",
  critical: "Critical",
};

const KPI_COLOR: Record<KpiStatus, string> = {
  "on-track": GOOD,
  "at-risk": WARN,
  "off-track": URGENT,
  unknown: TEXT_DIM,
};

function fmtRelative(iso: string | null): string {
  if (!iso) return "no recent activity";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "no recent activity";
  const delta = Math.max(0, Date.now() - t);
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return `${Math.floor(delta / 86_400_000)}d ago`;
}

export function AccountabilityMap({ context }: PluginWidgetProps) {
  const companyId = context.companyId ?? "";
  const { data, loading, error, refresh } = usePluginData<MapResponse>(
    "mission-control-accountability-map",
    { companyId },
  );
  const [receiptsKpi, setReceiptsKpi] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "attention">("all");

  useEffect(() => {
    if (!companyId) return;
    const h = setInterval(() => refresh(), 30_000);
    return () => clearInterval(h);
  }, [companyId, refresh]);

  const cards = useMemo(() => {
    const all = data?.cards ?? [];
    if (filter === "attention") {
      return all.filter((c) => c.health !== "healthy" || c.isBottleneck);
    }
    return all;
  }, [data, filter]);

  const counts = useMemo(() => {
    const all = data?.cards ?? [];
    return {
      total: all.length,
      critical: all.filter((c) => c.health === "critical").length,
      atRisk: all.filter((c) => c.health === "at-risk").length,
      bottleneck: all.filter((c) => c.isBottleneck).length,
    };
  }, [data]);

  if (!companyId) {
    return <Empty>Select a company to load the accountability map.</Empty>;
  }
  if (loading && !data) {
    return <Empty>Loading accountability map…</Empty>;
  }
  if (error) {
    return (
      <Empty>
        Could not load: {error.message}{" "}
        <button onClick={refresh} style={linkStyle}>retry</button>
      </Empty>
    );
  }
  if (cards.length === 0 && filter === "all") {
    return (
      <Empty>
        No accountable owners yet. Activate your fleet (see the Dashboard's
        Inception Status) and agents will appear here as soon as they're hired.
      </Empty>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "0 4px",
          flexWrap: "wrap",
        }}
      >
        <strong style={{ fontSize: 13, color: TEXT, letterSpacing: "0.02em" }}>
          {counts.total} owner{counts.total === 1 ? "" : "s"}
        </strong>
        <CountChip count={counts.critical} color={URGENT} label="critical" />
        <CountChip count={counts.atRisk} color={WARN} label="at risk" />
        <CountChip count={counts.bottleneck} color={URGENT} label="bottlenecks" />
        <div style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
          <FilterPill
            label="All"
            on={filter === "all"}
            onClick={() => setFilter("all")}
          />
          <FilterPill
            label={`Needs attention${counts.critical + counts.atRisk > 0 ? ` (${counts.critical + counts.atRisk})` : ""}`}
            on={filter === "attention"}
            onClick={() => setFilter("attention")}
          />
        </div>
        <button type="button" onClick={refresh} style={linkStyle}>
          refresh
        </button>
      </div>

      {cards.length === 0 ? (
        <Empty>Nothing in this filter — everyone's healthy.</Empty>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
            gap: 10,
          }}
        >
          {cards.map((c) => (
            <OwnerCard
              key={c.nodeId}
              card={c}
              onOpen={() => c.topKpiId && setReceiptsKpi(c.topKpiId)}
            />
          ))}
        </div>
      )}

      <ReceiptsPanel
        companyId={companyId}
        kpiId={receiptsKpi}
        onClose={() => setReceiptsKpi(null)}
      />
    </div>
  );
}

function OwnerCard({ card, onOpen }: { card: Card; onOpen: () => void }) {
  const healthColor = HEALTH_COLOR[card.health];
  const interactive = card.topKpiId != null;
  return (
    <div
      role={interactive ? "button" : undefined}
      tabIndex={interactive ? 0 : undefined}
      onClick={interactive ? onOpen : undefined}
      onKeyDown={(e) => {
        if (interactive && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onOpen();
        }
      }}
      title={interactive ? `Open receipts for ${card.topKpiId}` : undefined}
      style={{
        position: "relative",
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: "12px 14px 12px 18px",
        background: SURFACE,
        border: `1px solid ${BORDER}`,
        borderRadius: 10,
        borderLeft: `3px solid ${healthColor}`,
        cursor: interactive ? "pointer" : "default",
        transition: "background 100ms ease, border-color 100ms ease",
      }}
      onMouseEnter={(e) => {
        if (interactive) {
          e.currentTarget.style.background = SURFACE_ALT;
        }
      }}
      onMouseLeave={(e) => {
        if (interactive) {
          e.currentTarget.style.background = SURFACE;
        }
      }}
    >
      {/* Header: name + role + health */}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Avatar name={card.name} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: TEXT,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {card.name}
          </div>
          <div style={{ fontSize: 10, color: TEXT_DIM, letterSpacing: "0.04em", textTransform: "uppercase" }}>
            {card.role}
          </div>
        </div>
        <Pill color={healthColor} label={HEALTH_LABEL[card.health]} />
      </div>

      {/* Bottleneck warning */}
      {card.isBottleneck ? (
        <div
          style={{
            fontSize: 10,
            color: URGENT,
            padding: "3px 8px",
            background: `color-mix(in srgb, ${URGENT} 12%, transparent)`,
            borderRadius: 4,
            alignSelf: "flex-start",
            fontWeight: 600,
            letterSpacing: "0.04em",
            textTransform: "uppercase",
          }}
        >
          🚧 Bottleneck — {card.reviewables} reviewable{card.reviewables === 1 ? "" : "s"}
        </div>
      ) : null}

      {/* Owned KPIs */}
      {card.ownedKpis.length > 0 ? (
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {card.ownedKpis.slice(0, 4).map((k) => (
            <span
              key={k.kpiId}
              title={`${k.kpiId}${k.current != null ? ` · ${k.current}${k.target ? ` / ${k.target}` : ""}` : ""}`}
              style={{
                fontSize: 10,
                padding: "2px 7px",
                borderRadius: 4,
                background: `color-mix(in srgb, ${KPI_COLOR[k.status]} 10%, transparent)`,
                border: `1px solid color-mix(in srgb, ${KPI_COLOR[k.status]} 30%, transparent)`,
                color: KPI_COLOR[k.status],
                maxWidth: 110,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {k.kpiId}
            </span>
          ))}
          {card.ownedKpis.length > 4 ? (
            <span style={{ fontSize: 10, color: TEXT_DIM, alignSelf: "center" }}>
              +{card.ownedKpis.length - 4}
            </span>
          ) : null}
        </div>
      ) : (
        <div style={{ fontSize: 11, color: TEXT_DIM, fontStyle: "italic" }}>
          No KPIs owned
        </div>
      )}

      {/* Stats row */}
      <div
        style={{
          display: "flex",
          gap: 14,
          fontSize: 11,
          color: TEXT_MUTED,
          marginTop: 2,
        }}
      >
        <Stat label="Work" value={String(card.openWork)} />
        {card.reviewables > 0 ? (
          <Stat label="In review" value={String(card.reviewables)} color={WARN} />
        ) : null}
        <Stat label="Events 7d" value={String(card.activityCount)} />
        <Stat label="Cost 7d" value={`$${card.costUSD7d.toFixed(2)}`} />
      </div>

      {/* Recent activity */}
      {card.recentActivity ? (
        <div
          style={{
            fontSize: 11,
            color: TEXT_MUTED,
            lineHeight: 1.4,
            paddingTop: 6,
            borderTop: `1px solid ${BORDER}`,
            display: "flex",
            justifyContent: "space-between",
            gap: 8,
          }}
        >
          <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {card.recentActivity}
          </span>
          <span style={{ color: TEXT_DIM, flexShrink: 0 }}>{fmtRelative(card.recentAt)}</span>
        </div>
      ) : (
        <div
          style={{
            fontSize: 11,
            color: TEXT_DIM,
            paddingTop: 6,
            borderTop: `1px solid ${BORDER}`,
            fontStyle: "italic",
          }}
        >
          No activity in last 7d
        </div>
      )}
    </div>
  );
}

function Avatar({ name }: { name: string }) {
  // First two letters of the first two words, e.g. "CEO Orchestrator" → "CE OR"
  const parts = name.split(/[._\s/-]+/).filter(Boolean);
  const initials = (parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? parts[0]?.[1] ?? "");
  return (
    <div
      aria-hidden
      style={{
        width: 30,
        height: 30,
        borderRadius: 6,
        background: `linear-gradient(135deg, color-mix(in srgb, ${MINT} 25%, transparent), color-mix(in srgb, ${MINT} 8%, transparent))`,
        border: `1px solid color-mix(in srgb, ${MINT} 30%, transparent)`,
        color: MINT,
        fontSize: 11,
        fontWeight: 700,
        letterSpacing: "0.04em",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
        textTransform: "uppercase",
      }}
    >
      {initials.toUpperCase()}
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <span>
      <span style={{ color: TEXT_DIM, marginRight: 4 }}>{label}</span>
      <span style={{ color: color ?? TEXT, fontWeight: 600 }}>{value}</span>
    </span>
  );
}

function Pill({ color, label }: { color: string; label: string }) {
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 600,
        textTransform: "uppercase",
        letterSpacing: "0.04em",
        padding: "2px 7px",
        borderRadius: 4,
        background: `color-mix(in srgb, ${color} 16%, transparent)`,
        color,
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
}

function CountChip({ count, color, label }: { count: number; color: string; label: string }) {
  if (count === 0) return null;
  return (
    <span
      title={`${count} ${label}`}
      style={{
        fontSize: 10,
        fontWeight: 600,
        padding: "2px 7px",
        borderRadius: 8,
        background: `color-mix(in srgb, ${color} 16%, transparent)`,
        color,
        letterSpacing: "0.04em",
      }}
    >
      {count}
    </span>
  );
}

function FilterPill({ label, on, onClick }: { label: string; on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        fontSize: 11,
        fontWeight: 500,
        padding: "4px 10px",
        borderRadius: 6,
        background: on ? `color-mix(in srgb, ${MINT} 18%, transparent)` : "transparent",
        color: on ? MINT : TEXT_MUTED,
        border: `1px solid ${on ? `color-mix(in srgb, ${MINT} 40%, transparent)` : BORDER}`,
        cursor: "pointer",
        fontFamily: "inherit",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </button>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: "24px 18px",
        fontSize: 13,
        color: TEXT_MUTED,
        textAlign: "center",
        lineHeight: 1.5,
      }}
    >
      {children}
    </div>
  );
}

const linkStyle: React.CSSProperties = {
  background: "none",
  color: MINT,
  border: "none",
  cursor: "pointer",
  fontSize: 11,
  padding: 0,
  fontFamily: "inherit",
};
