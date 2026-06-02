/** Tests for GET /api/expansion/reengagement/metrics (WAVAAAAA-63 + WAVAAAAA-213).
 *
 *  Covers:
 *   - existing fields pass through unchanged
 *   - new value fields (mean_post_nudge_booking_value, total_post_nudge_gmv,
 *     pro_aov_baseline_90d, aov_delta_pct) are present in the response
 *   - value fields are null when the RPC signals no real sends
 *   - window_hours query param is forwarded to the RPC
 *   - 503 when Supabase is not configured */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { registerWavexOsRoutes } from "../src/index.js";

let app: ReturnType<typeof Fastify>;
let tempDir: string;

beforeEach(async () => {
  tempDir = mkdtempSync(join(tmpdir(), "reengagement-test-"));
  process.env.WAVEX_OS_STATE_DIR = tempDir;
  process.env.PAPERCLIP_DATA_DIR = tempDir;
  process.env.WAVEX_AUTH_MODE = "dev";
  process.env.WAVEX_COMPOSIO_DISABLED = "1";
  app = Fastify({ logger: false });
  registerWavexOsRoutes(app);
  await app.ready();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await app.close();
  delete process.env.WAVEX_OS_STATE_DIR;
  delete process.env.PAPERCLIP_DATA_DIR;
  delete process.env.WAVEX_AUTH_MODE;
  delete process.env.WAVEX_COMPOSIO_DISABLED;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  rmSync(tempDir, { recursive: true, force: true });
});

function mockSupabaseRpc(row: Record<string, unknown>) {
  process.env.SUPABASE_URL = "http://supabase.test";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [row],
      text: async () => "",
    }),
  );
}

describe("GET /api/expansion/reengagement/metrics", () => {
  it("returns 503 when Supabase is not configured", async () => {
    delete process.env.SUPABASE_URL;
    const r = await app.inject({ method: "GET", url: "/api/expansion/reengagement/metrics" });
    expect(r.statusCode).toBe(503);
    expect(r.json().ok).toBe(false);
  });

  it("passes through existing fields unchanged", async () => {
    mockSupabaseRpc({
      nudges_sent: 5,
      nudges_dry_run: 12,
      reactivated: 2,
      reactivation_rate: 0.4,
      mean_post_nudge_booking_value: null,
      total_post_nudge_gmv: null,
      pro_aov_baseline_90d: null,
      aov_delta_pct: null,
    });
    const r = await app.inject({ method: "GET", url: "/api/expansion/reengagement/metrics" });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.ok).toBe(true);
    expect(body.nudges_sent).toBe(5);
    expect(body.nudges_dry_run).toBe(12);
    expect(body.reactivated).toBe(2);
    expect(body.reactivation_rate).toBe(0.4);
    expect(body.target_rate).toBe(0.2);
  });

  it("exposes value metrics when RPC returns booking data (WAVAAAAA-213)", async () => {
    mockSupabaseRpc({
      nudges_sent: 3,
      nudges_dry_run: 8,
      reactivated: 1,
      reactivation_rate: 0.3333,
      mean_post_nudge_booking_value: 248.50,
      total_post_nudge_gmv: 745.50,
      pro_aov_baseline_90d: 310.00,
      aov_delta_pct: -0.1984,
    });
    const r = await app.inject({ method: "GET", url: "/api/expansion/reengagement/metrics" });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.mean_post_nudge_booking_value).toBe(248.50);
    expect(body.total_post_nudge_gmv).toBe(745.50);
    expect(body.pro_aov_baseline_90d).toBe(310.00);
    expect(body.aov_delta_pct).toBe(-0.1984);
  });

  it("returns null value fields when no real sends in window", async () => {
    // RPC returns nulls for value fields when real_sends is empty
    mockSupabaseRpc({
      nudges_sent: 0,
      nudges_dry_run: 4,
      reactivated: 0,
      reactivation_rate: 0,
      mean_post_nudge_booking_value: null,
      total_post_nudge_gmv: null,
      pro_aov_baseline_90d: null,
      aov_delta_pct: null,
    });
    const r = await app.inject({ method: "GET", url: "/api/expansion/reengagement/metrics" });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.mean_post_nudge_booking_value).toBeNull();
    expect(body.total_post_nudge_gmv).toBeNull();
    expect(body.pro_aov_baseline_90d).toBeNull();
    expect(body.aov_delta_pct).toBeNull();
  });

  it("forwards window_hours param to the RPC call", async () => {
    let capturedUrl = "";
    process.env.SUPABASE_URL = "http://supabase.test";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-key";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string) => {
        capturedUrl = url;
        return { ok: true, json: async () => [{ nudges_sent: 0, nudges_dry_run: 0, reactivated: 0, reactivation_rate: 0, mean_post_nudge_booking_value: null, total_post_nudge_gmv: null, pro_aov_baseline_90d: null, aov_delta_pct: null }], text: async () => "" };
      }),
    );
    const r = await app.inject({ method: "GET", url: "/api/expansion/reengagement/metrics?window_hours=72" });
    expect(r.statusCode).toBe(200);
    expect(r.json().window_hours).toBe(72);
    expect(capturedUrl).toContain("wavex_os_professional_reengagement_metrics");
  });

  it("returns 400 for invalid window_hours", async () => {
    const r = await app.inject({ method: "GET", url: "/api/expansion/reengagement/metrics?window_hours=0" });
    expect(r.statusCode).toBe(400);
  });
});
