/**
 * WaveX plugin manifest.
 *
 * Customizes Paperclip without forking the codebase. Declares 7 Mission
 * Control dashboard widgets + 1 sidebar (Inception Status) + 1 settings
 * page. Subtree updates of Paperclip core stay clean because all WaveX
 * behavior lives in this separate package.
 *
 * v0.4.0: dropped the 5 legacy Supabase-gated dashboard widgets
 * (ExpertAgents / Deliverables / FleetKpis / Throughput / AgentStatus).
 * Every surface they covered is better served by the Mission Control
 * widgets, and their "Configure Supabase URL" empty states were dead
 * ends in dev installs.
 *
 * @see docs/PAPERCLIP_PLUGIN_WAVEX.md
 * @see PLUGIN_SPEC.md §10.1 — Manifest Shape
 */
import type { PaperclipPluginManifestV1 } from "@wavex-os/plugin-sdk-shim";

const PLUGIN_ID = "wavex-os.paperclip-plugin";
const PLUGIN_VERSION = "0.15.0";

// Slot IDs are referenced from the host's UI registry. Keep them stable
// (operator's saved-layout state references them by id).
const INCEPTION_STATUS_SLOT = "wavex-inception-status";
const CONNECTORS_SIDEBAR_SLOT = "wavex-connectors";
const WAVEX_SETTINGS_SLOT = "wavex-preferences";
// v0.7.0: collapsed the 7 prior Mission Control widgets (Stream,
// Scoreboard, Causal Impact, Deliverables, Node Profile, Graph, Chief,
// Operations) into one unified surface. The internal layouts still
// reuse all the same wavex MC endpoints — only the slot composition
// changed. Standalone widget files remain in the repo as dead code in
// case we ever need to re-register them, but they're no longer exported.
const MC_UNIFIED_SLOT = "wavex-mission-control";
const MC_PAGE_SLOT = "wavex-mission-control-page";
const MC_SIDEBAR_SLOT = "wavex-mission-control-sidebar";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "WaveX OS",
  description:
    "Mission Control widgets + Inception sidebar for Paperclip. Read-only — never modifies issues, comments, or agent state directly. All actions still flow through Paperclip's native commands.",
  author: "WaveX OS",
  categories: ["ui"],
  capabilities: [
    "ui.dashboardWidget.register",
    "ui.sidebar.register",
    "ui.page.register",
    "instance.settings.register",
    // The worker reads from the wavex-os op-omega-server on localhost.
    "http.outbound",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  ui: {
    slots: [
      // The single unified Mission Control surface (v0.7.0). Composes
      // hero KPIs + activity spine + context rail + ops footer into one
      // decision-making surface. Replaces the prior 7 separate widgets.
      {
        type: "dashboardWidget",
        id: MC_UNIFIED_SLOT,
        displayName: "Mission Control",
        exportName: "MissionControlUnifiedWidget",
      },
      // v0.9.0 — full-page Mission Control mounted at
      // /<company>/plugins/wavex-os.paperclip-plugin. Same data flow as
      // the dashboard widget but as a dedicated route with subnav
      // across all 6 views (Stream / Scoreboard / Graph / Impact /
      // Chief / Operations).
      {
        type: "page",
        id: MC_PAGE_SLOT,
        displayName: "Mission Control",
        exportName: "MissionControlPage",
        // Mounts at /<companyPrefix>/mission-control via Paperclip's
        // `:pluginRoutePath` catch-all route. Also reachable via the
        // generic /<companyPrefix>/plugins/<pluginId>.
        routePath: "mission-control",
      },
      // v0.9.1 — Mission Control sidebar entry. Renders a nav link at the
      // top of the sidebar so the full-page MC route is one click away.
      {
        type: "sidebar",
        id: MC_SIDEBAR_SLOT,
        displayName: "Mission Control",
        exportName: "MissionControlSidebarEntry",
      },
      {
        type: "sidebar",
        id: INCEPTION_STATUS_SLOT,
        displayName: "Inception Status",
        exportName: "InceptionStatusPanel",
      },
      // v0.8.0 — Connectors directory entry. Renders a button in the
      // main sidebar nav; click opens a portaled modal with the live
      // Composio catalog + OAuth-driven connect/disconnect.
      {
        type: "sidebar",
        id: CONNECTORS_SIDEBAR_SLOT,
        displayName: "Connectors",
        exportName: "ConnectorsSidebarEntry",
      },
      {
        type: "settingsPage",
        id: WAVEX_SETTINGS_SLOT,
        displayName: "WaveX Preferences",
        exportName: "WaveXSettingsPage",
      },
    ],
  },
  // Plugin-instance configuration the operator can set at install time.
  instanceConfigSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      wavexApiBase: {
        type: "string",
        format: "uri",
        title: "WaveX op-omega-server base URL",
        description:
          "Where the plugin reads Mission Control + inception data. Defaults to the local mock-core endpoint.",
        default: "http://127.0.0.1:3101",
      },
    },
  },
};

export default manifest;
