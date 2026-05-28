/**
 * Client for the cloud inference path — now backed by Supabase Realtime
 * pub/sub instead of the previous Cloudflare-Tunnel HTTP fetch.
 *
 * Why the change:
 *   The HTTP architecture required pointing wavexcard.com DNS at a
 *   Cloudflare Tunnel, which broke existing Vercel-managed records. The
 *   Realtime pattern is cleaner: both customer and operator connect
 *   OUTWARD to Supabase and meet in pub/sub. No tunnel, no public
 *   endpoint, no NAT traversal.
 *
 * Wire (shared with the Mac-side worker in
 * `packages/inference-server/`):
 *
 *   wavex-inference-request:<user_id>    ← customer publishes
 *   wavex-inference-response:<user_id>   ← Mac publishes; customer subs
 *
 *   Broadcast event name on both:  "wavex-inference"
 *
 *   Request payload:
 *     { request_id, device_jwt, prompt, model?, max_output_tokens?, purpose? }
 *
 *   Success response:
 *     { request_id, ok: true, content, model,
 *       usage: { input_tokens, output_tokens, cached_input_tokens,
 *                cost_usd, duration_ms } }
 *
 *   Error response:
 *     { request_id, ok: false,
 *       error: "no_paired_device" | "no_active_subscription"
 *            | "internal" | "upstream_error",
 *       message }
 *
 *   Auth: the customer connects with the Supabase anon key (public-safe).
 *   Per-customer auth is the device JWT, embedded in the payload — the
 *   Mac verifies it with `WAVEX_DEVICE_JWT_SECRET`. No channel-level RLS
 *   for v1.
 *
 * The tier-router responsibility (free vs paid) stays where it was:
 *   tier === "free" || !devicePaired   → local Pool A (oauth keychain)
 *   tier ∈ {founder, growth, custom}   → call cloudInference()
 */
import { randomUUID } from "node:crypto";
import { createClient, type RealtimeChannel } from "@supabase/supabase-js";
import { getValidAccessToken } from "./token-store.js";
import { loadConfig, type CloudConfig } from "./config.js";

export interface CloudInferenceRequest {
  prompt: string;
  model?: string;
  max_output_tokens?: number;
  /** Optional purpose tag for the cloud-side usage ledger. */
  purpose?: string;
  /** Optional request-correlation fields for Pool B accountability logs. */
  session_id?: string;
  conversation_id?: string;
  trace_id?: string;
  client_name?: string;
  client_version?: string;
  source?: string;
  context_input_tokens?: number;
  message_count?: number;
}

export interface CloudInferenceResponse {
  ok: true;
  content: string;
  model: string;
  request_id: string;
  provider?: string;
  provider_response_id?: string;
  fallback_used?: boolean;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cached_input_tokens: number;
    cost_usd: number;
    duration_ms: number;
  };
}

export interface CloudInferenceError {
  ok: false;
  /** Cloud-side error class. */
  error:
    | "no_paired_device"
    | "no_active_subscription"
    | "rate_limited"
    | "upstream_error"
    | "internal"
    | "timeout";
  message: string;
  /** The request_id that timed out / failed (for log correlation). */
  request_id?: string;
  /** When rate_limited: seconds to wait before retry. */
  retry_after?: number;
}

/** Extract the `sub` claim (Supabase user_id) from a device JWT without
 *  verifying the signature. cloud-client trusts what the cloud minted to
 *  it; the Mac side does the real verification. */
function extractSub(jwt: string): string {
  const parts = jwt.split(".");
  if (parts.length !== 3) {
    throw new Error("device JWT is malformed (expected 3 segments)");
  }
  const payloadB64 = parts[1]!;
  // base64url -> base64
  const normalized = payloadB64.replace(/-/g, "+").replace(/_/g, "/");
  const pad = normalized.length % 4 ? 4 - (normalized.length % 4) : 0;
  const json = Buffer.from(normalized + "=".repeat(pad), "base64").toString("utf8");
  let payload: { sub?: unknown };
  try {
    payload = JSON.parse(json) as { sub?: unknown };
  } catch {
    throw new Error("device JWT payload is not valid JSON");
  }
  if (typeof payload.sub !== "string" || !payload.sub) {
    throw new Error("device JWT is missing a string `sub` claim");
  }
  return payload.sub;
}

/**
 * Call the operator's Mac for an inference response. Returns a
 * discriminated union; ok=true means the response body is in `content`.
 *
 * Never throws on cloud-side business errors — those return
 * `{ ok: false, error: "..." }`. Throws only on:
 *   - missing device pairing (so the caller can prompt `wavex-os login`)
 *   - malformed device JWT
 *   - Realtime subscribe failure (transport-level)
 */
