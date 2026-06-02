import { describe, it, expect } from "vitest";
import { classifyQuotaResponse } from "../src/lib/claude-quota-preflight.js";

describe("classifyQuotaResponse", () => {
  it("flags the auth/login failure that caused 91% of the 2026-05-27 storm", () => {
    const real =
      "Claude run failed: subtype=success: Your organization does not have access to Claude. Please login again or contact your administrator";
    expect(classifyQuotaResponse(real).state).toBe("auth_failed");
  });

  it("matches the 'please login again' phrasing on its own", () => {
    expect(classifyQuotaResponse("Please login again").state).toBe("auth_failed");
  });

  it("flags a hard quota ceiling as exhausted with a reset hint", () => {
    const out = "You've hit your Sonnet limit · resets May 24 at 6am (America/Los_Angeles)";
    const r = classifyQuotaResponse(out);
    expect(r.state).toBe("exhausted");
    expect(r.resetHint).toBe("May 24 at 6am");
  });

  it("flags a server-side throttle as transient (not a ceiling)", () => {
    const out = "API Error: Server is temporarily limiting requests (not your usage limit)";
    expect(classifyQuotaResponse(out).state).toBe("transient");
  });

  it("treats a normal completion as ok", () => {
    expect(classifyQuotaResponse("Ready when you are — what would you like to work on?").state).toBe("ok");
  });

  it("does not misclassify auth failures as ok (the pre-fix gap)", () => {
    expect(classifyQuotaResponse("organization does not have access to Claude").state).not.toBe("ok");
  });
});
