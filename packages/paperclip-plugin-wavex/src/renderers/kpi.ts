/** KPI lifecycle renderers — measurement, target hit/missed, variance, trend. */

import { type EventRenderer, kpiName, nodeName } from "./render-context.js";

export const kpi_measurement_taken: EventRenderer = (event, ctx) => {
  const kpi = event.kpiRef ? kpiName(event.kpiRef.id, ctx) : "KPI";
  const node = nodeName(event.actorNodeId, ctx);
  const subj = event.subjectRef;
  const value = typeof subj.value === "number" ? `: ${subj.value}` : "";
  const target = typeof subj.target === "number" ? ` (target ${subj.target})` : "";
  return `${kpi} measured for ${node}${value}${target}`;
};

export const kpi_target_hit: EventRenderer = (event, ctx) => {
  const kpi = event.kpiRef ? kpiName(event.kpiRef.id, ctx) : "KPI";
  const owner = nodeName(event.actorNodeId, ctx);
  return `🎯 ${kpi} hit target — owner: ${owner}`;
};

export const kpi_target_missed: EventRenderer = (event, ctx) => {
  const kpi = event.kpiRef ? kpiName(event.kpiRef.id, ctx) : "KPI";
  const owner = nodeName(event.actorNodeId, ctx);
  const subj = event.subjectRef;
  const gap = typeof subj.gap === "number" ? ` (off by ${subj.gap})` : "";
  return `⚠ ${kpi} missed target${gap} — owner: ${owner}`;
};

export const kpi_variance_detected: EventRenderer = (event, ctx) => {
  const kpi = event.kpiRef ? kpiName(event.kpiRef.id, ctx) : "KPI";
  const subj = event.subjectRef;
  const variancePct = typeof subj.variancePct === "number"
    ? `${subj.variancePct > 0 ? "+" : ""}${subj.variancePct.toFixed(0)}%`
    : "";
  return `⚠ ${kpi} variance detected${variancePct ? `: ${variancePct} vs prediction` : ""}`;
};

export const kpi_trend_alert: EventRenderer = (event, ctx) => {
  const kpi = event.kpiRef ? kpiName(event.kpiRef.id, ctx) : "KPI";
  const subj = event.subjectRef;
  const direction = typeof subj.direction === "string" ? subj.direction : "";
  return `${kpi} trend alert${direction ? ` — ${direction}` : ""}`;
};
