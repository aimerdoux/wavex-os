/** Mission Control — Living Headline + Status Orb (Frontier F1).
 *
 *  Two paired components rendered at the top of every MC surface:
 *
 *    - <MissionControlHeadline> — display-typography one-liner + 2-3
 *      sentence narrative. Sentiment drives accent color.
 *    - <MissionControlStatusOrb> — pulsing colored orb; click to expand
 *      a popover with the reasons it's that color + deep-links.
 *
 *  Both poll on a slow cadence (orb every 30s, headline every 5min) so
 *  the operator sees fresh state without manually refreshing.
 */

import { useEffect, useRef, useState } from "react";
import { usePluginData, type PluginWidgetProps } from "@wavex-os/plugin-sdk-shim/ui";

// ─── Shared color tokens (match the WaveX OS mint palette) ──────────
const MINT = "#4ec9b0";
const URGENT_RED = "#ff6b6b";
const WARN_AMBER = "#ffd166";
const GOOD_GREEN = "#4ade80";
const ACTIVE_BLUE = "#00d4ff";
const NEUTRAL = "#8a8f98";

const TEXT = "rgba(255,255,255,0.92)";
const TEXT_MUTED = "rgba(255,255,255,0.62)";
const TEXT_DIM = "rgba(255,255,255,0.45)";
const SURFACE = "rgba(255,255,255,0.04)";
const BORDER = "rgba(255,255,255,0.08)";

type Sentiment = "good" | "mixed" | "urgent" | "neutral";
type OrbStatus = "calm" | "watching" | "action" | "active";

interface HeadlineResponse {
  ok: boolean;
  headline?: string;
  narrative?: string;
  sentiment?: Sentiment;
  generatedAt?: string;
  cached?: boolean;
  source?: "llm" | "fallback";
}
interface OrbReason {
  label: string;
  detail: string;
  severity: "info" | "warn" | "critical";
  link?: string;
}
interface OrbResponse {
  ok: boolean;
  status?: OrbStatus;
  reasons?: OrbReason[];
  generatedAt?: string;
  signalAgeMs?: number;
}

const SENTIMENT_ACCENT: Record<Sentiment, string> = {
  good: GOOD_GREEN,
  mixed: WARN_AMBER,
  urgent: URGENT_RED,
  neutral: NEUTRAL,
};

const ORB_COLOR: Record<OrbStatus, string> = {
  calm: GOOD_GREEN,
  active: ACTIVE_BLUE,
  watching: WARN_AMBER,
  action: URGENT_RED,
};

const ORB_LABEL: Record<OrbStatus, string> = {
  calm: "All clear",
  active: "Agents working",
  watching: "Watch",
  action: "Action needed",
};

// ─── The combined surface (export both as a unit) ───────────────────

export function MissionControlHeadlineStrip({ context }: PluginWidgetProps) {
  const companyId = context.companyId ?? "";
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr auto",
        gap: 16,
        alignItems: "center",
        padding: "20px 28px 16px",
        borderBottom: `1px solid ${BORDER}`,
      }}
    >
      <MissionControlHeadline companyId={companyId} />
      <MissionControlStatusOrb companyId={companyId} />
    </div>
  );
}

// ─── Headline ───────────────────────────────────────────────────────

function MissionControlHeadline({ companyId }: { companyId: string }) {
  const { data, loading, refresh } = usePluginData<HeadlineResponse>(
    "mission-control-headline",
    { companyId },
  );

  // Self-poll every 5 minutes to keep the narrative fresh.
  useEffect(() => {
    if (!companyId) return;
    const handle = setInterval(() => refresh(), 5 * 60_000);
    return () => clearInterval(handle);
  }, [companyId, refresh]);

  if (!companyId) {
    return (
      <div style={{ color: TEXT_MUTED, fontSize: 14 }}>
        Select a company to see the headline.
      </div>
    );
  }

  if (loading && !data) {
    return (
      <div style={{ color: TEXT_DIM, fontSize: 14 }}>
        Reading mission control state…
      </div>
    );
  }

  const headline = data?.headline ?? "Mission Control is starting up.";
  const narrative = data?.narrative ?? "";
  const sentiment: Sentiment = data?.sentiment ?? "neutral";
  const accent = SENTIMENT_ACCENT[sentiment];

  return (
    <div style={{ minWidth: 0 }}>
      <div
        style={{
          fontSize: 22,
          fontWeight: 600,
          lineHeight: 1.25,
          letterSpacing: "-0.01em",
          color: TEXT,
          fontFamily:
            "'Inter Display', 'Inter', ui-sans-serif, system-ui, -apple-system, sans-serif",
        }}
      >
        <span
          aria-hidden
          style={{
            display: "inline-block",
            width: 8,
            height: 8,
            borderRadius: 4,
            background: accent,
            marginRight: 10,
            verticalAlign: "middle",
          }}
        />
        {headline}
      </div>
      {narrative ? (
        <div
          style={{
            marginTop: 8,
            fontSize: 13,
            lineHeight: 1.55,
            color: TEXT_MUTED,
            maxWidth: 780,
          }}
        >
          {narrative}
        </div>
      ) : null}
      <div
        style={{
          marginTop: 8,
          fontSize: 11,
          color: TEXT_DIM,
          display: "flex",
          gap: 8,
          alignItems: "center",
        }}
      >
        {data?.source === "fallback" ? (
          <span title="Generated from rules; LLM not available">templated</span>
        ) : data?.cached ? (
          <span title="Cached for 5 min">cached</span>
        ) : (
          <span>live</span>
        )}
        <button
          type="button"
          onClick={() => refresh()}
          style={{
            background: "none",
            color: MINT,
            border: "none",
            cursor: "pointer",
            fontSize: 11,
            padding: 0,
          }}
          aria-label="Refresh headline"
        >
          refresh
        </button>
      </div>
    </div>
  );
}

