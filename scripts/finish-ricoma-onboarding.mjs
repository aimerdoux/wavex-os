#!/usr/bin/env node
/** Resume the Ricoma onboarding from where the earlier run left off.
 *  Skips already-committed phases (pillar 1-5, connector + swarm) and
 *  retries workflow with bypassBudgetCheck (we have no budget plugin
 *  running in dev), then walks credential concierge, finalize, activate. */

const BASE = process.env.WAVEX_API_BASE ?? "http://127.0.0.1:3101";
const PAPERCLIP_BASE = process.env.PAPERCLIP_API_BASE ?? "http://127.0.0.1:3100";
const COMPANY_ID = "ricoma-live-001";

async function post(path, body, label) {
  const t0 = Date.now();
  const r = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const ms = Date.now() - t0;
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { _raw: text.slice(0, 400) }; }
  console.log(`  ${label.padEnd(28)} ${r.status} (${ms}ms)`);
  if (!r.ok) {
    console.error("    error:", JSON.stringify(json).slice(0, 500));
    process.exit(1);
  }
  return json;
}

async function get(path, label) {
  const r = await fetch(`${BASE}${path}`);
  const json = await r.json();
  console.log(`  ${label.padEnd(28)} ${r.status}`);
  return json;
}

console.log("\n=== Ricoma resume — workflow + credentials + finalize + activate ===\n");

console.log("Phase 4 — workflow manifest (real T2, bypass budget plugin)…");
const wf = await post(
  "/op-omega/onboarding/workflow-manifest",
  { companyId: COMPANY_ID, bypassBudgetCheck: true },
  "workflow-manifest",
);
const wfCount = Object.keys(wf.manifest?.agent_workflows ?? {}).length;
console.log("    agents with workflows:", wfCount);

console.log("\nCredential Concierge — skipping all (no real OAuth this run)…");
const credList = await get(
  `/op-omega/onboarding/credentials/${encodeURIComponent(COMPANY_ID)}`,
  "list credentials",
);
const required = (credList.connectors ?? []).filter((c) => c.bucket === "required");
console.log(`    ${required.length} required connectors`);
for (const c of required) {
  if (c.status === "vaulted_valid" || c.status === "skipped") continue;
  await post(
    "/op-omega/onboarding/credentials/skip",
    {
      companyId: COMPANY_ID,
      connectorId: c.connectorId,
      reason: "ricoma demo — credentials deferred",
    },
    `skip ${c.connectorId}`,
  );
}

console.log("\nFinalize (Monte Carlo strategy pick + signed manifest)…");
const fin = await post(
  "/op-omega/onboarding/finalize",
  {
    companyId: COMPANY_ID,
    orgId: COMPANY_ID,
    mc: { horizon_cycles: 6, n_runs: 8, seed: 42 },
  },
  "finalize",
);
console.log("    sha256:", fin.sha256?.slice(0, 32), "…");
console.log("    winning strategy:", fin.manifest?.mc_winner?.strategy_id);

console.log("\nActivate → bridge to Paperclip (hires agents)…");
const act = await post(
  `/api/instance/${encodeURIComponent(COMPANY_ID)}/activate`,
  {},
  "activate",
);
console.log("    paperclipCompanyId:", act.paperclipCompanyId ?? "(missing)");
console.log("    hired:", (act.report?.created ?? []).length);
console.log("    skipped:", (act.report?.skipped ?? []).length);
console.log("    errors:", (act.report?.errors ?? []).length);
if ((act.report?.errors ?? []).length > 0) {
  console.log("    first error:", JSON.stringify(act.report.errors[0]).slice(0, 300));
}

console.log("\n=== DONE ===");
console.log(`  Open Paperclip:  ${PAPERCLIP_BASE.replace("3100", "5174")}`);
console.log(`  Switch to:       Ricoma`);
console.log(`  Paperclip companyId: ${act.paperclipCompanyId}`);
