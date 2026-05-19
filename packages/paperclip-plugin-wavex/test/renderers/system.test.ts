import { describe, expect, it } from "vitest";
import { renderers, renderEvent } from "../../src/renderers/index.js";
import { makeCtx, makeEvent } from "./fixtures.js";

const ctx = makeCtx();

describe("system renderers", () => {
  it("cost_threshold_crossed", () => {
    const out = renderers.cost_threshold_crossed(
      makeEvent({
        kind: "cost_threshold_crossed",
        actorNodeId: "agent-sales",
        subjectRef: { kind: "cost", tier: "daily" },
        costUSD: 14.5,
      }),
      ctx,
    );
    expect(out).toBe(`⚠ Sales Agent crossed daily threshold ($14.50)`);
  });

  it("integrity_warning_shown", () => {
    const out = renderers.integrity_warning_shown(
      makeEvent({
        kind: "integrity_warning_shown",
        actorNodeId: "user-1",
        subjectRef: {
          kind: "integrity",
          id: "agent-sales",
          reason: "draft contains unverified claim",
        },
      }),
      ctx,
    );
    expect(out).toBe(
      `Integrity warning shown to Sales Agent: draft contains unverified claim`,
    );
  });

  it("integrity_warning_overridden", () => {
    const out = renderers.integrity_warning_overridden(
      makeEvent({
        kind: "integrity_warning_overridden",
        actorNodeId: "user-1",
        subjectRef: { kind: "integrity", reason: "verified by hand" },
      }),
      ctx,
    );
    expect(out).toBe(`⚠ Founder overrode integrity warning: verified by hand`);
  });

  it("mode_changed", () => {
    const out = renderers.mode_changed(
      makeEvent({
        kind: "mode_changed",
        actorNodeId: "user-1",
        subjectRef: { kind: "mode", from: "solo_founder", to: "hybrid" },
      }),
      ctx,
    );
    expect(out).toBe(`Instance mode changed: solo_founder → hybrid`);
  });

  it("workspace_member_added", () => {
    const out = renderers.workspace_member_added(
      makeEvent({
        kind: "workspace_member_added",
        actorNodeId: "user-1",
        subjectRef: { kind: "member", memberId: "member-jane" },
      }),
      ctx,
    );
    expect(out).toBe(`Jane joined the workspace`);
  });

  it("department_added", () => {
    const out = renderers.department_added(
      makeEvent({
        kind: "department_added",
        actorNodeId: "user-1",
        subjectRef: { kind: "department", departmentId: "dept-sales" },
      }),
      ctx,
    );
    expect(out).toBe(`Sales department added`);
  });

  it("renderEvent — uses pre-rendered sentence when present", () => {
    const event = makeEvent({
      kind: "task_completed",
      actorNodeId: "agent-sales",
      subjectRef: { kind: "task", title: "Outreach" },
    });
    event.plainLanguageSentence = "Server-rendered sentence wins";
    expect(renderEvent(event, ctx)).toBe("Server-rendered sentence wins");
  });

  it("renderEvent — falls back to actor → action for unmapped kinds", () => {
    // Simulate an unknown event kind by casting; renderEvent should fall
    // through to the generic fallback rather than throwing.
    const event = makeEvent({
      kind: "task_completed",
      actorNodeId: "agent-sales",
      action: "experimental.future_kind",
    });
    event.kind = "experimental_future_kind" as never;
    expect(renderEvent(event, ctx)).toBe(
      `agent-sales → experimental.future_kind`,
    );
  });
});
