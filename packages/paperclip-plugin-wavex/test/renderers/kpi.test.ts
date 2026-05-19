import { describe, expect, it } from "vitest";
import { renderers } from "../../src/renderers/index.js";
import { makeCtx, makeEvent } from "./fixtures.js";

const ctx = makeCtx();

describe("kpi renderers", () => {
  it("kpi_measurement_taken — value + target", () => {
    const out = renderers.kpi_measurement_taken(
      makeEvent({
        kind: "kpi_measurement_taken",
        actorNodeId: "agent-sales",
        subjectRef: { kind: "measurement", value: 72, target: 100 },
        kpiRef: { id: "kpi-leads", name: "Weekly Leads" },
      }),
      ctx,
    );
    expect(out).toBe(
      `Weekly Leads measured for Sales Agent: 72 (target 100)`,
    );
  });

  it("kpi_measurement_taken — no value", () => {
    const out = renderers.kpi_measurement_taken(
      makeEvent({
        kind: "kpi_measurement_taken",
        actorNodeId: "agent-sales",
        subjectRef: { kind: "measurement" },
        kpiRef: { id: "kpi-arr", name: "ARR" },
      }),
      ctx,
    );
    expect(out).toBe(`ARR measured for Sales Agent`);
  });

  it("kpi_target_hit", () => {
    const out = renderers.kpi_target_hit(
      makeEvent({
        kind: "kpi_target_hit",
        actorNodeId: "agent-sales",
        subjectRef: { kind: "kpi" },
        kpiRef: { id: "kpi-leads", name: "Weekly Leads" },
      }),
      ctx,
    );
    expect(out).toBe(`🎯 Weekly Leads hit target — owner: Sales Agent`);
  });

  it("kpi_target_missed — with gap", () => {
    const out = renderers.kpi_target_missed(
      makeEvent({
        kind: "kpi_target_missed",
        actorNodeId: "agent-sales",
        subjectRef: { kind: "kpi", gap: 12 },
        kpiRef: { id: "kpi-leads", name: "Weekly Leads" },
      }),
      ctx,
    );
    expect(out).toBe(
      `⚠ Weekly Leads missed target (off by 12) — owner: Sales Agent`,
    );
  });

  it("kpi_variance_detected", () => {
    const out = renderers.kpi_variance_detected(
      makeEvent({
        kind: "kpi_variance_detected",
        actorNodeId: "chief-1",
        subjectRef: { kind: "kpi", variancePct: -18.4 },
        kpiRef: { id: "kpi-arr", name: "ARR" },
      }),
      ctx,
    );
    expect(out).toBe(`⚠ ARR variance detected: -18% vs prediction`);
  });

  it("kpi_trend_alert", () => {
    const out = renderers.kpi_trend_alert(
      makeEvent({
        kind: "kpi_trend_alert",
        actorNodeId: "chief-1",
        subjectRef: { kind: "kpi", direction: "trending down 3 weeks" },
        kpiRef: { id: "kpi-arr", name: "ARR" },
      }),
      ctx,
    );
    expect(out).toBe(`ARR trend alert — trending down 3 weeks`);
  });
});
