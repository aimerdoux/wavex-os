import { doublePrecision, index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** Mission Control — KPI time series (table: mc_kpi_snapshots).
 *
 *  Distinct from the legacy `kpi_snapshots` table in this same package
 *  (kpis.ts), which is keyed by `kpi_name` + a `value bigint`. Mission
 *  Control uses canonical kpiId (string) + double-precision value, and
 *  optionally captures the cumulative target at the sample instant.
 *
 *  A sampler tick writes one row per KPI per cycle. The Scoreboard widget
 *  reads the last 90d window for sparklines + delta-vs-previous-period.
 */
export const mcKpiSnapshots = pgTable(
  "mc_kpi_snapshots",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    kpiId: text("kpi_id").notNull(),
    value: doublePrecision("value").notNull(),
    target: doublePrecision("target"),
    measuredAt: timestamp("measured_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    source: text("source").notNull().default("scheduler"),
  },
  (t) => ({
    byCompanyKpiTime: index("mc_kpi_snapshots_ck_at_idx").on(
      t.companyId,
      t.kpiId,
      t.measuredAt,
    ),
  }),
);

export type McKpiSnapshotRow = typeof mcKpiSnapshots.$inferSelect;
export type McKpiSnapshotInsert = typeof mcKpiSnapshots.$inferInsert;
