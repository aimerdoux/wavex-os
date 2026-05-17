import { getDb, missionControlEvents, deliverables, assignmentLinks, expectedKpiImpacts } from "@wavex-os/db";

const db = await getDb();
const ev = await db.select().from(missionControlEvents).limit(5);
const dl = await db.select().from(deliverables).limit(5);
const al = await db.select().from(assignmentLinks).limit(5);
const kp = await db.select().from(expectedKpiImpacts).limit(5);
console.log(`mission_control_events: ${ev.length} rows (showing first 5)`);
for (const r of ev) console.log("  ", r.kind, r.companyId, r.action);
console.log(`\ndeliverables: ${dl.length} rows`);
for (const r of dl) console.log("  ", r.kind, r.companyId, r.title);
console.log(`\nassignment_links: ${al.length} rows`);
for (const r of al) console.log("  ", r.kind, r.companyId, r.taskRefId);
console.log(`\nexpected_kpi_impacts: ${kp.length} rows`);
for (const r of kp) console.log("  ", r.kpiId, r.companyId, "actual:", r.actualDelta);
process.exit(0);
