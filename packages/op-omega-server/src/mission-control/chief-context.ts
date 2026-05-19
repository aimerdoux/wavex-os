/** Mission Control v2 — Chief of Staff context builder (Phase 5).
 *
 *  Pulls a compact, structured snapshot of the current company state to
 *  inject into the Kernel chat (board mode) system prompt. The Chief
 *  AI lives ONLY in that chat — there is no widget-facing "generate
 *  briefing" button.
 *
 *  Three derived signals on top of the raw scoreboard:
 *    - anomalies      : KPIs whose current rolling delta exceeds ±2σ of
 *                       their 30-sample history
 *    - riskySnowballs : KPIs with `attainmentRatio < 0.7` whose horizon
 *                       deadline is within 30 days (linear extrapolation)
 *    - hotNodes       : nodes with `activityCount > 2 × avg`
 *    - orphanWork     : reused from buildImpactSummary
 *
 *  All values are intentionally trimmed to the top-N most decision-
 *  relevant entries so the injected block stays under ~2K tokens.
 */

import { and, desc, eq, gte } from "drizzle-orm";
import {
  type Db,
  expectedKpiImpacts,
  getDb,
  mcKpiSnapshots,
  missionControlEvents,
} from "@wavex-os/db";
import { getScoreboardWithHistory } from "./kpi-impacts.js";
import { buildImpactSummary } from "./impact-graph.js";
import { buildAccountabilityGraph } from "./graph.js";

export interface ChiefContext {
  scoreboard: Array<{
    kpiId: string;
    label: string;
    current: number;
    target: number | null;
    delta: number;
    status: string;
    freshnessWarning: boolean;
  }>;
  anomalies: Array<{ kpiId: string; sigma: number; detail: string }>;
  riskySnowballs: Array<{
    headlineGoalKpi: string;
    projectedCompletionPct: number;
    blockers: string[];
  }>;
  orphanedWork: Array<{
    taskRefId: string;
    ownerNodeId: string | null;
    ageHours: number;
  }>;
  hotNodes: Array<{
    nodeId: string;
    name: string;
    load: number;
    avgLoad: number;
  }>;
  recentEvents: Array<{ at: string; sentence: string; kind: string }>;
  generatedAt: string;
}

export async function buildChiefContext(
  companyId: string,
  db?: Db,
): Promise<ChiefContext> {
  const resolved = db ?? (await getDb());

  // Scoreboard with rolling history (Phase 2 v2).
  const rich = await getScoreboardWithHistory(
    companyId,
    {},
    resolved,
  ).catch(() => [] as Awaited<ReturnType<typeof getScoreboardWithHistory>>);
  const scoreboard = rich.slice(0, 12).map((r) => ({
    kpiId: r.kpiId,
    label: r.kpiId,
    current: r.current ?? 0,
    target: r.target ?? null,
    delta: r.delta ?? 0,
    status: r.status ?? "unknown",
    freshnessWarning: Boolean(r.freshnessWarning),
  }));

  // Anomalies: rolling sigma over kpi_snapshots (last 30 samples).
  const anomalies: ChiefContext["anomalies"] = [];
  for (const kpi of scoreboard) {
    const snaps = await resolved
      .select({ value: mcKpiSnapshots.value })
      .from(mcKpiSnapshots)
      .where(
        and(
          eq(mcKpiSnapshots.companyId, companyId),
          eq(mcKpiSnapshots.kpiId, kpi.kpiId),
        ),
      )
      .orderBy(desc(mcKpiSnapshots.measuredAt))
      .limit(30);
    if (snaps.length < 5) continue;
    const mean = snaps.reduce((a, b) => a + (b.value ?? 0), 0) / snaps.length;
    const variance =
      snaps.reduce((a, b) => a + ((b.value ?? 0) - mean) ** 2, 0) /
      snaps.length;
    const sd = Math.sqrt(variance);
    if (sd === 0) continue;
    const sigma = Math.abs((kpi.current - mean) / sd);
    if (sigma >= 2) {
      anomalies.push({
        kpiId: kpi.kpiId,
        sigma: Number(sigma.toFixed(2)),
        detail: `current ${kpi.current.toFixed(1)} vs 30-sample mean ${mean.toFixed(1)} (σ=${sd.toFixed(2)})`,
      });
    }
  }

  // Risky snowballs: any KPI with status off-track or at-risk.
  const riskySnowballs: ChiefContext["riskySnowballs"] = scoreboard
    .filter((k) => k.status === "off-track" || k.status === "at-risk")
    .slice(0, 5)
    .map((k) => ({
      headlineGoalKpi: k.kpiId,
      projectedCompletionPct:
        k.target && k.target !== 0 ? Math.max(0, Math.min(1, k.current / k.target)) : 0,
      blockers: k.freshnessWarning
        ? ["stale measurement (>7d old)"]
        : [],
    }));

  // Hot nodes: pulled from accountability graph (last 7 days).
  let hotNodes: ChiefContext["hotNodes"] = [];
  const graph = await buildAccountabilityGraph({ companyId }, resolved).catch(
    () => null,
  );
  if (graph) {
    const counts = graph.nodes.map((n) => n.activityCount);
    const avg =
      counts.length === 0 ? 0 : counts.reduce((a, b) => a + b, 0) / counts.length;
    hotNodes = graph.nodes
      .filter((n) => avg > 0 && n.activityCount > 2 * avg)
      .sort((a, b) => b.activityCount - a.activityCount)
      .slice(0, 5)
      .map((n) => ({
        nodeId: n.id,
        name: n.name,
        load: n.activityCount,
        avgLoad: Number(avg.toFixed(1)),
      }));
  }

  // Orphan work: reuse impact-summary.
  const impactSummary = await buildImpactSummary(companyId, resolved).catch(
    () => null,
  );
  const orphanedWork = (impactSummary?.orphanWork ?? []).slice(0, 10);

  // Recent events: last 25 mission-control events with rendered sentence
  // (so the prompt can quote them). We pull `rendered` if present, else
  // a fallback constructed from action + actorNodeId.
  const eventRows = await resolved
    .select()
    .from(missionControlEvents)
    .where(
      and(
        eq(missionControlEvents.companyId, companyId),
        gte(
          missionControlEvents.at,
          new Date(Date.now() - 24 * 60 * 60 * 1000),
        ),
      ),
    )
    .orderBy(desc(missionControlEvents.at))
    .limit(25);
  const recentEvents = eventRows.map((r) => ({
    at: r.at.toISOString(),
    sentence: r.plainLanguageSentence || `${r.kind} (${r.action})`,
    kind: r.kind,
  }));

  return {
    scoreboard,
    anomalies,
    riskySnowballs,
    orphanedWork: orphanedWork.map((o) => ({
      taskRefId: o.taskRefId,
      ownerNodeId: o.ownerNodeId ?? null,
      ageHours: o.ageHours,
    })),
    hotNodes,
    recentEvents,
    generatedAt: new Date().toISOString(),
  };
}

