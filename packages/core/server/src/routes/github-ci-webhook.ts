import { Router, type Request, type Response } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { authUsers, companyMemberships } from "@paperclipai/db";

import { activationEventsService } from "../services/activation-events.js";

// GitHub workflow_run conclusion → internal status
const CONCLUSION_MAP: Record<string, string> = {
  success: "success",
  failure: "failure",
  cancelled: "cancelled",
  timed_out: "failure",
  action_required: "failure",
  neutral: "failure",
  skipped: "cancelled",
};

function verifyGitHubSignature(secret: string, body: Buffer, sig256: string | undefined): boolean {
  if (!sig256) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  try {
    return timingSafeEqual(Buffer.from(sig256), Buffer.from(expected));
  } catch {
    return false;
  }
}

// Infer platform from repo name or workflow name heuristics.
function inferPlatform(repoName: string, workflowName: string): string {
  const text = `${repoName} ${workflowName}`.toLowerCase();
  if (text.includes("ios") && text.includes("android")) return "both";
  if (text.includes("ios")) return "ios";
  if (text.includes("android")) return "android";
  return "unknown";
}

export function githubCiWebhookRoutes(db: Db) {
  const router = Router();
  const activation = activationEventsService(db);

  // POST /api/webhooks/github-ci/:companyId
  //
  // GitHub must be configured with:
  //   Payload URL: https://<host>/api/webhooks/github-ci/<companyId>
  //   Content type: application/json
  //   Secret: value of GITHUB_WEBHOOK_SECRET env var
  //   Events: Workflow runs
  router.post("/:companyId", async (req: Request, res: Response) => {
    const companyId = firstParamValue(req.params.companyId);
    if (!companyId) {
      res.status(400).json({ error: "missing companyId" });
      return;
    }
    const event = req.headers["x-github-event"] as string | undefined;
    const secret = process.env.GITHUB_WEBHOOK_SECRET;

    if (secret) {
      const rawBody: Buffer = (req as Request & { rawBody?: Buffer }).rawBody ?? Buffer.from(JSON.stringify(req.body));
      const sig = req.headers["x-hub-signature-256"] as string | undefined;
      if (!verifyGitHubSignature(secret, rawBody, sig)) {
        res.status(401).json({ error: "invalid signature" });
        return;
      }
    }

    // Only handle workflow_run events
    if (event !== "workflow_run") {
      res.status(200).json({ ok: true, skipped: true });
      return;
    }

    const payload = req.body as GitHubWorkflowRunPayload;
    const run = payload.workflow_run;
    if (!run) {
      res.status(400).json({ error: "missing workflow_run" });
      return;
    }

    // Resolve the user_id from the GitHub login via company membership.
    // Falls back to a synthetic id when no match (still records the event).
    const userId = await resolveUserId(db, companyId, run.actor?.login);
    const repo = payload.repository?.full_name ?? "unknown/unknown";
    const platform = inferPlatform(repo, run.name ?? "");
    const runId = String(run.id);
    const startedAt = run.run_started_at ? new Date(run.run_started_at) : undefined;
    const updatedAt = run.updated_at ? new Date(run.updated_at) : undefined;

    if (payload.action === "in_progress") {
      await activation.testRunStarted(companyId, userId, {
        run_id: runId,
        repo,
        platform,
      }, startedAt);
    } else if (payload.action === "completed") {
      const conclusion = CONCLUSION_MAP[run.conclusion ?? ""] ?? "failure";
      const durationS =
        startedAt && updatedAt
          ? Math.round((updatedAt.getTime() - startedAt.getTime()) / 1000)
          : 0;

      // Look up user's created_at for the 48h activation window.
      const userCreatedAt = await resolveUserCreatedAt(db, userId);

      await activation.testRunCompleted(companyId, userId, {
        run_id: runId,
        status: conclusion,
        duration_s: durationS,
        platform,
        completedAt: updatedAt,
        userCreatedAt,
      });
    }

    res.status(200).json({ ok: true });
  });

  return router;
}

async function resolveUserId(db: Db, companyId: string, githubLogin: string | undefined): Promise<string> {
  if (!githubLogin) return `gh-unknown@${companyId}`;

  // Look for a company member whose name or email matches the GitHub login.
  const members = await db
    .select({ userId: companyMemberships.principalId })
    .from(companyMemberships)
    .where(eq(companyMemberships.companyId, companyId))
    .limit(50);

  for (const m of members) {
    const user = await db
      .select({ id: authUsers.id, name: authUsers.name, email: authUsers.email })
      .from(authUsers)
      .where(eq(authUsers.id, m.userId))
      .limit(1)
      .then((r) => r[0]);

    if (!user) continue;
    if (
      user.name?.toLowerCase() === githubLogin.toLowerCase() ||
      user.email?.toLowerCase().startsWith(githubLogin.toLowerCase())
    ) {
      return user.id;
    }
  }

  // No match — use a stable synthetic id so events can still be queried.
  return `gh:${githubLogin}@${companyId}`;
}

async function resolveUserCreatedAt(db: Db, userId: string): Promise<Date | undefined> {
  if (userId.startsWith("gh:")) return undefined;
  const row = await db
    .select({ createdAt: authUsers.createdAt })
    .from(authUsers)
    .where(eq(authUsers.id, userId))
    .limit(1)
    .then((r) => r[0]);
  return row?.createdAt ?? undefined;
}

// Minimal GitHub webhook payload types
interface GitHubWorkflowRunPayload {
  action: "requested" | "in_progress" | "completed";
  workflow_run: {
    id: number;
    name?: string;
    conclusion?: string | null;
    run_started_at?: string;
    updated_at?: string;
    actor?: { login: string };
  };
  repository?: { full_name: string };
}

function firstParamValue(value: string | string[] | undefined): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (Array.isArray(value)) return value.find((item) => item.length > 0) ?? null;
  return null;
}
