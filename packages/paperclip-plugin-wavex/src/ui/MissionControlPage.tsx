/** Mission Control — full-page surface (v2 Phase 2).
 *
 *  Mounts at /<company>/plugins/wavex-os.paperclip-plugin via the
 *  Paperclip `page` slot. Composes the existing widget bodies under
 *  one persistent shell (subnav + KPI strip + ops footer constant
 *  across views). Each sub-view reuses the data hooks the dashboard
 *  widget already pulls — no new endpoints, no logic rewrite.
 *
 *  Layout:
 *    ┌─────────────────────────────────────────────────────┐
 *    │ MISSION CONTROL · <company>           [refresh] [×] │
 *    │ Subnav: Stream · Scoreboard · Graph · Chief ·       │
 *    │         Impact · Operations                         │
 *    ├─────────────────────────────────────────────────────┤
 *    │ Hero KPI strip (always visible)                     │
 *    ├─────────────────────────────────────────────────────┤
 *    │ <active sub-view>                                   │
 *    ├─────────────────────────────────────────────────────┤
 *    │ Ops footer (always visible)                         │
 *    └─────────────────────────────────────────────────────┘
 */

import { useEffect, useMemo, useState } from "react";
import {
  type PluginPageProps,
  type PluginWidgetProps,
  usePluginData,
} from "@wavex-os/plugin-sdk-shim/ui";

import { MissionControlStreamWidget } from "./MissionControlStreamWidget.js";
import { MissionControlScoreboardWidget } from "./MissionControlScoreboardWidget.js";
import { AccountabilityMap } from "./AccountabilityMap.js";
import { MissionControlChiefWidget } from "./MissionControlChiefWidget.js";
import { MissionControlImpactGraphWidget } from "./MissionControlImpactGraphWidget.js";
import { MissionControlPolishWidget } from "./MissionControlPolishWidget.js";
import { MissionControlHeadlineStrip } from "./MissionControlHeadline.js";
import { MissionControlDecisionQueue } from "./MissionControlDecisionQueue.js";
import { ChatNavBar } from "./ChatNavBar.js";

const ACCENT = "#4ec9b0";
const SURFACE = "#020617";
const SURFACE_ALT = "#0a0a18";
const BORDER = "rgba(255,255,255,0.08)";
const TEXT = "#ffffff";
const TEXT_MUTED = "rgba(255,255,255,0.55)";

type View = "decisions" | "stream" | "scoreboard" | "graph" | "chief" | "impact" | "ops";

interface Tab {
  id: View;
  label: string;
  hint: string;
}

const TABS: Tab[] = [
  { id: "decisions", label: "Decisions", hint: "what needs you" },
  { id: "stream", label: "Stream", hint: "live activity feed" },
  { id: "scoreboard", label: "Scoreboard", hint: "KPI attainment" },
  { id: "graph", label: "Map", hint: "who owns what" },
  { id: "impact", label: "Impact", hint: "task → KPI chain" },
  { id: "chief", label: "Chief", hint: "rules + originations" },
  { id: "ops", label: "Operations", hint: "cost · capacity · burn" },
];

