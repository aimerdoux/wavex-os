/** Mission Control — Decision Queue (Frontier F2).
 *
 *  Ranked, actionable list of items that need the operator's attention.
 *  Replaces "go fishing for what's stuck" with a single inbox-like view.
 *
 *  Two render modes:
 *    - mode="compact" : top 3 items, used in the dashboard widget
 *    - mode="full"    : full list, used as the first subnav tab in the
 *                       full-page MC
 *
 *  Inline actions route through the existing worker action handlers
 *  (mission-control-deliverable-review for approve/reject; others are
 *  stubbed as "Open" links until their respective surfaces land).
 */

import { useEffect, useMemo, useState } from "react";
import {
  usePluginAction,
  usePluginData,
  type PluginWidgetProps,
} from "@wavex-os/plugin-sdk-shim/ui";

// ─── Tokens ─────────────────────────────────────────────────────────
const MINT = "#4ec9b0";
const URGENT = "#ff6b6b";
const HIGH = "#ff9a3c";
const WARN = "#ffd166";
const LOW = "#8a8f98";
const TEXT = "rgba(255,255,255,0.92)";
const TEXT_MUTED = "rgba(255,255,255,0.62)";
const TEXT_DIM = "rgba(255,255,255,0.45)";
const SURFACE = "rgba(255,255,255,0.025)";
const BORDER = "rgba(255,255,255,0.07)";

type Severity = "critical" | "high" | "medium" | "low";
type Kind = "deliverable_review" | "orphan_task" | "runway_alert" | "stale_kpi" | "starter";

interface DecisionAction {
  id: string;
  label: string;
  variant: "primary" | "secondary" | "danger";
}
interface DecisionItem {
  id: string;
  kind: Kind;
  title: string;
  detail: string;
  severity: Severity;
  score: number;
  ageHours: number;
  actions: DecisionAction[];
  link?: string;
  meta?: Record<string, unknown>;
}
interface QueueResponse {
  ok: boolean;
  items?: DecisionItem[];
  total?: number;
  counts?: Record<Severity, number>;
  generatedAt?: string;
}

const SEV_COLOR: Record<Severity, string> = {
  critical: URGENT,
  high: HIGH,
  medium: WARN,
  low: LOW,
};

const KIND_GLYPH: Record<Kind, string> = {
  deliverable_review: "📝",
  orphan_task: "🧷",
  runway_alert: "⏳",
  stale_kpi: "📉",
  starter: "✨",
};

interface CompactProps {
  context: PluginWidgetProps["context"];
  mode?: "compact" | "full";
}

export function MissionControlDecisionQueue({
  context,
  mode = "full",
}: CompactProps) {
  const companyId = context.companyId ?? "";
  const { data, loading, error, refresh } = usePluginData<QueueResponse>(
    "mission-control-decision-queue",
    { companyId },
  );
  const reviewAction = usePluginAction("mission-control-deliverable-review");

  // Self-poll. Compact mode polls slower (it's an ambient widget) than
  // full mode (which is the operator's active surface).
  useEffect(() => {
    if (!companyId) return;
    const interval = mode === "full" ? 15_000 : 45_000;
    const h = setInterval(() => refresh(), interval);
    return () => clearInterval(h);
  }, [companyId, refresh, mode]);

  // Optimistic dismissal (front-end only — the next poll fetches fresh state).
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const items = useMemo(() => {
    const all = data?.items ?? [];
    const filtered = all.filter((it) => !dismissed.has(it.id));
    return mode === "compact" ? filtered.slice(0, 3) : filtered;
  }, [data, dismissed, mode]);

  const counts = data?.counts ?? { critical: 0, high: 0, medium: 0, low: 0 };
  const visibleCount = items.length;

  const handleAction = async (item: DecisionItem, action: DecisionAction) => {
    // Approve / reject route to the existing deliverable-review handler.
    if (item.kind === "deliverable_review" && (action.id === "approve" || action.id === "reject")) {
      const deliverableId = (item.meta?.deliverableId as string) ?? "";
      if (!deliverableId) return;
      try {
        await reviewAction({
          deliverableId,
          decision: action.id === "approve" ? "approve" : "reject",
        });
        // Optimistic remove + reload.
        setDismissed((s) => new Set(s).add(item.id));
        refresh();
      } catch {
        // No-op; next poll surfaces the real state.
      }
      return;
    }
    if (action.id === "dismiss" || action.id === "archive") {
      setDismissed((s) => new Set(s).add(item.id));
      return;
    }
    if (item.link && action.id !== "discuss") {
      // Open the deep link (uses the same routePath as the rest of MC).
      const url = item.link.startsWith("?")
        ? `${window.location.pathname}${item.link}`
        : item.link;
      window.history.pushState({}, "", url);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }
  };

  if (!companyId) {
    return mode === "compact" ? null : (
      <Empty>Select a company to load the decision queue.</Empty>
    );
  }
  if (loading && !data) {
    return mode === "compact" ? null : (
      <Empty>Loading decisions…</Empty>
    );
  }
  if (error) {
    return (
      <Empty>
        Could not load decisions: {error.message}{" "}
        <button onClick={refresh} style={linkStyle}>retry</button>
      </Empty>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      {/* Header — only in full mode (compact gets its own card label) */}
      {mode === "full" ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "12px 18px",
            borderBottom: `1px solid ${BORDER}`,
          }}
        >
          <strong style={{ fontSize: 13, color: TEXT, letterSpacing: "0.02em" }}>
            Decisions
          </strong>
          <span style={{ fontSize: 12, color: TEXT_MUTED }}>
            {visibleCount} pending
          </span>
          <CountChip count={counts.critical} color={URGENT} label="critical" />
          <CountChip count={counts.high} color={HIGH} label="high" />
          <CountChip count={counts.medium} color={WARN} label="medium" />
          <button
            type="button"
            onClick={() => { setDismissed(new Set()); refresh(); }}
            style={{ ...linkStyle, marginLeft: "auto" }}
          >
            refresh
          </button>
        </div>
      ) : null}

      {items.length === 0 ? (
        <Empty>
          {mode === "compact"
            ? "No decisions waiting."
            : "All clear — nothing waiting on you right now."}
        </Empty>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: mode === "full" ? "8px 12px 12px" : 0 }}>
          {items.map((item) => (
            <DecisionRow
              key={item.id}
              item={item}
              onAction={(a) => handleAction(item, a)}
            />
          ))}
        </div>
      )}
    </div>
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