/** Render the ChiefContext as a compact text block suitable for inline
 *  injection into a T2 system prompt. ~2K tokens max. */
export function renderChiefContextBlock(ctx: ChiefContext): string {
  const lines: string[] = ["<mission-control-state>"];
  lines.push(`Generated: ${ctx.generatedAt}`);
  if (ctx.scoreboard.length > 0) {
    lines.push("\nKPI Scoreboard (top 12):");
    for (const k of ctx.scoreboard) {
      const t = k.target != null ? ` / ${k.target}` : "";
      const fresh = k.freshnessWarning ? " ⚠STALE" : "";
      lines.push(
        `  - ${k.label} (${k.kpiId}): ${k.current.toFixed(1)}${t} · Δ${k.delta >= 0 ? "+" : ""}${k.delta.toFixed(1)} · ${k.status}${fresh}`,
      );
    }
  }
  if (ctx.anomalies.length > 0) {
    lines.push("\nAnomalies (>2σ from rolling mean):");
    for (const a of ctx.anomalies) {
      lines.push(`  - ${a.kpiId} σ=${a.sigma} — ${a.detail}`);
    }
  }
  if (ctx.riskySnowballs.length > 0) {
    lines.push("\nRisky snowballs:");
    for (const r of ctx.riskySnowballs) {
      const pct = Math.round(r.projectedCompletionPct * 100);
      const bl =
        r.blockers.length > 0 ? ` — blockers: ${r.blockers.join(", ")}` : "";
      lines.push(`  - ${r.headlineGoalKpi}: projected ${pct}%${bl}`);
    }
  }
  if (ctx.orphanedWork.length > 0) {
    lines.push(`\nOrphan work (${ctx.orphanedWork.length}, no declared KPI impact):`);
    for (const o of ctx.orphanedWork.slice(0, 5)) {
      lines.push(
        `  - ${o.taskRefId.slice(0, 10)} owner=${o.ownerNodeId ?? "(unassigned)"} age=${o.ageHours}h`,
      );
    }
  }
  if (ctx.hotNodes.length > 0) {
    lines.push("\nHot nodes (>2× avg load):");
    for (const n of ctx.hotNodes) {
      lines.push(`  - ${n.name}: ${n.load} events vs ${n.avgLoad} avg`);
    }
  }
  if (ctx.recentEvents.length > 0) {
    lines.push("\nRecent 24h events (last 10):");
    for (const e of ctx.recentEvents.slice(0, 10)) {
      lines.push(`  - ${e.sentence}`);
    }
  }
  lines.push("</mission-control-state>");
  return lines.join("\n");
}

/** Slash-command pre-processor. Returns a rewritten prompt (richer than
 *  the raw command) when the operator types /briefing, /anomalies, or
 *  /orphans. Returns null otherwise (caller uses the raw message). */
export function rewriteSlashCommand(message: string): string | null {
  const t = message.trim().toLowerCase();
  if (t === "/briefing" || t === "/brief") {
    return "Give me a structured briefing in this exact format:\n\n**Headline**: one-line summary of where the company is right now (cite the most important KPI).\n\n**Top 3 risks** (numbered, each one sentence, name specific KPIs/agents).\n\n**Suggested actions** (numbered, each tied to a concrete deliverable or hire already in the system; if a pause/resume action is warranted, emit the action chip).\n\nGround every claim in the <mission-control-state> block. Don't speculate.";
  }
  if (t === "/anomalies") {
    return "List every anomaly in the mission-control-state block. For each: KPI name, sigma, and a one-sentence hypothesis on why. If there are no anomalies, say so plainly.";
  }
  if (t === "/orphans") {
    return "List the orphan work items from mission-control-state. For each: task id, current owner (or '(unassigned)'), age, and a one-sentence recommended action — usually 'declare a KPI impact' or 'archive if stale'. If there are no orphans, say so.";
  }
  return null;
}