export function MissionControlPage({ context }: PluginPageProps) {
  const companyId = context.companyId ?? "";
  // Read initial view from URL hash if present (e.g. ?view=scoreboard).
  // Lets the dashboard widget deep-link into a specific surface.
  const initialView = useMemo<View>(() => {
    if (typeof window === "undefined") return "stream";
    const params = new URLSearchParams(window.location.search);
    const v = (params.get("view") ?? "").toLowerCase();
    if (TABS.some((t) => t.id === v)) return v as View;
    return "decisions";
  }, []);
  const [view, setView] = useState<View>(initialView);

  // F5 — tab badges. Polls every 30s. Empty object when company is blank.
  const counts = usePluginData<{
    ok: boolean;
    decisions?: number;
    scoreboard?: number;
    impact?: number;
    chief?: number;
    ops?: number;
  }>("mission-control-tab-counts", { companyId });
  useEffect(() => {
    if (!companyId) return;
    const h = setInterval(() => counts.refresh(), 30_000);
    return () => clearInterval(h);
  }, [companyId, counts]);
  const countByTab: Record<View, number> = {
    decisions: counts.data?.decisions ?? 0,
    stream: 0,
    scoreboard: counts.data?.scoreboard ?? 0,
    graph: 0,
    impact: counts.data?.impact ?? 0,
    chief: counts.data?.chief ?? 0,
    ops: counts.data?.ops ?? 0,
  };

  if (!companyId) {
    return (
      <div style={{ padding: 40, color: TEXT_MUTED, fontSize: 14 }}>
        Select a company to open Mission Control.
      </div>
    );
  }

  // The widgets accept PluginWidgetProps which has the same shape as
  // PluginPageProps (both expose context.companyId). We just pass our
  // context through.
  const widgetProps: PluginWidgetProps = { context };

  return (
    <div
      style={{
        background: SURFACE,
        color: TEXT,
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Eyebrow */}
      <div
        style={{
          padding: "14px 28px 0",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <span
          style={{
            fontSize: 10,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: ACCENT,
            fontWeight: 600,
          }}
        >
          Mission Control
        </span>
        <span style={{ fontSize: 11, color: TEXT_MUTED }}>· {companyId}</span>
      </div>

      {/* Frontier F1 — Headline + Status Orb */}
      <MissionControlHeadlineStrip context={context} />

      {/* Subnav */}
      <nav
        role="tablist"
        aria-label="Mission Control views"
        style={{
          display: "flex",
          gap: 4,
          padding: "10px 22px",
          borderBottom: `1px solid ${BORDER}`,
          background: SURFACE_ALT,
          overflowX: "auto",
        }}
      >
        {TABS.map((t) => {
          const on = view === t.id;
          const badge = countByTab[t.id];
          return (
            <button
              key={t.id}
              role="tab"
              aria-selected={on}
              onClick={() => setView(t.id)}
              title={t.hint}
              style={{
                padding: "8px 14px",
                borderRadius: 6,
                border: "none",
                background: on
                  ? `color-mix(in srgb, ${ACCENT} 16%, transparent)`
                  : "transparent",
                color: on ? ACCENT : TEXT_MUTED,
                fontSize: 13,
                fontWeight: on ? 600 : 500,
                cursor: "pointer",
                whiteSpace: "nowrap",
                fontFamily: "inherit",
                transition: "background 120ms ease, color 120ms ease",
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              {t.label}
              {badge > 0 ? (
                <span
                  aria-label={`${badge} item${badge === 1 ? "" : "s"}`}
                  style={{
                    fontSize: 10,
                    fontWeight: 600,
                    padding: "1px 6px",
                    borderRadius: 8,
                    background: on
                      ? `color-mix(in srgb, ${ACCENT} 28%, transparent)`
                      : "rgba(255, 154, 60, 0.18)",
                    color: on ? ACCENT : "#ff9a3c",
                    letterSpacing: "0.04em",
                    lineHeight: 1.2,
                  }}
                >
                  {badge > 99 ? "99+" : badge}
                </span>
              ) : null}
            </button>
          );
        })}
      </nav>

      {/* Active sub-view */}
      <div style={{ flex: 1, padding: 16, overflow: "auto" }}>
        {view === "decisions" ? (
          <MissionControlDecisionQueue context={context} mode="full" />
        ) : view === "stream" ? (
          <MissionControlStreamWidget {...widgetProps} />
        ) : view === "scoreboard" ? (
          <MissionControlScoreboardWidget {...widgetProps} />
        ) : view === "graph" ? (
          <AccountabilityMap {...widgetProps} />
        ) : view === "impact" ? (
          <MissionControlImpactGraphWidget {...widgetProps} />
        ) : view === "chief" ? (
          <MissionControlChiefWidget {...widgetProps} />
        ) : (
          <MissionControlPolishWidget {...widgetProps} />
        )}
      </div>

      {/* Frontier F4 — Chat-as-nav. Sticks to the bottom of the page. */}
      <ChatNavBar
        context={context}
        onJumpToDecisions={() => setView("decisions")}
      />
    </div>
  );
}
