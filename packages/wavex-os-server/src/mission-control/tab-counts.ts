/** Mission Control — Tab counts (Frontier F5).
 *
 *  Returns badge counts per subnav tab. Used by the UI to render small
 *  count chips so the operator can see at a glance which tab demands
 *  attention — without clicking through.
 *
 *  Counts intentionally err on the side of "what's actionable" not
 *  "what exists." E.g. Scoreboard count = at-risk + off-track KPIs,
 *  NOT total KPIs. Stream count = new events since last visit (always
 *  0 server-side — the client tracks its own lastSeen).
 *
 *  Cheap aggregator over already-built services. No new DB queries
 *  beyond the ones the surfaces already make.
 */

import { type Db, getDb } from "@wavex-os/db";
import { buildDecisionQueue } from "./decision-queue.js";
import { getScoreboardWithHistory } from "./kpi-impacts.js";
import { buildImpactSummary } from "./impact-graph.js";
import { listOriginationRules } from "./chief-of-staff.js";
import { getBurnRateForecast } from "./cost-attribution.js";

export interface TabCounts {
  decisions: number;
  scoreboard: number; // KPIs needing attention
  impact: number; // orphan tasks
  chief: number; // unenabled rules
  ops: number; // runway-flag (1 if < 180d, 0 otherwise)
  generatedAt: string;
}

export async function getTabCounts(companyId: string, db?: Db): Promise<TabCounts> {
  const resolved = db ?? (await getDb());

  const [queue, scoreboard, summary, rules, burn] = await Promise.all([
    buildDecisionQueue(companyId, resolved).catch(() => ({ total: 0 })),
    getScoreboardWithHistory(companyId, {}, resolved).catch(() => []),
    buildImpactSummary(companyId, resolved).catch(() => null),
    listOriginationRules(companyId, resolved).catch(() => []),
    getBurnRateForecast(companyId, { days: 30 }, resolved).catch(() => null),
  ]);

  // Decisions: just the queue total (excluding starter CTAs, which
  // shouldn't make the tab look "alarming" — they're nudges).
  const realDecisions = (queue as { items?: Array<{ kind: string }> }).items?.filter(
    (it) => it.kind !== "starter",
  ).length ?? 0;

  // Scoreboard: KPIs flagged at-risk or off-track.
  const scoreboardAttention = scoreboard.filter(
    (k) => k.status === "at-risk" || k.status === "off-track",
  ).length;

  // Impact: orphan tasks count.
  const impactOrphans = summary?.orphanWork?.length ?? 0;

  // Chief: rules in disabled state — surface them so the operator
  // remembers to review.
  const chiefDisabled = (rules ?? []).filter((r) => !r.enabled).length;

  // Ops: 1 if runway is under the watch threshold (180d).
  const opsFlag =
    burn?.projectedRunwayDays != null && burn.projectedRunwayDays < 180 ? 1 : 0;

  return {
    decisions: realDecisions,
    scoreboard: scoreboardAttention,
    impact: impactOrphans,
    chief: chiefDisabled,
    ops: opsFlag,
    generatedAt: new Date().toISOString(),
  };
}
