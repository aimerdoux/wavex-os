/** Device-pairing routes for the Pool B Health widget.
 *
 *  Lets the operator pair this Mac to their wavexcard.com account from
 *  inside Mission Control instead of switching to a terminal `wavex-os
 *  login`. Wraps @wavex-os/cloud-client's RFC-8628 device flow:
 *
 *    POST /api/pool-b-health/pair-start
 *      → startPairing() → { user_code, verification_url }
 *      → kicks off pollForToken() in the background; on claim, writes the
 *        token bundle to ~/.wavex-os/device-token.json (same as the CLI).
 *
 *    GET  /api/pool-b-health/pair-status
 *      → { phase: "idle"|"pending"|"paired"|"error", user_code?,
 *          verification_url?, user_id?, device_id?, error? }
 *
 *  Auth: board-only — pairing binds the operator's own account/plan to
 *  this machine, so it must never be reachable customer-tier.
 *
 *  Only one pairing runs at a time. Starting a new one supersedes any
 *  in-flight attempt (the prior poll loop is abandoned; its result is
 *  ignored because `activeDeviceCode` no longer matches). */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { assertBoard, AuthError } from "@wavex-os/auth-shim";
import { startPairing, pollForToken } from "@wavex-os/cloud-client/login";
import { writeBundle } from "@wavex-os/cloud-client/token-store";
import { loadConfig } from "@wavex-os/cloud-client/config";

type PairPhase = "idle" | "pending" | "paired" | "error";

interface PairState {
  phase: PairPhase;
  user_code?: string;
  verification_url?: string;
  user_id?: string;
  device_id?: string;
  error?: string;
  /** Wall-clock ms when this pairing was started — lets the UI show a
   *  countdown and lets us treat very old "pending" state as stale. */
  started_at?: number;
}

// Single in-flight pairing. The Mac pairs once; re-pairing replaces it.
let state: PairState = { phase: "idle" };
// The device_code of the poll loop allowed to write final state. A newer
// pair-start bumps this so a stale loop's late resolution is ignored.
let activeDeviceCode: string | null = null;

function authReq(req: FastifyRequest) {
  return { method: req.method, headers: req.headers as Record<string, string> };
}

export function registerDevicePairingRoutes(app: FastifyInstance): void {
  app.post("/api/pool-b-health/pair-start", async (req, reply) => {
    const ar = authReq(req);
    try { assertBoard(ar); } catch (e) {
      if (e instanceof AuthError) return reply.status(e.statusCode).send({ error: e.message });
      throw e;
    }

    const cfg = loadConfig();
    let linked;
    try {
      linked = await startPairing(cfg);
    } catch (err) {
      state = { phase: "error", error: err instanceof Error ? err.message : String(err), started_at: Date.now() };
      return reply.status(502).send({ ok: false, error: state.error });
    }

    const verificationUrl =
      linked.verification_url ?? `${cfg.consoleUrl}?code=${encodeURIComponent(linked.user_code)}`;

    activeDeviceCode = linked.device_code;
    state = {
      phase: "pending",
      user_code: linked.user_code,
      verification_url: verificationUrl,
      started_at: Date.now(),
    };

    // Poll in the background; do not block the response. The UI polls
    // /pair-status. We guard every write on `activeDeviceCode` so a newer
    // pairing supersedes this loop cleanly.
    const thisDeviceCode = linked.device_code;
    void (async () => {
      try {
        const bundle = await pollForToken(thisDeviceCode, {
          intervalMs: (linked.interval ?? 2) * 1_000,
          cfg,
        });
        if (activeDeviceCode !== thisDeviceCode) return; // superseded
        await writeBundle(
          {
            access_token: bundle.access_token,
            refresh_token: bundle.refresh_token,
            access_token_expires_at: bundle.access_token_expires_at,
            obtained_at: Math.floor(Date.now() / 1000),
            user_id: bundle.user_id,
            device_id: bundle.device_id,
          },
          cfg,
        );
        state = {
          phase: "paired",
          user_id: bundle.user_id,
          device_id: bundle.device_id,
          started_at: state.started_at,
        };
      } catch (err) {
        if (activeDeviceCode !== thisDeviceCode) return; // superseded
        state = {
          phase: "error",
          error: err instanceof Error ? err.message : String(err),
          started_at: state.started_at,
        };
      }
    })();

    return { ok: true, user_code: state.user_code, verification_url: state.verification_url };
  });

  app.get("/api/pool-b-health/pair-status", async (req, reply) => {
    const ar = authReq(req);
    try { assertBoard(ar); } catch (e) {
      if (e instanceof AuthError) return reply.status(e.statusCode).send({ error: e.message });
      throw e;
    }
    return { ok: true, ...state };
  });
}
