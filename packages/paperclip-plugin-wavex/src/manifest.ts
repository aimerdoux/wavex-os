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
const PLUGIN_VERSION = "0.5.0";

// Slot IDs are referenced from the host's UI registry. Keep them stable
// (operator's saved-layout state references them by id).
const INCEPTION_STATUS_SLOT = "wavex-inception-status";
const WAVEX_SETTINGS_SLOT = "wavex-preferences";
// Mission Control dashboard widgets — the 7 supported surfaces.
const MC_STREAM_SLOT = "wavex-mission-control-stream";
const MC_DELIVERABLES_SLOT = "wavex-mission-control-deliverables";
const MC_SCOREBOARD_SLOT = "wavex-mission-control-scoreboard";
const MC_NODE_PROFILE_SLOT = "wavex-mission-control-node-profile";
const MC_GRAPH_SLOT = "wavex-mission-control-graph";
const MC_CHIEF_SLOT = "wavex-mission-control-chief";
const MC_POLISH_SLOT = "wavex-mission-control-polish";

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
      // Phase 6 — Chief of Staff config + origination rules + evaluator.
      {
        type: "dashboardWidget",
        id: MC_CHIEF_SLOT,
        displayName: "Mission Control — Chief of Staff",
        exportName: "MissionControlChiefWidget",
      },
      // Phase 7 — Operations polish (cost / capacity / weekly export).
      {
        type: "dashboardWidget",
        id: MC_POLISH_SLOT,
        displayName: "Mission Control — Operations",
        exportName: "MissionControlPolishWidget",
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
          "Where the plugin reads Mission Control + inception data. Defaults to the local mock-core endpoint.",
        default: "http://127.0.0.1:3101",
      },
    },
  },
};

export default manifest;