export async function cloudInference(
  req: CloudInferenceRequest,
  cfg?: CloudConfig,
): Promise<CloudInferenceResponse | CloudInferenceError> {
  const c = cfg ?? loadConfig();

  // Throws no_paired_device if missing. Single-flight refresh inside.
  const deviceJwt = await getValidAccessToken(c);
  const userId = extractSub(deviceJwt);

  const requestId = randomUUID();
  const requestTopic = `wavex-inference-request:${userId}`;
  const responseTopic = `wavex-inference-response:${userId}`;
  const eventName = "wavex-inference";

  // Anon-key client. realtime: { params: { eventsPerSecond } } is the
  // documented Realtime client knob; default is fine for a single
  // request/response round-trip.
  const supabase = createClient(c.supabaseUrl, c.supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { params: { eventsPerSecond: 10 } },
  });

  let responseChannel: RealtimeChannel | null = null;
  let requestChannel: RealtimeChannel | null = null;
  let resolved = false;

  try {
    // ----- Step 1: subscribe to the response channel BEFORE publishing.
    // This avoids the race where the Mac is fast enough to publish a
    // reply before our listener is wired up. supabase-js only allows one
    // subscribe() call per channel — its callback drives BOTH the
    // SUBSCRIBED handshake and the per-status terminal transitions, so
    // the same callback resolves the "channel is ready to publish"
    // promise and rejects the response promise on transport failure.
    responseChannel = supabase.channel(responseTopic, {
      config: { broadcast: { ack: false, self: false } },
    });

    let subscribedResolve!: () => void;
    let subscribedReject!: (err: Error) => void;
    const responseSubscribed = new Promise<void>((res, rej) => {
      subscribedResolve = res;
      subscribedReject = rej;
    });

    const responsePromise = new Promise<CloudInferenceResponse | CloudInferenceError>(
      (resolve, reject) => {
        const timer = setTimeout(() => {
          if (resolved) return;
          resolved = true;
          resolve({
            ok: false,
            error: "timeout",
            message: `no response from operator Mac within ${c.inferenceTimeoutMs}ms`,
            request_id: requestId,
          });
        }, c.inferenceTimeoutMs);

        responseChannel!.on("broadcast", { event: eventName }, ({ payload }) => {
          if (!payload || typeof payload !== "object") return;
          const p = payload as { request_id?: unknown };
          if (p.request_id !== requestId) return; // not ours
          if (resolved) return;
          resolved = true;
          clearTimeout(timer);
          resolve(payload as CloudInferenceResponse | CloudInferenceError);
        });

        responseChannel!.subscribe((status, err) => {
          if (status === "SUBSCRIBED") {
            subscribedResolve();
          } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
            const e = new Error(
              `realtime response channel ${status}: ${err?.message ?? "unknown"}`,
            );
            subscribedReject(e);
            if (resolved) return;
            resolved = true;
            clearTimeout(timer);
            reject(e);
          }
        });
      },
    );

    await responseSubscribed;

    // ----- Step 2: open + subscribe the request channel, then publish.
    requestChannel = supabase.channel(requestTopic, {
      config: { broadcast: { ack: false, self: false } },
    });
    await waitForSubscribed(requestChannel, c.inferenceTimeoutMs);

    const sendResult = await requestChannel.send({
      type: "broadcast",
      event: eventName,
      payload: {
        request_id: requestId,
        device_jwt: deviceJwt,
        prompt: req.prompt,
        model: req.model,
        max_output_tokens: req.max_output_tokens,
        purpose: req.purpose,
        session_id: req.session_id,
        conversation_id: req.conversation_id,
        trace_id: req.trace_id,
        client_name: req.client_name ?? "cloud-client",
        client_version: req.client_version,
        source: req.source ?? "cloud-client",
        context_input_tokens: req.context_input_tokens,
        message_count: req.message_count,
      },
    });
    if (sendResult !== "ok") {
      return {
        ok: false,
        error: "internal",
        message: `realtime publish returned status=${sendResult}`,
        request_id: requestId,
      };
    }

    // ----- Step 3: await the response (or timeout).
    return await responsePromise;
  } finally {
    // Always clean up. Order doesn't matter — both are best-effort.
    if (responseChannel) {
      try {
        await responseChannel.unsubscribe();
      } catch {
        // best-effort
      }
    }
    if (requestChannel) {
      try {
        await requestChannel.unsubscribe();
      } catch {
        // best-effort
      }
    }
    try {
      await supabase.removeAllChannels();
    } catch {
      // best-effort
    }
  }
}

/** Resolve once the channel reports SUBSCRIBED; reject on error/timeout. */
function waitForSubscribed(channel: RealtimeChannel, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`realtime channel did not reach SUBSCRIBED within ${timeoutMs}ms`));
    }, timeoutMs);

    // Trigger / observe subscription. supabase-js is idempotent — calling
    // subscribe() on an already-subscribed channel is safe.
    channel.subscribe((status, err) => {
      if (status === "SUBSCRIBED") {
        clearTimeout(timer);
        resolve();
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        clearTimeout(timer);
        reject(
          new Error(
            `realtime channel entered ${status}: ${err?.message ?? "unknown"}`,
          ),
        );
      }
    });
  });
}
