/** Mission Control — Roadmap / workflows map.
 *
 *  Renders the big workflows ignition seeded as "[Roadmap] …" issues:
 *  one lane per workflow with owner, status, the KPIs it moves, and
 *  child-issue progress. This is the "what is the fleet actually
 *  building, and how far along is it" surface the operator monitors.
 */

import { useEffect } from "react";
import { type PluginWidgetProps, usePluginData } from "@wavex-os/plugin-sdk-shim/ui";

const ACCENT = "#4ec9b0";
const BORDER = "rgba(255,255,255,0.08)";
const TEXT = "#ffffff";
const TEXT_MUTED = "rgba(255,255,255,0.55)";
const SURFACE_ALT = "#0a0a18";

interface RoadmapLane {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  priority: string | null;
  owner: string | null;
  kpis: string[];
  children: { total: number; done: number; inProgress: number };
  updatedAt: string | null;
}

interface RoadmapResponse {
  ok: boolean;
  lanes: RoadmapLane[];
  source?: string;
  error?: string;
}

const STATUS_COLOR: Record<string, string> = {
  done: "#34d399",
  in_progress: ACCENT,
  in_review: "#a78bfa",
  todo: "#fbbf24",
  backlog: TEXT_MUTED,
  blocked: "#fb7185",
};

export function MissionControlRoadmapWidget({ context }: PluginWidgetProps) {
  const companyId = context.companyId ?? "";
  const { data, loading, error, refresh } = usePluginData<RoadmapResponse>(
    "mission-control-roadmap",
    { companyId },
  );
  useEffect(() => {
    if (!companyId) return;
    const h = setInterval(() => refresh(), 60_000);
    return () => clearInterval(h);
  }, [companyId, refresh]);

  if (loading && !data) {
    return <div style={{ padding: 24, color: TEXT_MUTED, fontSize: 13 }}>Loading roadmap…</div>;
  }
  if (error || (data && !data.ok)) {
    return (
      <div style={{ padding: 24, color: "#fb7185", fontSize: 13 }}>
        Roadmap unavailable{data?.error ? `: ${data.error}` : error ? `: ${String(error)}` : ""}.
      </div>
    );
  }
  const lanes = data?.lanes ?? [];
  if (lanes.length === 0) {
    return (
      <div style={{ padding: 24, color: TEXT_MUTED, fontSize: 13 }}>
        No roadmap workflows yet. Ignition seeds them as “[Roadmap] …” issues when the fleet
        activates; agents can add more by filing issues with that title prefix.
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: 8 }}>
      <div style={{ fontSize: 11, color: TEXT_MUTED, letterSpacing: "0.06em", textTransform: "uppercase" }}>
        Workflows map · {lanes.length} workflow{lanes.length === 1 ? "" : "s"} · child progress
        updates live
      </div>
      {lanes.map((lane) => {
        const pct =
          lane.children.total > 0 ? Math.round((lane.children.done / lane.children.total) * 100) : 0;
        const color = STATUS_COLOR[lane.status] ?? TEXT_MUTED;
        return (
          <div
            key={lane.id}
            style={{
              border: `1px solid ${BORDER}`,
              background: SURFACE_ALT,
              borderRadius: 10,
              padding: "12px 16px",
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
              <span style={{ fontSize: 14, fontWeight: 600, color: TEXT }}>{lane.title}</span>
              {lane.identifier ? (
                <span style={{ fontSize: 11, color: TEXT_MUTED }}>{lane.identifier}</span>
              ) : null}
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  letterSpacing: "0.05em",
                  textTransform: "uppercase",
                  color,
                  border: `1px solid color-mix(in srgb, ${color} 50%, transparent)`,
                  borderRadius: 999,
                  padding: "1px 8px",
                }}
              >
                {lane.status.replace(/_/g, " ")}
              </span>
              <span style={{ flex: 1 }} />
              {lane.owner ? (
                <span style={{ fontSize: 11, color: TEXT_MUTED }}>owner · {lane.owner}</span>
              ) : null}
            </div>

            {lane.kpis.length > 0 ? (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {lane.kpis.map((k) => (
                  <span
                    key={k}
                    style={{
                      fontSize: 10,
                      color: ACCENT,
                      background: "rgba(78,201,176,0.10)",
                      border: "1px solid rgba(78,201,176,0.3)",
                      borderRadius: 6,
                      padding: "2px 8px",
                    }}
                  >
                    {k}
                  </span>
                ))}
              </div>
            ) : null}

            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div
                style={{
                  flex: 1,
                  height: 6,
                  borderRadius: 3,
                  background: "rgba(255,255,255,0.10)",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    width: `${pct}%`,
                    height: "100%",
                    borderRadius: 3,
                    background: ACCENT,
                    transition: "width 300ms ease",
                  }}
                />
              </div>
              <span style={{ fontSize: 11, color: TEXT_MUTED, whiteSpace: "nowrap" }}>
                {lane.children.done}/{lane.children.total} done
                {lane.children.inProgress > 0 ? ` · ${lane.children.inProgress} active` : ""}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
