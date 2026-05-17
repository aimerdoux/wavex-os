/**
 * WaveX plugin manifest.
 *
 * Customizes Paperclip without forking the codebase. Declares three v1 UI
 * slots and the data handlers the worker registers. Subtree updates of
 * Paperclip core stay clean because all WaveX behavior lives in this
 * separate package.
 *
 * @see docs/PAPERCLIP_PLUGIN_WAVEX.md
 * @see PLUGIN_SPEC.md §10.1 — Manifest Shape
 */
import type { PaperclipPluginManifestV1 } from "@wavex-os/plugin-sdk-shim";

const PLUGIN_ID = "wavex-os.paperclip-plugin";
const PLUGIN_VERSION = "0.1.0";

// Slot IDs are referenced from the host's UI registry. Keep them stable
// (operator's saved-layout state references them by id).
const EXPERT_AGENTS_SLOT = "wavex-expert-agents-status";
const INCEPTION_STATUS_SLOT = "wavex-inception-status";
const WAVEX_SETTINGS_SLOT = "wavex-preferences";
const DELIVERABLES_SLOT = "wavex-deliverables";
// Mission Control visual dashboard widgets (read-only, inline-SVG charts).
const FLEET_KPIS_SLOT = "wavex-fleet-kpis";
const DELIVERABLES_THROUGHPUT_SLOT = "wavex-deliverables-throughput";
const AGENT_STATUS_SLOT = "wavex-agent-status";
// Mission Control Phase 1 — live plain-language activity stream.
const MC_STREAM_SLOT = "wavex-mission-control-stream";
// Mission Control Phase 2 — Deliverables ledger with kind-aware inspector.
const MC_DELIVERABLES_SLOT = "wavex-mission-control-deliverables";
// Mission Control Phase 3 — KPI scoreboard (attainment per KPI).
const MC_SCOREBOARD_SLOT = "wavex-mission-control-scoreboard";
// Mission Control Phase 4 — Node profile + assignment chain inspector.
const MC_NODE_PROFILE_SLOT = "wavex-mission-control-node-profile";
// Mission Control Phase 5 — Accountability Graph (force-directed SVG).
const MC_GRAPH_SLOT = "wavex-mission-control-graph";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "WaveX OS",
  description:
    "WaveX-branded panels for Paperclip: Expert Agents status, Inception health, and WaveX-specific preferences. Read-only — never modifies issues, comments, or agent state.",
  author: "WaveX OS",
  categories: ["ui"],
  capabilities: [
    "ui.dashboardWidget.register",
    "ui.sidebar.register",
    "ui.page.register",
    // The worker reads from the wavex-os op-omega-server + (optionally) the
    // Supabase REST endpoint. No outbound HTTP to third parties — only
    // localhost and the configured operator infra.
    "http.outbound",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  ui: {
    slots: [
      // Phase 1.4 — the wedge. Lands first so it sits at the top of the
      // dashboard widget column where it has the most demo visibility.
      {
        type: "dashboardWidget",
        id: MC_STREAM_SLOT,
        displayName: "Mission Control — Activity Stream",
        exportName: "MissionControlStreamWidget",
      },
      // Phase 2 — Deliverables ledger; directly below the Stream so the
      // operator can pivot from "what just happened" to "what was made".
      {
        type: "dashboardWidget",
        id: MC_DELIVERABLES_SLOT,
        displayName: "Mission Control — Deliverables",
        exportName: "MissionControlDeliverablesWidget",
      },
      // Phase 3 — KPI scoreboard: attainment ratio per KPI from the
      // ExpectedKpiImpact ledger.
      {
        type: "dashboardWidget",
        id: MC_SCOREBOARD_SLOT,
        displayName: "Mission Control — KPI Scoreboard",
        exportName: "MissionControlScoreboardWidget",
      },
      // Phase 4 — Node profile: open assignments per node + arbitrary
      // task-id chain inspector.
      {
        type: "dashboardWidget",
        id: MC_NODE_PROFILE_SLOT,
        displayName: "Mission Control — Node Profile",
        exportName: "MissionControlNodeProfileWidget",
      },
      // Phase 5 — Accountability graph (force-directed SVG with
      // structural + work-flow edges, time scrubber).
      {
        type: "dashboardWidget",
        id: MC_GRAPH_SLOT,
        displayName: "Mission Control — Accountability Graph",
        exportName: "MissionControlGraphWidget",
      },
      {
        type: "dashboardWidget",
        id: EXPERT_AGENTS_SLOT,
        displayName: "WaveX Expert Agents",
        exportName: "ExpertAgentsStatusWidget",
      },
      {
        type: "dashboardWidget",
        id: DELIVERABLES_SLOT,
        displayName: "WaveX Deliverables",
        exportName: "DeliverablesWidget",
      },
      {
        type: "dashboardWidget",
        id: FLEET_KPIS_SLOT,
        displayName: "WaveX Fleet KPIs",
        exportName: "FleetKpisWidget",
      },
      {
        type: "dashboardWidget",
        id: DELIVERABLES_THROUGHPUT_SLOT,
        displayName: "WaveX Deliverables Throughput",
        exportName: "DeliverablesThroughputWidget",
      },
      {
        type: "dashboardWidget",
        id: AGENT_STATUS_SLOT,
        displayName: "WaveX Agent Status",
        exportName: "AgentStatusWidget",
      },
      {
        type: "sidebar",
        id: INCEPTION_STATUS_SLOT,
        displayName: "Inception Status",
        exportName: "InceptionStatusPanel",
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
          "Where the plugin reads inception manifests + Expert Agent hire state. Defaults to the wavex-os mock-core endpoint.",
        default: "http://127.0.0.1:3101",
      },
      supabaseUrl: {
        type: "string",
        format: "uri",
        title: "Supabase project URL (optional)",
        description:
          "If set, the plugin reads catalog/hire counts directly from the wavex_os_ops_* RPCs. Leave blank to fall back to wavex-os-server proxying.",
      },
      supabasePublishableKey: {
        type: "string",
        title: "Supabase publishable key (optional)",
        description:
          "Anon-style key with read access to the ops RPCs. Never paste a service-role key here.",
      },
    },
  },
};

export default manifest;
