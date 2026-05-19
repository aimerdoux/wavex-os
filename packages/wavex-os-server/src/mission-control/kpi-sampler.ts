/** Mission Control — KPI snapshot sampler.
 *
 *  Captures one row per KPI per cycle into kpi_snapshots. Drives the
 *  Phase 2 sparklines + delta-vs-previous-period overlays in the
 *  Scoreboard widget.
 *
 *  The sampler is intentionally cheap + idempotent: any caller (the
 *  measure-due endpoint, an external cron, an operator-triggered manual
 *  sample) can invoke `sampleAllKpis(companyId)` and we just insert
 *  whatever the current scoreboard reads. Backfill happens via
 *  declareKpiImpact + recordKpiMeasurement (existing Phase 3 v1 flow).
 *
 *  No history dedup: each tick writes regardless of whether the value
 *  changed. The Scoreboard widget downsamples on read. */

import { randomUUID } from "node:crypto";
import { type Db, getDb, mcKpiSnapshots } from "@wavex-os/db";
import { getScoreboard } from "./kpi-impacts.js";

export interface SampleResult {
  sampled: number;
  kpiIds: string[];
}

export async function sampleAllKpis(
  companyId: string,
  db?: Db,
): Promise<SampleResult> {
  const resolved = db ?? (await getDb());
  const board = await getScoreboard(companyId, resolved);
  if (board.length === 0) return { sampled: 0, kpiIds: [] };
  const now = new Date();
  const rows = board.map((entry) => ({
    id: randomUUID(),
    companyId,
    kpiId: entry.kpiId,
    value: entry.cumulativeActual,
    target: entry.cumulativeEstimated > 0 ? entry.cumulativeEstimated : null,
    measuredAt: now,
    source: "scheduler",
  }));
  await resolved.insert(mcKpiSnapshots).values(rows);
  return { sampled: rows.length, kpiIds: rows.map((r) => r.kpiId) };
}