function DecisionRow({
  item,
  onAction,
}: {
  item: DecisionItem;
  onAction: (a: DecisionAction) => void;
}) {
  const color = SEV_COLOR[item.severity];
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "4px auto 1fr auto",
        gap: 12,
        alignItems: "start",
        padding: "12px 14px",
        background: SURFACE,
        border: `1px solid ${BORDER}`,
        borderRadius: 8,
      }}
    >
      {/* Severity stripe */}
      <div
        aria-hidden
        style={{
          alignSelf: "stretch",
          width: 4,
          borderRadius: 2,
          background: color,
        }}
      />
      {/* Kind glyph */}
      <div
        aria-hidden
        style={{
          fontSize: 18,
          lineHeight: 1.1,
          width: 24,
          textAlign: "center",
          opacity: 0.85,
        }}
      >
        {KIND_GLYPH[item.kind]}
      </div>
      {/* Body */}
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: TEXT,
            lineHeight: 1.35,
          }}
        >
          {item.title}
        </div>
        <div
          style={{
            marginTop: 4,
            fontSize: 12,
            color: TEXT_MUTED,
            lineHeight: 1.45,
          }}
        >
          {item.detail}
        </div>
        <div
          style={{
            marginTop: 4,
            fontSize: 10,
            color: TEXT_DIM,
            display: "flex",
            gap: 6,
            alignItems: "center",
          }}
        >
          <span style={{ color, textTransform: "uppercase", letterSpacing: "0.06em", fontWeight: 600 }}>
            {item.severity}
          </span>
          <span aria-hidden>·</span>
          <span>{item.ageHours > 0 ? `${item.ageHours}h old` : "now"}</span>
        </div>
      </div>
      {/* Actions */}
      <div
        style={{
          display: "flex",
          gap: 6,
          flexShrink: 0,
          alignItems: "center",
        }}
      >
        {item.actions.map((a) => (
          <ActionButton key={a.id} action={a} onClick={() => onAction(a)} />
        ))}
      </div>
    </div>
  );
}

function ActionButton({ action, onClick }: { action: DecisionAction; onClick: () => void }) {
  const color =
    action.variant === "primary"
      ? MINT
      : action.variant === "danger"
        ? URGENT
        : TEXT_MUTED;
  const isPrimary = action.variant === "primary";
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: "5px 10px",
        fontSize: 11,
        fontWeight: 500,
        background: isPrimary ? `color-mix(in srgb, ${color} 18%, transparent)` : "transparent",
        color,
        border: `1px solid color-mix(in srgb, ${color} 40%, transparent)`,
        borderRadius: 6,
        cursor: "pointer",
        fontFamily: "inherit",
        whiteSpace: "nowrap",
      }}
    >
      {action.label}
    </button>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: "20px 18px",
        fontSize: 13,
        color: TEXT_MUTED,
        textAlign: "center",
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
