/** System action routes invoked by the System Health drawer's
 *  ACTION_REGISTRY when the daemon flags `requires_user_action` and the
 *  customer clicks the button. These are the "the customer never types a
 *  terminal command" handlers — each one performs a small, well-bounded
 *  action and triggers a daemon cycle so the UI reflects the new state.
 *
 *  Kept in a separate file from system-health.ts so a hot-reload save-loop
 *  on one doesn't bounce the other.
 *
 *    POST /api/system/discard-local-changes
 *       git stash --include-untracked (RECOVERABLE — not git reset).
 *       Stash label is `auto-discard-<iso-timestamp>` so the operator can
 *       `git stash list && git stash pop <ref>` to recover.
 *
 *    POST /api/system/restart-processes
 *       Mac: `launchctl kickstart -k` for the three known wavex-os labels.
 *       Other platforms: returns a clear "Refresh page" hint — UI maps it
 *       to a non-terminal-command action.
 *
 *    POST /api/system/pull-and-restart
 *       git stash-if-dirty + git pull --ff-only + pnpm install (background).
 *       This is the "Update now" magical-fix button — a customer can pull
 *       a fresh bug fix without touching the terminal. Same recoverable
 *       stash semantics as discard-local-changes.
 *
 *  Daemon is spawned non-blocking after each action so /api/system/health
 *  returns the updated state within ~5s of the click. */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import path from "node:path";
import { homedir, platform } from "node:os";
import { spawn, exec } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import { assertBoard, AuthError } from "@wavex-os/auth-shim";

const execAsync = promisify(exec);

/** Mirror of the authReq helper used by activate.ts — projects the Fastify
 *  request into the minimal shape the auth-shim gates read. In dev mode the
 *  gate auto-populates a synthetic local board actor (no-op for the local
 *  operator); in production it requires a real board actor. */
function authReq(req: FastifyRequest) {
  return { method: req.method, headers: req.headers as Record<string, string> };
}

/** Returns true and sends the error reply when the caller is NOT an
 *  authorized board actor. These handlers run git/launchctl/pnpm against the
 *  repo root, so an unauthenticated caller must never reach them. */
function denyIfNotBoard(req: FastifyRequest, reply: FastifyReply): boolean {
  try {
    assertBoard(authReq(req));
    return false;
  } catch (e) {
    if (e instanceof AuthError) {
      reply.status(e.statusCode).send({ ok: false, error: e.message });
      return true;
    }
    throw e;
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Walk up from packages/wavex-os-server/src/routes/ → repo root.
const REPO_ROOT = path.resolve(__dirname, "../../../..");
const DAEMON_SCRIPT =
  process.env.WAVEX_LOCAL_OPS_SCRIPT ??
  path.join(REPO_ROOT, "scripts/wavex-local-ops-cycle.mjs");

async function spawnDaemonRefresh(): Promise<boolean> {
  try {
    await fs.access(DAEMON_SCRIPT);
  } catch {
    return false;
  }
  const child = spawn(process.execPath, [DAEMON_SCRIPT], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child.pid != null;
}

export function registerSystemActionsRoute(app: FastifyInstance): void {
  app.post("/api/system/discard-local-changes", async (req, reply) => {
    if (denyIfNotBoard(req, reply)) return reply;
    try {
      const status = await execAsync("git status --porcelain", { cwd: REPO_ROOT });
      if (!status.stdout.trim()) {
        const refreshed = await spawnDaemonRefresh();
        return {
          ok: true,
          stashed: false,
          detail: "Working tree was already clean.",
          daemon_refreshed: refreshed,
        };
      }
      const ts = new Date().toISOString();
      const label = `auto-discard-${ts}`;
      const stash = await execAsync(
        `git stash push --include-untracked -m "${label}"`,
        { cwd: REPO_ROOT, maxBuffer: 10 * 1024 * 1024 },
      );
      const refreshed = await spawnDaemonRefresh();
      return {
        ok: true,
        stashed: true,
        stash_label: label,
        detail:
          stash.stdout.trim() ||
          "Local changes stashed. Run `git stash list` if you ever need to recover them.",
        daemon_refreshed: refreshed,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: "discard_failed",
        detail: msg.slice(0, 400),
      };
    }
  });

  app.post("/api/system/restart-processes", async (req, reply) => {
    if (denyIfNotBoard(req, reply)) return reply;
    const labels = [
      "com.wavex-os.mock-core",
      "com.wavex-os.wavex-os-server",
      "com.wavex-os.paperclip",
    ];
    if (platform() !== "darwin") {
      return {
        ok: false,
        error: "platform_unsupported",
        platform: platform(),
        detail:
          "Auto-restart on this platform isn't wired yet. If your dev server is stuck, " +
          "refresh this page — the daemon's process-health check will surface a clearer next step.",
        suggested_button: "Refresh page",
      };
    }
    const results: Record<string, "kicked" | "missing" | "failed"> = {};
    for (const label of labels) {
      try {
        await execAsync(`launchctl print gui/$UID/${label}`);
        try {
          await execAsync(`launchctl kickstart -k gui/$UID/${label}`);
          results[label] = "kicked";
        } catch {
          results[label] = "failed";
        }
      } catch {
        // Job not loaded under launchd — likely the customer is running via
        // `pnpm dev`, not as a system service. Not an error per se.
        results[label] = "missing";
      }
    }
    const refreshed = await spawnDaemonRefresh();
    return { ok: true, results, daemon_refreshed: refreshed };
  });

  app.post("/api/system/pull-and-restart", async (req, reply) => {
    if (denyIfNotBoard(req, reply)) return reply;
    let stashed = false;
    let stashLabel: string | null = null;
    try {
      const status = await execAsync("git status --porcelain", { cwd: REPO_ROOT });
      if (status.stdout.trim()) {
        stashLabel = `auto-pull-${new Date().toISOString()}`;
        await execAsync(
          `git stash push --include-untracked -m "${stashLabel}"`,
          { cwd: REPO_ROOT, maxBuffer: 10 * 1024 * 1024 },
        );
        stashed = true;
      }
    } catch (err) {
      return {
        ok: false,
        error: "stash_failed",
        detail: err instanceof Error ? err.message : String(err),
      };
    }

    let pulled = "";
    try {
      const r = await execAsync("git pull --ff-only", { cwd: REPO_ROOT, maxBuffer: 10 * 1024 * 1024 });
      pulled = r.stdout.trim() || r.stderr.trim();
    } catch (err) {
      return {
        ok: false,
        step: "git_pull",
        stashed,
        stash_label: stashLabel,
        error: "pull_failed",
        detail: err instanceof Error ? err.message : String(err),
      };
    }

    const installPid = (() => {
      try {
        const child = spawn("pnpm", ["install", "--frozen-lockfile"], {
          cwd: REPO_ROOT,
          detached: true,
          stdio: "ignore",
        });
        child.unref();
        return child.pid ?? null;
      } catch {
        return null;
      }
    })();

    const refreshed = await spawnDaemonRefresh();
    return {
      ok: true,
      stashed,
      stash_label: stashLabel,
      pulled: pulled.slice(0, 400),
      install_pid: installPid,
      daemon_refreshed: refreshed,
      detail:
        "Pulled latest. Background install started — refresh the page in ~30s to use the new code.",
    };
  });
}
