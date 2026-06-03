/** Abandoned booking recovery manual trigger (WAVAAAA-1200).
 *
 *  POST /api/booking/recovery/run
 *    Board-only trigger that fires runAbandonedBookingRecoveryJob once.
 *    Safe: job is idempotent via the unique (intent_id) nudge log constraint.
 *    Useful for manually re-running after enabling WAVEX_ABANDONED_BOOKING_DRY_RUN=false.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { assertBoard, AuthError } from "@wavex-os/auth-shim";
import { runAbandonedBookingRecoveryJob } from "../jobs/abandoned-booking-recovery.js";

function authReq(req: FastifyRequest) {
  return { method: req.method, headers: req.headers as Record<string, string> };
}

export function registerBookingRecoveryRoute(app: FastifyInstance): void {
  app.post(
    "/api/booking/recovery/run",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const ar = authReq(req);
      try {
        assertBoard(ar);
      } catch (e) {
        if (e instanceof AuthError) return reply.status(e.statusCode).send({ error: e.message });
        throw e;
      }
      try {
        const result = await runAbandonedBookingRecoveryJob();
        return { ok: true, ...result };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return reply.status(500).send({ ok: false, error: msg });
      }
    },
  );
}
