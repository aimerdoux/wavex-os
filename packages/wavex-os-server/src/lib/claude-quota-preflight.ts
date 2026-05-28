/** Claude quota pre-flight (G1).
 *
 *  The operator's Claude Max plan tracks per-model sub-limits (5h /
 *  weekly / "Sonnet only") independently. When the bucket for the model
 *  the fleet uses is exhausted, EVERY agent heartbeat fails with
 *  "You've hit your <model> limit · resets <date>" — even when the
 *  overall weekly still has headroom. On 2026-05-19 this spawned 35
 *  agents that produced 50 doomed runs before anyone noticed.
 *
 *  This module makes a cheap canary call to the configured agent model
 *  before a bulk spawn (activate handoff) so we can refuse to turn loose
 *  a fleet that will only burn quota on failures. The signal that
 *  matters only surfaces on a real call — `claude auth status` reports
 *  loggedIn:true even when the model bucket is dry — so the probe issues
 *  a 1-token request and inspects the response.
 *
 *  Distinguishes three states:
 *    - "ok"          — model responded; safe to spawn
 *    - "exhausted"   — hard usage-limit hit ("hit your … limit / resets")
 *    - "transient"   — server-side 429 ("temporarily limiting"); not a
 *                      quota ceiling, callers may proceed (heartbeat
 *                      retry/backoff handles it)
 *    - "unknown"     — probe failed for an unrelated reason (claude not
 *                      installed, timeout); callers decide (default:
 *                      proceed, don't block the wizard on a flaky probe)
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type QuotaState = "ok" | "exhausted" | "transient" | "unknown";

export interface QuotaProbeResult {
  state: QuotaState;
  model: string;
  /** Human-readable reason, surfaced to the operator. */
  detail: string;
  /** Parsed reset hint from the limit message, e.g. "May 24 at 6am". */
  resetHint: string | null;
}

const PROBE_TIMEOUT_MS = 25_000;

function repoRoot(): string {
  // src lives at packages/wavex-os-server/src/lib/claude-quota-preflight.ts
  const here = fileURLToPath(import.meta.url);
  return join(here, "..", "..", "..", "..", "..");
}

function claudeBin(): string {
  return process.env.WAVEX_OS_CLAUDE_BIN
    ?? process.env.PAPERCLIP_HANDOFF_WRAPPER
    ?? join(repoRoot(), "scripts", "ops", "claude-keychain-wrapper.sh");
}

/** Classify a claude -p text response into a quota state. */
export function classifyQuotaResponse(output: string): {
  state: QuotaState;
  resetHint: string | null;
} {
  const text = output.toLowerCase();
  // Hard usage-limit ceiling. Anthropic phrasing:
  //   "You've hit your Sonnet limit · resets May 24 at 6am (...)"
  //   "You've hit your usage limit · resets ..."
  if (/hit your .*limit/.test(text) || (/\blimit\b/.test(text) && /\bresets?\b/.test(text))) {
    const m = output.match(/resets?\s+([^()\n]+?)(?:\s*\(|$)/i);
    return { state: "exhausted", resetHint: m ? m[1].trim() : null };
  }
  // Transient server-side throttle — NOT a quota ceiling.
  //   "API Error: Server is temporarily limiting requests (not your usage limit)"
  if (/temporarily limiting/.test(text) || /\brate limited\b/.test(text)) {
    return { state: "transient", resetHint: null };
  }
  return { state: "ok", resetHint: null };
}

/** Issue a 1-token canary to the model and classify the result. */
export function probeClaudeQuota(
  model: string,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<QuotaProbeResult> {
  return new Promise((resolve) => {
    const bin = claudeBin();
    const child = spawn(
      bin,
      ["--print", "-", "--model", model, "--dangerously-skip-permissions"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => { stdout += d.toString(); });
    child.stderr?.on("data", (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      resolve({
        state: "unknown",
        model,
        detail: `quota probe timed out after ${timeoutMs}ms`,
        resetHint: null,
      });
    }, timeoutMs);

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        state: "unknown",
        model,
        detail: `quota probe could not spawn claude: ${err.message}`,
        resetHint: null,
      });
    });

    child.on("close", () => {
      clearTimeout(timer);
      const combined = `${stdout}\n${stderr}`;
      const { state, resetHint } = classifyQuotaResponse(combined);
      const detail =
        state === "exhausted"
          ? `Claude ${model} quota exhausted${resetHint ? ` — resets ${resetHint}` : ""}`
          : state === "transient"
            ? `Claude is temporarily rate-limiting requests (transient, not a quota ceiling)`
            : state === "ok"
              ? `Claude ${model} responded — quota available`
              : `quota probe inconclusive`;
      resolve({ state, model, detail, resetHint });
    });

    // Minimal prompt — we only care whether the model answers or returns
    // a limit envelope, not the content.
    child.stdin?.write("ping");
    child.stdin?.end();
  });
}

/** The model the fleet's agents run under (set at handoff time). */
export function fleetAgentModel(): string {
  return process.env.WAVEX_AGENT_MODEL ?? "claude-sonnet-4-6";
}
