/**
 * WaveX plugin UI bundles.
 *
 * The 7 Mission Control widgets are re-exported from sibling files. The
 * sidebar Inception Status panel + a minimal Settings page (navigation
 * links only) ship inline below. The legacy Supabase-gated widgets
 * (ExpertAgents, Deliverables, FleetKpis, Throughput, AgentStatus) were
 * removed in plugin v0.4.0 — every surface they covered is now better
 * served by the Mission Control widgets, and their "Configure Supabase
 * URL" empty states were dead ends in dev installs.
 */
import { usePluginData } from "@wavex-os/plugin-sdk-shim/ui";
import type {
  PluginSidebarProps,
  PluginSettingsPageProps,
} from "@wavex-os/plugin-sdk-shim/ui";

// Mission Control v0.7.0 — single unified surface (hero KPIs + activity
// spine + context rail + ops footer). Replaces the prior 7 separate
// dashboardWidget exports; their files remain in the repo but are not
// bundled because nothing re-exports them.
export { MissionControlUnifiedWidget } from "./MissionControlUnifiedWidget.js";
// v0.8.0 — Connectors sidebar entry + Directory modal.
export { ConnectorsSidebarEntry } from "./ConnectorsSidebar.js";
// v0.9.0 — Full-page Mission Control mounted at the page slot.
export { MissionControlPage } from "./MissionControlPage.js";
// v0.9.1 — Sidebar entry that nav-links to the full-page MC route.
export { MissionControlSidebarEntry } from "./MissionControlSidebarEntry.js";
// Frontier F1 — Living Headline + Status Orb. Not a slot; mounted inside
// MissionControlPage and MissionControlUnifiedWidget at the top.
export { MissionControlHeadlineStrip } from "./MissionControlHeadline.js";
// Frontier F2 — Decision Queue. Mounted as the first subnav tab in
// MissionControlPage and as a compact section in the dashboard widget.
export { MissionControlDecisionQueue } from "./MissionControlDecisionQueue.js";
// Frontier F3 — Receipts side panel. Opened from Scoreboard rows
// + HeroKpiStrip cards. Renders the causal chain for a KPI.
export { ReceiptsPanel } from "./ReceiptsPanel.js";
// Frontier F4 — Chat-as-nav bar. Mounted at the bottom of MissionControlPage.
export { ChatNavBar } from "./ChatNavBar.js";
// Frontier F6 — Accountability Map. Replaces the topology Graph for the
// "Map" tab in MissionControlPage. Card grid, not topology.
export { AccountabilityMap } from "./AccountabilityMap.js";
// v0.9.0 Phase 3 — Deliverable Inspector (modal). Not a slot; opened
// from within the page when an event/deliverable is clicked. Exported
// so MissionControlPage can lazily mount it via a portal.
export { DeliverableInspector } from "./DeliverableInspector.js";

const WAVEX_COLOR = "#00d4ff";
const WAVEX_BG = "color-mix(in srgb, #00d4ff 6%, transparent)";

// ---------------------------------------------------------------------------
// Sidebar — current company's inception status
// ---------------------------------------------------------------------------

interface InceptionStatusResponse {
  agentsTotal: number;
  agentsReady: number;
  source: string;
}

export function InceptionStatusPanel({ context }: PluginSidebarProps) {
  const { data, loading } = usePluginData<InceptionStatusResponse>(
    "inception-status",
    { companyId: context.companyId },
  );

  return (
    <Card label="Inception Status">
      {loading ? (
        <div style={{ opacity: 0.6 }}>Checking fleet readiness…</div>
      ) : data ? (
        <>
          <div style={{ fontSize: 22, fontWeight: 600, color: WAVEX_COLOR }}>
            {data.agentsReady}
            <span style={{ fontSize: 14, opacity: 0.6 }}> / {data.agentsTotal} ready</span>
          </div>
          <div style={{ marginTop: 8, fontSize: 12, opacity: 0.7 }}>
            {data.agentsTotal === 0
              ? "Fleet not yet incepted. Finalize onboarding in WaveX Mission Control."
              : data.agentsReady === data.agentsTotal
                ? "Fleet is fully live. First cycle starts at next heartbeat tick."
                : `${data.agentsTotal - data.agentsReady} agents still spawning.`}
          </div>
        </>
      ) : (
        <div style={{ opacity: 0.6 }}>No fleet data for this company.</div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Settings page — navigation only (no Supabase-gated subscription card)
// ---------------------------------------------------------------------------

export function WaveXSettingsPage(_: PluginSettingsPageProps) {
  return (
    <div style={{ padding: 16, display: "grid", gap: 12 }}>
      <h2 style={{ margin: 0, color: WAVEX_COLOR }}>WaveX OS — preferences</h2>
      <p style={{ fontSize: 13, opacity: 0.7, margin: 0 }}>
        WaveX widgets read from the wavex-os op-omega-server (localhost in dev).
        All actions still happen via Paperclip's native issue + agent flows.
      </p>

      <Card label="Where to go next">
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.7 }}>
          <li>
            <a href="http://localhost:5173/mission" style={{ color: WAVEX_COLOR }}>
              WaveX Mission Control
            </a>{" "}
            — KPI scoreboard, fleet graph, inception CTA.
          </li>
          <li>
            <a href="http://localhost:5173/pricing" style={{ color: WAVEX_COLOR }}>
              Expert Agent marketplace
            </a>{" "}
            — hire new catalog agents.
          </li>
        </ul>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tiny in-bundle UI primitives (avoid a full design system dep — keeps the
// bundle small and matches Paperclip's neutral host theme via CSS variables).
// ---------------------------------------------------------------------------

function Card({ label, children }: { label: string; children: React.ReactNode }) {
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
