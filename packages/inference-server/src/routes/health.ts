import type { FastifyInstance } from "fastify";

// Mount the same payload on three paths: the original versioned `/v1/health`,
// plus `/health` and `/api/health` as the conventional unauthenticated
// readiness probes. Cloudflare Tunnel, kubectl-style liveness checks, and
// the WaveX Ops cycle all hit `/health` by default — the E2E QA flagged
// all three as 404s. Aliasing is cheaper than redirecting and avoids the
// extra hop in monitoring tooling.
const HEALTH_PAYLOAD = {
  status: "ok",
  service: "wavex-inference-server",
  version: "0.1.0",
  pools: ["A", "B", "C"],
} as const;

export async function registerHealth(app: FastifyInstance): Promise<void> {
  const handler = async () => HEALTH_PAYLOAD;
  app.get("/v1/health", handler);
  app.get("/health", handler);
  app.get("/api/health", handler);
}
