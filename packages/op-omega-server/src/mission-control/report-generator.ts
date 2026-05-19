/** Mission Control v2 Phase 5 — Weekly accountability report.
 *
 *  Composes a single markdown document covering the past 7 days. No
 *  new endpoints — pulls from the existing services we already have:
 *
 *    - scoreboardWithHistory (Phase 2 v2 KPI scoreboard)
 *    - getCostPerKpi + getCostDashboard (Phase 7 v2 cost attribution)
 *    - listOriginationRules + Chief eval log (Phase 6 chief)
 *    - buildImpactSummary (Phase 3 v2 — top contributors + orphans)
 *    - queryMissionControlEvents (last 7d activity)
 *
 *  Writes to:
 *    ~/.wavex-os/instances/<companyId>/reports/weekly-<yyyy-mm-dd>.md
 *
 *  Renders inline in the plugin via the existing deliverable preview
 *  (it's just markdown). No PDF, no puppeteer — per the locked plan.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

import { getScoreboardWithHistory } from "./kpi-impacts.js";
import {
  getCostPerKpi,
} from "./cost-attribution.js";
import { getCostDashboard } from "./polish.js";
import { buildImpactSummary } from "./impact-graph.js";
import { queryMissionControlEvents } from "./activity-log.js";

export interface WeeklyReportResult {
  ok: boolean;
  path: string;
  markdown: string;
  generatedAt: string;
  bytesWritten: number;
}

const REPORT_DIR_ENV = process.env.WAVEX_OS_STATE_DIR ?? join(homedir(), ".wavex-os");

function reportPath(companyId: string, date: Date): string {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return join(
    REPORT_DIR_ENV,
    "instances",
    companyId,
    "reports",
    `weekly-${yyyy}-${mm}-${dd}.md`,
  );
}

function pct(n: number | null | undefined, digits = 0): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(digits)}%`;
}
function n(v: number | null | undefined, digits = 1): string {
  if (v == null || !Number.isFinite(v)) return "—";
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (Math.abs(v) >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return Number.isInteger(v) ? String(v) : v.toFixed(digits);
}

export async function generateWeeklyReport(companyId: string): Promise<WeeklyReportResult> {
  const now = new Date();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const generatedAt = now.toISOString();

  // Parallel fetch — none of these depend on each other.
  const [scoreboard, costPerKpi, costDash, impactSummary, events] =
    await Promise.all([
      getScoreboardWithHistory(companyId, {}).catch(() => []),
      getCostPerKpi(companyId, { since: sevenDaysAgo }).catch(() => []),
      getCostDashboard(companyId, { since: sevenDaysAgo }).catch(() => ({
        totals: { costUSD: 0, events: 0 },
        byNode: [],
      })),
      buildImpactSummary(companyId).catch(() => null),
      queryMissionControlEvents({
        companyId,
        since: sevenDaysAgo,
        limit: 500,
      }).catch(() => [] as Awaited<ReturnType<typeof queryMissionControlEvents>>),
    ]);

  // ─── Compose markdown ─────────────────────────────────────────────
  const lines: string[] = [];
  lines.push(`# Weekly accountability — ${companyId}`);
  lines.push("");
  lines.push(
    `_Window: ${sevenDaysAgo.toISOString().slice(0, 10)} → ${now.toISOString().slice(0, 10)} · generated ${generatedAt}_`,
  );
  lines.push("");

  // ── Headline ────────────────────────────────────────────────────
  const headlineKpi = scoreboard[0];
  lines.push("## Headline");
  lines.push("");
  if (!headlineKpi) {
    lines.push("_No KPI impacts declared yet — declare one to get a weekly read._");
  } else {
    const status = headlineKpi.status;
    const cur = n(headlineKpi.current);
    const tgt = headlineKpi.target ? ` / ${n(headlineKpi.target)}` : "";
    const delta =
      headlineKpi.delta != null
        ? ` · Δ${headlineKpi.delta >= 0 ? "+" : ""}${n(headlineKpi.delta)}`
        : "";
    lines.push(
      `**${headlineKpi.kpiId}**: ${cur}${tgt}${delta} — _${status}_`,
    );
  }
  lines.push("");

  // ── KPI scoreboard ──────────────────────────────────────────────
  if (scoreboard.length > 0) {
    lines.push("## KPI scoreboard");
    lines.push("");
    lines.push("| KPI | Current | Target | Δ | Status |");
    lines.push("|---|---|---|---|---|");
    for (const k of scoreboard.slice(0, 12)) {
      lines.push(
        `| ${k.kpiId} | ${n(k.current)} | ${n(k.target)} | ${k.delta >= 0 ? "+" : ""}${n(k.delta)} | ${k.status}${k.freshnessWarning ? " ⚠" : ""} |`,
      );
    }
    lines.push("");
  }

  // ── $ per KPI point ─────────────────────────────────────────────
  if (costPerKpi.length > 0) {
    lines.push("## $ per KPI point");
    lines.push("");
    lines.push("| KPI | Spent (7d) | KPI delta | $ / point |");
    lines.push("|---|---|---|---|");
    for (const r of costPerKpi.slice(0, 10)) {
      lines.push(
        `| ${r.kpiId} | $${r.totalCostUSD.toFixed(2)} | ${r.totalKpiDelta >= 0 ? "+" : ""}${n(r.totalKpiDelta)} | ${r.dollarsPerPoint == null ? "—" : `$${r.dollarsPerPoint.toFixed(2)}`} |`,
      );
    }
    lines.push("");
  }

  // ── Top spenders ────────────────────────────────────────────────
  if ((costDash.byNode?.length ?? 0) > 0) {
    lines.push("## Top spenders (7d)");
    lines.push("");
    lines.push(`Total 7d spend: **$${costDash.totals.costUSD.toFixed(2)}** across ${costDash.totals.events} events.`);
    lines.push("");
    lines.push("| Node | Spend | Events |");
    lines.push("|---|---|---|");
    for (const node of costDash.byNode.slice(0, 8)) {
      lines.push(
        `| ${node.nodeName ?? node.nodeId} | $${node.costUSD.toFixed(2)} | ${node.events} |`,
      );
    }
    lines.push("");
  }

  // ── Orphan work ─────────────────────────────────────────────────
  const orphans = impactSummary?.orphanWork ?? [];
  if (orphans.length > 0) {
    lines.push(`## Orphan work (${orphans.length})`);
    lines.push("");
    lines.push("_Tasks assigned but with no declared KPI impact._");
    lines.push("");
    for (const o of orphans.slice(0, 8)) {
      lines.push(
        `- \`${o.taskRefId.slice(0, 12)}\` — owner: ${o.ownerNodeId ?? "(unassigned)"} · ${o.ageHours}h old`,
      );
    }
    lines.push("");
  }

  // ── Chief originations ──────────────────────────────────────────
  const chiefEvents = (Array.isArray(events) ? events : []).filter((e) =>
    e.kind.startsWith("chief_") || e.kind === "task_originated",
  );
  if (chiefEvents.length > 0) {
    lines.push(`## Chief activity (${chiefEvents.length} events)`);
    lines.push("");
    for (const e of chiefEvents.slice(0, 10)) {
      const when = new Date(e.at).toISOString().slice(0, 16).replace("T", " ");
      lines.push(`- ${when} — ${e.plainLanguageSentence ?? e.action}`);
    }
    lines.push("");
  }

  // ── Owner calibration ───────────────────────────────────────────
  const calibration = impactSummary?.ownerCalibration ?? [];
  if (calibration.length > 0) {
    lines.push("## Forecast calibration");
    lines.push("");
    lines.push("| Owner | Measured impacts | Avg accuracy |");
    lines.push("|---|---|---|");
    for (const c of calibration.slice(0, 8)) {
      lines.push(
        `| ${c.ownerNodeId} | ${c.impactsMeasured} | ${pct(c.avgAccuracy)} |`,
      );
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push(
    `_Generated by WaveX OS Mission Control · ${(Array.isArray(events) ? events : []).length} events in window._`,
  );

  const markdown = lines.join("\n");
  const path = reportPath(companyId, now);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, markdown, "utf8");

  return {
    ok: true,
    path,
    markdown,
    generatedAt,
    bytesWritten: Buffer.byteLength(markdown, "utf8"),
  };
}
