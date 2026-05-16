import { describe, expect, it } from "vitest";
import { renderers } from "../../src/renderers/index.js";
import { makeCtx, makeEvent } from "./fixtures.js";

const ctx = makeCtx();

describe("deliverable renderers", () => {
  it("deliverable_produced — with size from catalog", () => {
    const out = renderers.deliverable_produced(
      makeEvent({
        kind: "deliverable_produced",
        actorNodeId: "agent-sales",
        subjectRef: { kind: "deliverable" },
        deliverableRef: { id: "deliv-1", title: "Q3 Plan", kind: "document" },
      }),
      ctx,
    );
    expect(out).toBe(`Sales Agent produced document: Q3 Plan (4.0kb)`);
  });

  it("deliverable_produced — kind formatted with spaces", () => {
    const out = renderers.deliverable_produced(
      makeEvent({
        kind: "deliverable_produced",
        actorNodeId: "agent-sales",
        subjectRef: { kind: "deliverable", title: "Welcome email" },
        deliverableRef: {
          id: "deliv-missing",
          title: "Welcome email",
          kind: "email_draft",
        },
      }),
      ctx,
    );
    expect(out).toBe(`Sales Agent produced email draft: Welcome email`);
  });

  it("deliverable_revised", () => {
    const out = renderers.deliverable_revised(
      makeEvent({
        kind: "deliverable_revised",
        actorNodeId: "agent-sales",
        subjectRef: { kind: "deliverable", title: "Pitch deck" },
      }),
      ctx,
    );
    expect(out).toBe(`Sales Agent revised: Pitch deck`);
  });

  it("deliverable_approved", () => {
    const out = renderers.deliverable_approved(
      makeEvent({
        kind: "deliverable_approved",
        actorNodeId: "user-1",
        subjectRef: { kind: "deliverable", title: "Q3 Plan" },
      }),
      ctx,
    );
    expect(out).toBe(`Founder approved: Q3 Plan`);
  });

  it("deliverable_published", () => {
    const out = renderers.deliverable_published(
      makeEvent({
        kind: "deliverable_published",
        actorNodeId: "agent-sales",
        subjectRef: { kind: "deliverable", title: "Blog post v2" },
      }),
      ctx,
    );
    expect(out).toBe(`Sales Agent published: Blog post v2`);
  });
});
