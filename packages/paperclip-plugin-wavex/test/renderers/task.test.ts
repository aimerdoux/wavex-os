import { describe, expect, it } from "vitest";
import { renderers } from "../../src/renderers/index.js";
import { makeCtx, makeEvent } from "./fixtures.js";

const ctx = makeCtx();

describe("task renderers", () => {
  it("task_originated — with KPI", () => {
    const out = renderers.task_originated(
      makeEvent({
        kind: "task_originated",
        actorNodeId: "chief-1",
        subjectRef: { kind: "task", title: "Cold outreach batch" },
        kpiRef: { id: "kpi-leads", name: "Weekly Leads" },
      }),
      ctx,
    );
    expect(out).toBe(
      `Chief of Staff originated task: "Cold outreach batch" — Linked KPI: Weekly Leads`,
    );
  });

  it("task_originated — without KPI", () => {
    const out = renderers.task_originated(
      makeEvent({
        kind: "task_originated",
        actorNodeId: "user-1",
        subjectRef: { kind: "task", title: "Refactor billing" },
      }),
      ctx,
    );
    expect(out).toBe(
      `Founder originated task: "Refactor billing" — no KPI linkage stated`,
    );
  });

  it("task_assigned", () => {
    const out = renderers.task_assigned(
      makeEvent({
        kind: "task_assigned",
        actorNodeId: "chief-1",
        subjectRef: {
          kind: "task",
          title: "Send quarterly report",
          toNodeId: "agent-sales",
          reason: "best fit",
        },
      }),
      ctx,
    );
    expect(out).toBe(
      `Chief of Staff assigned "Send quarterly report" to Sales Agent (best fit)`,
    );
  });

  it("task_accepted", () => {
    const out = renderers.task_accepted(
      makeEvent({
        kind: "task_accepted",
        actorNodeId: "agent-sales",
        subjectRef: { kind: "task", title: "Draft Q3 plan" },
        costUSD: 0.42,
      }),
      ctx,
    );
    expect(out).toBe(`Sales Agent accepted task: "Draft Q3 plan" est $0.42`);
  });

  it("task_delegated", () => {
    const out = renderers.task_delegated(
      makeEvent({
        kind: "task_delegated",
        actorNodeId: "agent-sales",
        subjectRef: {
          kind: "task",
          title: "Compile leads list",
          toNodeId: "agent-eng",
          reason: "needs SQL",
        },
      }),
      ctx,
    );
    expect(out).toBe(
      `Sales Agent delegated to Eng Agent: "Compile leads list" — needs SQL`,
    );
  });

  it("task_awaiting_review", () => {
    const out = renderers.task_awaiting_review(
      makeEvent({
        kind: "task_awaiting_review",
        actorNodeId: "agent-sales",
        subjectRef: { kind: "task", title: "Outbound email batch" },
      }),
      ctx,
    );
    expect(out).toBe(`Sales Agent flagged "Outbound email batch" for review`);
  });

  it("task_approved", () => {
    const out = renderers.task_approved(
      makeEvent({
        kind: "task_approved",
        actorNodeId: "user-1",
        subjectRef: { kind: "task", title: "Outbound email batch" },
      }),
      ctx,
    );
    expect(out).toBe(`Founder approved "Outbound email batch"`);
  });

  it("task_rejected — with reason", () => {
    const out = renderers.task_rejected(
      makeEvent({
        kind: "task_rejected",
        actorNodeId: "user-1",
        subjectRef: {
          kind: "task",
          title: "Send to VIP list",
          reason: "tone off",
        },
      }),
      ctx,
    );
    expect(out).toBe(`Founder rejected "Send to VIP list" — tone off`);
  });

  it("task_completed", () => {
    const out = renderers.task_completed(
      makeEvent({
        kind: "task_completed",
        actorNodeId: "agent-sales",
        subjectRef: { kind: "task", title: "Outreach" },
        costUSD: 1.23,
      }),
      ctx,
    );
    expect(out).toBe(`Sales Agent completed "Outreach" ($1.23)`);
  });

  it("task_failed", () => {
    const out = renderers.task_failed(
      makeEvent({
        kind: "task_failed",
        actorNodeId: "agent-eng",
        subjectRef: {
          kind: "task",
          title: "DB migration",
          reason: "lock timeout",
        },
      }),
      ctx,
    );
    expect(out).toBe(`Eng Agent failed "DB migration" — lock timeout`);
  });

  it("task_cancelled", () => {
    const out = renderers.task_cancelled(
      makeEvent({
        kind: "task_cancelled",
        actorNodeId: "user-1",
        subjectRef: {
          kind: "task",
          title: "Pause this",
          reason: "out of scope",
        },
      }),
      ctx,
    );
    expect(out).toBe(`Founder cancelled "Pause this" — out of scope`);
  });
});
