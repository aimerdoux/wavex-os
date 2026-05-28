#!/usr/bin/env node
/**
 * WaveX OS — Pool B / fleet quota circuit breaker (G2).
 *
 * G1 (claude-quota-preflight.ts) stops activate from spawning a fleet
 * into an exhausted model bucket. G2 covers the OTHER failure mode: a
 * fleet that was already running when the bucket drains. Paperclip's
 * heartbeat retry policy lives in the vendored core and treats a
 * "You've hit your <model> limit" response as a transient upstream
 * error, so it schedules retries — which re-open claude sessions that
 * immediately fail again. On 2026-05-19 that produced a 50-run storm.
 *
 * This breaker runs out-of-band (cron / launchd / manual). Each tick:
 *   1. Probe the fleet model with a 1-token canary.
 *   2. If the bucket is a HARD ceiling -> pause-fleet (stops the storm),
 *      record a breaker-tripped marker with the reset hint.
 *   3. If the bucket has recovered AND we previously auto-paused ->
 *      resume-fleet and clear the marker.
 *   4. Transient 429s are ignored (heartbeat backoff handles those).
 *
 * It NEVER resumes a fleet a human paused — only one it tripped itself
 * (tracked via the marker file). It does not touch vendored code.
 *
 * Usage:
 *   node scripts/ops/wavex-quota-circuit-breaker.mjs <paperclipCompanyId>
 *   node scripts/ops/wavex-quota-circuit-breaker.mjs <co> --dry-run
 *
 * Env:
 *   WAVEX_AGENT_MODEL          model the fleet uses (default claude-sonnet-4-6)
 *   PAPERCLIP_BASE_URL         default http://127.0.0.1:3100
 *   WAVEX_OS_CLAUDE_BIN /
 *   PAPERCLIP_HANDOFF_WRAPPER  claude binary (default keychain wrapper)
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PROBE_TIMEOUT_MS = 25_000;
const MODEL = process.env.WAVEX_AGENT_MODEL ?? "claude-sonnet-4-6";
const BASE = process.env.PAPERCLIP_BASE_URL ?? "http://127.0.0.1:3100";
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const STATE_DIR = join(homedir(), ".wavex-os", "state");
const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const COMPANY = args.find((a) => !a.startsWith("--"));

if (!COMPANY) {
  console.error("usage: wavex-quota-circuit-breaker.mjs <paperclipCompanyId> [--dry-run]");
  process.exit(2);
}

const markerFile = join(STATE_DIR, `quota-breaker-${COMPANY}.json`);

function claudeBin() {
  return (
    process.env.WAVEX_OS_CLAUDE_BIN ??
    process.env.PAPERCLIP_HANDOFF_WRAPPER ??
    join(REPO_ROOT, "scripts", "ops", "claude-keychain-wrapper.sh")
  );
}

/** Shared classifier — keep in sync with
 *  packages/wavex-os-server/src/lib/claude-quota-preflight.ts. */
export function classifyQuotaResponse(output) {
  const text = output.toLowerCase();
  if (/hit your .*limit/.test(text) || (/\blimit\b/.test(text) && /\bresets?\b/.test(text))) {
    const m = output.match(/resets?\s+([^()\n]+?)(?:\s*\(|$)/i);
    return { state: "exhausted", resetHint: m ? m[1].trim() : null };
  }
  if (/temporarily limiting/.test(text) || /\brate limited\b/.test(text)) {
    return { state: "transient", resetHint: null };
  }
  return { state: "ok", resetHint: null };
}

function probe() {
  return new Promise((resolve) => {
    const child = spawn(
      claudeBin(),
      ["--print", "-", "--model", MODEL, "--dangerously-skip-permissions"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let out = "";
    child.stdout?.on("data", (d) => { out += d.toString(); });
    child.stderr?.on("data", (d) => { out += d.toString(); });
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      resolve({ state: "unknown", resetHint: null });
    }, PROBE_TIMEOUT_MS);
    child.on("error", () => { clearTimeout(timer); resolve({ state: "unknown", resetHint: null }); });
    child.on("close", () => { clearTimeout(timer); resolve(classifyQuotaResponse(out)); });
    child.stdin?.write("ping");
    child.stdin?.end();
  });
}

async function fleetAction(action) {
  const res = await fetch(`${BASE}/api/companies/${COMPANY}/${action}-fleet`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason: `quota-circuit-breaker: ${action}` }),
  });
  if (!res.ok) throw new Error(`${action}-fleet HTTP ${res.status}`);
  return res.json().catch(() => ({}));
}

function readMarker() {
  try { return JSON.parse(readFileSync(markerFile, "utf8")); } catch { return null; }
}
function writeMarker(obj) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(markerFile, JSON.stringify(obj, null, 2));
}
function clearMarker() {
  if (existsSync(markerFile)) rmSync(markerFile);
}

(async () => {
  const { state, resetHint } = await probe();
  const tripped = readMarker();
  const now = new Date().toISOString();

  if (state === "exhausted") {
    if (tripped) {
      console.log(`[breaker] still exhausted (${MODEL}); fleet already paused since ${tripped.paused_at}. resets ${resetHint ?? "?"}`);
      return;
    }
    console.log(`[breaker] ${MODEL} quota EXHAUSTED (resets ${resetHint ?? "?"}) — pausing fleet ${COMPANY}`);
    if (DRY_RUN) { console.log("[breaker] dry-run: would pause-fleet"); return; }
    const r = await fleetAction("pause").catch((e) => ({ error: String(e) }));
    writeMarker({ paused_at: now, model: MODEL, reset_hint: resetHint, result: r });
    console.log(`[breaker] paused. ${JSON.stringify(r).slice(0, 200)}`);
    return;
  }

  if (state === "ok") {
    if (tripped) {
      console.log(`[breaker] ${MODEL} quota RECOVERED — resuming fleet ${COMPANY} (auto-paused ${tripped.paused_at})`);
      if (DRY_RUN) { console.log("[breaker] dry-run: would resume-fleet"); return; }
      const r = await fleetAction("resume").catch((e) => ({ error: String(e) }));
      clearMarker();
      console.log(`[breaker] resumed. ${JSON.stringify(r).slice(0, 200)}`);
      return;
    }
    console.log(`[breaker] ${MODEL} quota ok; fleet not breaker-paused. no-op.`);
    return;
  }

  // transient | unknown — do not act; heartbeat backoff / next tick handles it.
  console.log(`[breaker] state=${state} for ${MODEL} — no action (transient/inconclusive).`);
})();
