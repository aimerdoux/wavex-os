import {
  doublePrecision,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/** Mission Control — ExpectedKpiImpact ledger.
 *
 *  Every task that's expected to move a KPI declares one row here at
 *  origination (rationale, estimated delta, time horizon, confidence).
 *  The measurement scheduler scans for rows where `measure_at <= now()`
 *  and `actual_delta IS NULL`, queries the KPI source, fills in
 *  `actual_delta` + `measurement_completed_at` + `variance`. The
 *  variance signal feeds Phase 6's Chief-of-Staff learning loop.
 *
 *  `task_ref_type` mirrors deliverables.task_ref_type — same rationale
 *  (Paperclip issues vs Avatar on-disk approvals vs future MC tasks).
 *
 *  `kpi_id` is a string ref (no FK) because v1 KPIs live in Paperclip's
 *  `company_kpis` table which is in @paperclipai/db, not @wavex-os/db.
 *  Cross-package FKs require coordinated migrations.
 *
 *  Tasks that won't move any KPI carry a NULL row here + a justification
 *  string on the task itself (`kpiImpactJustifiedAsNone`).
 */

export const expectedKpiImpacts = pgTable(
  "expected_kpi_impacts",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    taskRefType: text("task_ref_type").notNull(),
    taskRefId: text("task_ref_id").notNull(),
    kpiId: text("kpi_id").notNull(),
    scopeNodeId: text("scope_node_id").notNull(),

    direction: text("direction").notNull(),
    estimatedDelta: doublePrecision("estimated_delta").notNull(),
    unit: text("unit").notNull(),
    timeHorizon: text("time_horizon").notNull(),
    confidence: doublePrecision("confidence").notNull(),

    rationale: text("rationale").notNull(),
    basedOnPriorTasks: jsonb("based_on_prior_tasks"),

    measureAt: timestamp("measure_at", { withTimezone: true }).notNull(),
    actualDelta: doublePrecision("actual_delta"),
    measurementMethod: text("measurement_method").notNull(),
    measurementCompletedAt: timestamp("measurement_completed_at", {
      withTimezone: true,
    }),
    variance: doublePrecision("variance"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    schedulerScan: index("expected_kpi_impacts_scan_idx").on(
      t.kpiId,
      t.measureAt,
    ),
    byTaskRef: index("expected_kpi_impacts_task_ref_idx").on(
      t.taskRefType,
      t.taskRefId,
    ),
    byCompany: index("expected_kpi_impacts_company_idx").on(t.companyId),
  }),
);

export type ExpectedKpiImpactRow = typeof expectedKpiImpacts.$inferSelect;
export type ExpectedKpiImpactInsert = typeof expectedKpiImpacts.$inferInsert;
