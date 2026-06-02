/**
 * Standalone economics-refresh script (Option B — no server restart).
 *
 * Writes CURRENT_ECONOMICS.md to every agent's instructions dir for the given
 * company. Mirrors the logic in paperclip/server/src/services/maintenance-service.ts
 * (refreshAgentEconomicsFiles / computeFleetEconomics / renderAgentEconomicsMarkdown)
 * but runs as a standalone read-only script against the embedded PostgreSQL that
 * the live server is already using — no HTTP route, no server restart needed.
 *
 * Usage:
 *   tsx scripts/refresh-agent-economics.ts [--company <companyId>]
 *
 * Defaults to COMPANY_ID constant below when --company is omitted.
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createDb } from "../packages/db/src/index.js";
import { loadConfig } from "../server/src/config.js";

// Default company — override via --company flag or PAPERCLIP_COMPANY_ID env var.
const DEFAULT_COMPANY_ID = "b515f8b2-0976-4838-b8a9-c08d430d8177";

// Token rates in cents per million tokens (mirrors maintenance-service.ts).
const TOKEN_RATES_CENTS_PER_MTOK: Record<string, { input: number; cached: number; output: number }> = {
  "claude-opus-4-7": { input: 1500, cached: 150, output: 7500 },
  "claude-opus-4-7[1m]": { input: 1500, cached: 150, output: 7500 },
  "claude-opus-4-6": { input: 1500, cached: 150, output: 7500 },
  "claude-sonnet-4-6": { input: 300, cached: 30, output: 1500 },
  "claude-sonnet-4-5": { input: 300, cached: 30, output: 1500 },
  "claude-haiku-4-5-20251001": { input: 80, cached: 8, output: 400 },
  default: { input: 1500, cached: 150, output: 7500 },
};

function tokenRateFor(model: string | null): { input: number; cached: number; output: number } {
  if (!model) return TOKEN_RATES_CENTS_PER_MTOK.default;
  return TOKEN_RATES_CENTS_PER_MTOK[model] ?? TOKEN_RATES_CENTS_PER_MTOK.default;
}

type AgentEconomics = {
  agentId: string;
  name: string;
  role: string | null;
  model: string | null;
  runs24h: number;
  done24h: number;
  comments24h: number;
  outputTokens24h: number;
  cachedTokens24h: number;
  inputTokens24h: number;
  burnCents24h: number;
  fleetBurnCents24h: number;
  fleetSharePct: number;
  costPerDoneCents: number | null;
  costPerCommentCents: number | null;
  rank: number;
  totalAgents: number;
};

type RawRow = {
  agent_id: string;
  name: string;
  role: string | null;
  model: string | null;
  runs_24h: number;
  done_24h: number;
  comments_24h: number;
  output_tokens_24h: number | null;
  cached_tokens_24h: number | null;
  input_tokens_24h: number | null;
};

async function computeFleetEconomics(db: ReturnType<typeof createDb>, companyId: string): Promise<AgentEconomics[]> {
  // Use the underlying postgres.js client for raw parameterised SQL — drizzle-orm
  // is not a direct dep of this scripts package so we can't import its `sql` tag.
  const pgSql = (db as unknown as { $client: (strings: TemplateStringsArray, ...values: unknown[]) => Promise<RawRow[]> }).$client;
  const rows = await pgSql`
    WITH agent_runs AS (
      SELECT agent_id, COUNT(*) AS runs FROM heartbeat_runs
      WHERE company_id=${companyId} AND finished_at > NOW() - INTERVAL '24 hours'
      GROUP BY agent_id
    ),
    agent_tokens AS (
      SELECT agent_id,
             SUM(output_tokens) AS output_tokens,
             SUM(cached_input_tokens) AS cached_tokens,
             SUM(input_tokens) AS input_tokens
      FROM cost_events
      WHERE company_id=${companyId} AND occurred_at > NOW() - INTERVAL '24 hours'
      GROUP BY agent_id
    ),
    agent_done AS (
      SELECT assignee_agent_id AS agent_id, COUNT(*) AS done
      FROM issues
      WHERE company_id=${companyId} AND completed_at > NOW() - INTERVAL '24 hours' AND status='done'
      GROUP BY assignee_agent_id
    ),
    agent_comments AS (
      SELECT author_agent_id AS agent_id, COUNT(*) AS comments
      FROM issue_comments
      WHERE company_id=${companyId} AND created_at > NOW() - INTERVAL '24 hours' AND author_agent_id IS NOT NULL
      GROUP BY author_agent_id
    )
    SELECT
      a.id AS agent_id,
      a.name,
      a.role,
      a.adapter_config->>'model' AS model,
      COALESCE(ar.runs, 0)::int AS runs_24h,
      COALESCE(ad.done, 0)::int AS done_24h,
      COALESCE(ac.comments, 0)::int AS comments_24h,
      COALESCE(at.output_tokens, 0)::bigint AS output_tokens_24h,
      COALESCE(at.cached_tokens, 0)::bigint AS cached_tokens_24h,
      COALESCE(at.input_tokens, 0)::bigint AS input_tokens_24h
    FROM agents a
    LEFT JOIN agent_runs ar ON ar.agent_id=a.id
    LEFT JOIN agent_tokens at ON at.agent_id=a.id
    LEFT JOIN agent_done ad ON ad.agent_id=a.id
    LEFT JOIN agent_comments ac ON ac.agent_id=a.id
    WHERE a.company_id=${companyId} AND a.status NOT IN ('terminated')
  `;

  const list = rows.map((r) => {
    const rates = tokenRateFor(r.model);
    const out = Number(r.output_tokens_24h ?? 0);
    const cache = Number(r.cached_tokens_24h ?? 0);
    const inp = Number(r.input_tokens_24h ?? 0);
    const burnCents = (out * rates.output + cache * rates.cached + inp * rates.input) / 1_000_000;
    return {
      agentId: r.agent_id,
      name: r.name,
      role: r.role,
      model: r.model,
      runs24h: Number(r.runs_24h),
      done24h: Number(r.done_24h),
      comments24h: Number(r.comments_24h),
      outputTokens24h: out,
      cachedTokens24h: cache,
      inputTokens24h: inp,
      burnCents24h: Math.round(burnCents * 100) / 100,
      fleetBurnCents24h: 0,
      fleetSharePct: 0,
      costPerDoneCents: r.done_24h ? Math.round((burnCents / Number(r.done_24h)) * 100) / 100 : null,
      costPerCommentCents: r.comments_24h ? Math.round((burnCents / Number(r.comments_24h)) * 100) / 100 : null,
      rank: 0,
      totalAgents: 0,
    };
  });

  const fleetBurnCents = list.reduce((acc, a) => acc + a.burnCents24h, 0);
  list.sort((a, b) => b.burnCents24h - a.burnCents24h);
  list.forEach((a, i) => {
    a.rank = i + 1;
    a.totalAgents = list.length;
    a.fleetBurnCents24h = Math.round(fleetBurnCents * 100) / 100;
    a.fleetSharePct = fleetBurnCents > 0 ? Math.round((a.burnCents24h / fleetBurnCents) * 1000) / 10 : 0;
  });
  return list;
}

const usd = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

function renderAgentEconomicsMarkdown(econ: AgentEconomics): string {
  const verbosity =
    econ.outputTokens24h > 0 && econ.cachedTokens24h > 0
      ? (econ.outputTokens24h / econ.cachedTokens24h).toFixed(3)
      : "n/a";
  const dollarsPerDone = econ.costPerDoneCents !== null ? usd(econ.costPerDoneCents) : "n/a (0 done)";
  const dollarsPerComment = econ.costPerCommentCents !== null ? usd(econ.costPerCommentCents) : "n/a (0 comments)";
  const flag = econ.fleetSharePct > 15 ? "⚠️ TOP BURNER" : econ.fleetSharePct > 8 ? "● heavy" : "";
  return `# CURRENT_ECONOMICS — ${econ.name}

**Window:** rolling 24h.
**Computed:** ${new Date().toISOString()}
**Model:** \`${econ.model ?? "(default)"}\`

## Your numbers

| Metric | Value |
|---|---|
| Heartbeat runs | ${econ.runs24h} |
| Issues closed | ${econ.done24h} |
| Comments posted | ${econ.comments24h} |
| Output tokens | ${econ.outputTokens24h.toLocaleString()} |
| Cache tokens | ${econ.cachedTokens24h.toLocaleString()} |
| Input tokens | ${econ.inputTokens24h.toLocaleString()} |
| **Imputed burn** | **${usd(econ.burnCents24h)}** |
| **$ per closed issue** | **${dollarsPerDone}** |
| **$ per comment** | **${dollarsPerComment}** |
| Output:cache ratio (verbosity) | ${verbosity} |

## Your share of the fleet

- **Rank #${econ.rank} of ${econ.totalAgents}** by 24h burn ${flag}
- Your share: **${econ.fleetSharePct}%** of fleet (fleet total: ${usd(econ.fleetBurnCents24h)})

## Token-cost ladder (Anthropic API rates, model: ${econ.model ?? "default"})

For Opus 4.7: input \`$15/Mtok\` · cached \`$1.50/Mtok\` · output \`$75/Mtok\`.
**Output tokens cost 50× cache reads.** Verbosity is your single biggest cost lever.

## Self-regulation rules (per SKILL_ECONOMIC_SELF_AWARENESS)

1. **If your share > 15% OR $/done > $50:** this heartbeat MUST end with a delegate/kill/approve/escalate artifact, not a comment. (Same as SKILL_DELEGATE_OR_KILL.)
2. **If your output:cache ratio > 0.05** (you're producing fresh content faster than reusing cached): summarize aggressively, link to existing artifacts instead of restating, prefer 1-line decisions over multi-paragraph rationale.
3. **If you have 0 closed issues in 24h** with > 30 runs: you are spinning. Either close one this heartbeat or escalate the blocker to the board.
4. **Never restate ground-truth that's already in a comment thread.** Link to the prior comment by deep-link, don't recap. Each restatement costs your output tokens × 50.

## What "good" looks like

- Burn share < 5% AND ≥ 1 closed issue per day → you're producing leverage.
- Output:cache < 0.02 AND comments :: closures ratio < 5:1 → you're concise and decisive.
- Cost per done < $20 → you're efficient.
`;
}

async function refreshAgentEconomicsFiles(
  db: ReturnType<typeof createDb>,
  companyId: string,
): Promise<{ written: number; failed: Array<{ agentId: string; name: string; error: string }>; fleetBurnCents: number }> {
  const fleet = await computeFleetEconomics(db, companyId);
  const failed: Array<{ agentId: string; name: string; error: string }> = [];
  let written = 0;
  for (const econ of fleet) {
    const dir = path.join(
      homedir(),
      ".paperclip",
      "instances",
      "default",
      "companies",
      companyId,
      "agents",
      econ.agentId,
      "instructions",
    );
    try {
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, "CURRENT_ECONOMICS.md"), renderAgentEconomicsMarkdown(econ), "utf8");
      written++;
    } catch (err) {
      failed.push({
        agentId: econ.agentId,
        name: econ.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { written, failed, fleetBurnCents: fleet[0]?.fleetBurnCents24h ?? 0 };
}

function parseFlag(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

async function main() {
  const config = loadConfig();
  const dbUrl =
    process.env.DATABASE_URL?.trim() ||
    config.databaseUrl ||
    `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`;

  const companyId =
    parseFlag("--company") ||
    process.env.PAPERCLIP_COMPANY_ID?.trim() ||
    DEFAULT_COMPANY_ID;

  const db = createDb(dbUrl);

  console.log(`Refreshing economics for company ${companyId} …`);
  const result = await refreshAgentEconomicsFiles(db, companyId);

  if (result.failed.length > 0) {
    console.error("Failed to write some files:");
    for (const f of result.failed) {
      console.error(`  ${f.agentId} (${f.name}): ${f.error}`);
    }
  }

  console.log(
    `Written: ${result.written}  Failed: ${result.failed.length}  Fleet burn 24h: ${usd(result.fleetBurnCents)}`,
  );

  if (result.failed.length > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