// ─── Status Orb ─────────────────────────────────────────────────────

function MissionControlStatusOrb({ companyId }: { companyId: string }) {
  const { data, refresh } = usePluginData<OrbResponse>(
    "mission-control-health-orb",
    { companyId },
  );
  const [open, setOpen] = useState(false);
  const popRef = useRef<HTMLDivElement | null>(null);

  // Poll every 30s — pure computation, cheap.
  useEffect(() => {
    if (!companyId) return;
    const handle = setInterval(() => refresh(), 30_000);
    return () => clearInterval(handle);
  }, [companyId, refresh]);

  // Close popover on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!popRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  if (!companyId) return null;

  const status: OrbStatus = data?.status ?? "calm";
  const color = ORB_COLOR[status];
  const label = ORB_LABEL[status];
  const reasons = data?.reasons ?? [];
  const pulse = status === "active" ? "0.8s" : status === "action" ? "1.8s" : "3s";

  return (
    <div style={{ position: "relative" }} ref={popRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={`Company health: ${label}${reasons.length > 0 ? ` (${reasons.length} reason${reasons.length === 1 ? "" : "s"})` : ""}`}
        aria-expanded={open}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "8px 14px 8px 10px",
          background: open ? SURFACE : "transparent",
          border: `1px solid ${open ? color : BORDER}`,
          borderRadius: 999,
          color: TEXT,
          cursor: "pointer",
          fontSize: 12,
          fontFamily: "inherit",
        }}
      >
        <span
          aria-hidden
          style={{
            width: 14,
            height: 14,
            borderRadius: 7,
            background: color,
            boxShadow: `0 0 14px ${color}66`,
            animation: `mc-orb-pulse ${pulse} ease-in-out infinite`,
          }}
        />
        <span style={{ fontWeight: 500, letterSpacing: "0.02em" }}>{label}</span>
        {reasons.length > 0 ? (
          <span
            style={{
              fontSize: 10,
              padding: "1px 6px",
              borderRadius: 8,
              background: `color-mix(in srgb, ${color} 18%, transparent)`,
              color,
              fontWeight: 600,
            }}
          >
            {reasons.length}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="Company health details"
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            right: 0,
            width: 340,
            maxHeight: 480,
            overflowY: "auto",
            background: "#0f1419",
            border: `1px solid ${color}55`,
            borderRadius: 12,
            boxShadow: "0 16px 40px rgba(0,0,0,0.45)",
            padding: 14,
            zIndex: 50,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginBottom: 10,
            }}
          >
            <span
              aria-hidden
              style={{
                width: 12,
                height: 12,
                borderRadius: 6,
                background: color,
                boxShadow: `0 0 12px ${color}88`,
              }}
            />
            <strong style={{ fontSize: 13, color: TEXT }}>{label}</strong>
            <span style={{ marginLeft: "auto", fontSize: 10, color: TEXT_DIM }}>
              {data?.generatedAt ? new Date(data.generatedAt).toLocaleTimeString() : ""}
            </span>
          </div>

          {reasons.length === 0 ? (
            <div
              style={{
                padding: "16px 8px",
                fontSize: 13,
                color: TEXT_MUTED,
                textAlign: "center",
              }}
            >
              No issues detected. Everything looks healthy.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {reasons.map((r, i) => (
                <ReasonRow key={i} reason={r} />
              ))}
            </div>
          )}
        </div>
      ) : null}
      <style>{`@keyframes mc-orb-pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.65; transform: scale(0.9); } }`}</style>
    </div>
  );
}

function ReasonRow({ reason }: { reason: OrbReason }) {
  const sevColor =
    reason.severity === "critical"
      ? URGENT_RED
      : reason.severity === "warn"
        ? WARN_AMBER
        : MINT;
  return (
    <div
      style={{
        padding: "10px 12px",
        background: `color-mix(in srgb, ${sevColor} 6%, transparent)`,
        border: `1px solid color-mix(in srgb, ${sevColor} 30%, transparent)`,
        borderRadius: 8,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 4,
        }}
      >
        <span
          aria-hidden
          style={{
            width: 6,
            height: 6,
            borderRadius: 3,
            background: sevColor,
          }}
        />
        <span style={{ fontSize: 12, fontWeight: 600, color: TEXT }}>
          {reason.label}
        </span>
      </div>
      <div style={{ fontSize: 12, color: TEXT_MUTED, lineHeight: 1.45 }}>
        {reason.detail}
      </div>
      {reason.link ? (
        <a
          href={reason.link}
          style={{
            display: "inline-block",
            marginTop: 6,
            fontSize: 11,
            color: sevColor,
            textDecoration: "none",
          }}
        >
          Open →
        </a>
      ) : null}
    </div>
  );
}
