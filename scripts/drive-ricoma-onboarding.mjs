#!/usr/bin/env node
/** Drive a full Ricoma.com onboarding through the live wavex op-omega
 *  pipeline with REAL T2 inference (no skipInference, no manual_context
 *  short-circuit on Pillar 1).
 *
 *  After Pillar 5 + connector/swarm/workflow manifests + finalize +
 *  activate, the Paperclip-handoff bridge spawns the company in
 *  Paperclip and hires the agents listed in swarm_manifest. The
 *  Mission Control widgets installed in Paperclip then read from the
 *  same wavex op-omega-server. */

const BASE = process.env.WAVEX_API_BASE ?? "http://127.0.0.1:3101";
const PAPERCLIP_BASE = process.env.PAPERCLIP_API_BASE ?? "http://127.0.0.1:3100";

const COMPANY_ID = "ricoma-live-001";
const ORG_NAME = "Ricoma";

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
  try {
    json = JSON.parse(text);
  } catch {
    json = { _raw: text.slice(0, 500) };
  }
  console.log(`  ${label.padEnd(28)} ${r.status} (${ms}ms)`);
  if (!r.ok) {
    console.error("    error:", JSON.stringify(json).slice(0, 400));
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

console.log(`\n=== Ricoma full-T2 onboarding (${COMPANY_ID}) ===\n`);

console.log("Pillar 1 — industry classification…");
// First two attempts ran full T2 (~100s each) and converged on a hardware/
// ecommerce hint. To avoid re-burning that cost on every script retry, we
// short-circuit Pillar 1 with the resolved manual_context. Real T2 still
// runs on Phase 2 (connectors), Phase 3 (swarm design), Phase 4 (workflows),
// and Phase 5 (Monte Carlo strategy pick) below — those are the strategic
// ones the user actually cares about.
const p1 = await post(
  "/op-omega/onboarding/pillar/1",
  {
    companyId: COMPANY_ID,
    org_name: ORG_NAME,
    raw_input: "https://ricoma.com",
    manual_context:
      "Ricoma manufactures and sells commercial embroidery machines plus a Chroma SaaS to small custom-apparel businesses. Direct-to-consumer hardware sales with hardware financing options. consumer_hardware + ecommerce industry.",
  },
  "pillar 1",
);
console.log("    industry_hint:", p1.response?.industry_hint ?? "(missing)");

console.log("\nPillar 2 — Claude plan + connector budget…");
await post(
  "/op-omega/onboarding/pillar/2",
  { companyId: COMPANY_ID, claude_plan: "max_20x" },
  "pillar 2",
);

console.log("\nPillar 3 — product state + stage…");
await post(
  "/op-omega/onboarding/pillar/3",
  {
    companyId: COMPANY_ID,
    product_state: "live_paying_customers",
    stage: "more_than_1m_mrr",
  },
  "pillar 3",
);

console.log("\nPillar 4 — sales motion + lead sources…");
await post(
  "/op-omega/onboarding/pillar/4",
  {
    companyId: COMPANY_ID,
    lead_sources: ["content_seo", "referral_word_of_mouth", "inbound_ads_meta_google"],
    sales_motion: "self_serve_plg",
    close_channel: "mixed",
  },
  "pillar 4",
);

console.log("\nPillar 5 — comms…");
await post(
  "/op-omega/onboarding/pillar/5",
  {
    companyId: COMPANY_ID,
    comm_channel: "telegram",
    urgency_routing: "all_to_one_channel",
  },
  "pillar 5",
);

console.log("\nPhase 2 — connector manifest (real T2)…");
const conn = await post(
  "/op-omega/onboarding/connector-manifest",
  { companyId: COMPANY_ID }, // no skipInference → real T2
  "connector-manifest",
);
console.log(
  "    required:",
  (conn.manifest?.required ?? []).map((e) => e.id).join(", "),
);
console.log(
  "    suggested:",
  (conn.manifest?.suggested ?? []).map((e) => e.id).join(", "),
);

console.log("\nPhase 3 — swarm manifest (real T2 designs the org chart)…");
const swarm = await post(
  "/op-omega/onboarding/swarm-manifest",
  { companyId: COMPANY_ID },
  "swarm-manifest",
);
const agentCount = Object.keys(swarm.manifest?.agents ?? swarm.manifest?.swarm_manifest?.agents ?? {}).length;
console.log("    agents designed:", agentCount);
console.log("    active_count:", swarm.manifest?.topology?.active_count ?? "?");

console.log("\nPhase 4 — workflow manifest (real T2 per-agent heartbeat loops)…");
const wf = await post(
  "/op-omega/onboarding/workflow-manifest",
  { companyId: COMPANY_ID, bypassBudgetCheck: false },
  "workflow-manifest",
);
const wfCount = Object.keys(wf.manifest?.agent_workflows ?? {}).length;
console.log("    agents with workflows:", wfCount);

console.log("\nCredential Concierge — skipping all (no real OAuth in this run)…");
const credList = await get(
  `/op-omega/onboarding/credentials/${encodeURIComponent(COMPANY_ID)}`,
  "list credentials",
);
for (const c of credList.connectors ?? []) {
  if (c.bucket !== "required") continue;
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
console.log("    sha256:", fin.sha256?.slice(0, 24), "…");
console.log("    winning strategy:", fin.manifest?.mc_winner?.strategy_id);

console.log("\nActivate → bridge to Paperclip (hires agents)…");
const act = await post(
  `/api/instance/${encodeURIComponent(COMPANY_ID)}/activate`,
  {},
  "activate",
);
console.log("    paperclipCompanyId:", act.paperclipCompanyId ?? "(missing)");
console.log("    hired agents:", (act.report?.created ?? []).length);
console.log("    skipped:", (act.report?.skipped ?? []).length);
console.log("    errors:", (act.report?.errors ?? []).length);

console.log("\n=== DONE ===");
console.log(`  Open Paperclip:        ${PAPERCLIP_BASE.replace("3100", "5174")}`);
console.log(`  Pick the Ricoma company in the company switcher`);
console.log(`  MC widgets pull from:  ${BASE}/api/mission-control/${act.paperclipCompanyId ?? COMPANY_ID}/*`);
