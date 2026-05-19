import { describe, expect, it } from "vitest";
import { renderers } from "../../src/renderers/index.js";
import { makeCtx, makeEvent } from "./fixtures.js";

const ctx = makeCtx();

describe("chief renderers", () => {
  it("chief_pattern_detected", () => {
    const out = renderers.chief_pattern_detected(
      makeEvent({
        kind: "chief_pattern_detected",
        actorNodeId: "chief-1",
        subjectRef: {
          kind: "pattern",
          patternDescription: "lead response time slipping past 2h",
        },
      }),
      ctx,
    );
    expect(out).toBe(
      `Chief of Staff detected pattern: lead response time slipping past 2h`,
    );
  });

  it("chief_origination_blocked — with target node", () => {
    const out = renderers.chief_origination_blocked(
      makeEvent({
        kind: "chief_origination_blocked",
        actorNodeId: "chief-1",
        subjectRef: {
          kind: "origination",
          reason: "daily budget reached",
          toNodeId: "agent-sales",
        },
      }),
      ctx,
    );
    expect(out).toBe(
      `Chief of Staff skipped origination — daily budget reached (would have assigned to Sales Agent)`,
    );
  });

  it("chief_rebalance_recommended", () => {
    const out = renderers.chief_rebalance_recommended(
      makeEvent({
        kind: "chief_rebalance_recommended",
        actorNodeId: "chief-1",
        subjectRef: {
          kind: "rebalance",
          summary: "Eng Agent at 92% capacity, Sales Agent at 31%",
        },
      }),
      ctx,
    );
    expect(out).toBe(
      `Chief of Staff recommends rebalance: Eng Agent at 92% capacity, Sales Agent at 31%`,
    );
  });
});
