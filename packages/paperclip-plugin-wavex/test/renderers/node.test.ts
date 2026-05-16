import { describe, expect, it } from "vitest";
import { renderers } from "../../src/renderers/index.js";
import { makeCtx, makeEvent } from "./fixtures.js";

const ctx = makeCtx();

describe("node renderers", () => {
  it("node_added — with parent", () => {
    const out = renderers.node_added(
      makeEvent({
        kind: "node_added",
        actorNodeId: "chief-1",
        subjectRef: {
          kind: "node",
          id: "agent-sales",
          toNodeId: "dept-sales",
        },
      }),
      ctx,
    );
    expect(out).toBe(`Sales Agent joined under Sales`);
  });

  it("node_added — no parent", () => {
    const out = renderers.node_added(
      makeEvent({
        kind: "node_added",
        actorNodeId: "user-1",
        subjectRef: { kind: "node", id: "dept-sales" },
      }),
      ctx,
    );
    expect(out).toBe(`Sales joined`);
  });

  it("node_archived", () => {
    const out = renderers.node_archived(
      makeEvent({
        kind: "node_archived",
        actorNodeId: "user-1",
        subjectRef: { kind: "node", id: "agent-eng", reason: "deprecated" },
      }),
      ctx,
    );
    expect(out).toBe(`Eng Agent archived — deprecated`);
  });

  it("node_paused — self-pause", () => {
    const out = renderers.node_paused(
      makeEvent({
        kind: "node_paused",
        actorNodeId: "agent-sales",
        subjectRef: { kind: "node", id: "agent-sales", reason: "cost gate" },
      }),
      ctx,
    );
    expect(out).toBe(`Sales Agent paused — cost gate`);
  });

  it("node_paused — paused by another", () => {
    const out = renderers.node_paused(
      makeEvent({
        kind: "node_paused",
        actorNodeId: "user-1",
        subjectRef: { kind: "node", id: "agent-sales", reason: "investigation" },
      }),
      ctx,
    );
    expect(out).toBe(`Founder paused Sales Agent — investigation`);
  });

  it("node_resumed", () => {
    const out = renderers.node_resumed(
      makeEvent({
        kind: "node_resumed",
        actorNodeId: "user-1",
        subjectRef: { kind: "node", id: "agent-sales" },
      }),
      ctx,
    );
    expect(out).toBe(`Founder resumed Sales Agent`);
  });

  it("node_corrected", () => {
    const out = renderers.node_corrected(
      makeEvent({
        kind: "node_corrected",
        actorNodeId: "user-1",
        subjectRef: {
          kind: "node",
          id: "agent-sales",
          reason: "tone calibration",
        },
      }),
      ctx,
    );
    expect(out).toBe(`Founder corrected Sales Agent: tone calibration`);
  });

  it("node_flagged", () => {
    const out = renderers.node_flagged(
      makeEvent({
        kind: "node_flagged",
        actorNodeId: "chief-1",
        subjectRef: { kind: "node", id: "agent-eng", reason: "stalled" },
      }),
      ctx,
    );
    expect(out).toBe(`Chief of Staff flagged Eng Agent: stalled`);
  });

  it("node_promoted", () => {
    const out = renderers.node_promoted(
      makeEvent({
        kind: "node_promoted",
        actorNodeId: "user-1",
        subjectRef: { kind: "node", id: "agent-sales" },
      }),
      ctx,
    );
    expect(out).toBe(`Founder promoted Sales Agent`);
  });
});
