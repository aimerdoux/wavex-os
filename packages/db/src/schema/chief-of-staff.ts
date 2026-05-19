import { boolean, doublePrecision, integer, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** Mission Control — Chief of Staff persistence (Phase 6).
 *
 *  Two tables:
 *    - chief_configs: per-instance settings (enabled, daily budget,
 *      cooldown, max originations/day, responsibilities[]).
 *    - chief_origination_rules: append-only rule list. The trigger
 *      evaluator walks these on each tick. Disabled rules stay around
 *      for audit; the evaluator skips them.
 *
 *  Spec separates rules from the on-disk Avatar-mode "conductor"
 *  shape; both surface through the same shape here, with `mode`
 *  recording whether the row applies to Avatar / Solo / Hybrid. */

export const chiefConfigs = pgTable("chief_configs", {
  instanceId: text("instance_id").primaryKey(),
  mode: text("mode").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  responsibilities: jsonb("responsibilities").notNull().default([]),
  scopeOfAuthority: jsonb("scope_of_authority").notNull().default({}),
  dailyBudgetUsd: doublePrecision("daily_budget_usd").notNull().default(0),
  cooldownMinutes: integer("cooldown_minutes").notNull().default(15),
  maxOriginationsPerDay: integer("max_originations_per_day").notNull().default(20),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const chiefOriginationRules = pgTable("chief_origination_rules", {
  id: text("id").primaryKey(),
  instanceId: text("instance_id").notNull(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  triggerKind: text("trigger_kind").notNull(),
  triggerConfig: jsonb("trigger_config").notNull().default({}),
  taskTemplate: jsonb("task_template").notNull().default({}),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ChiefConfigRow = typeof chiefConfigs.$inferSelect;
export type ChiefConfigInsert = typeof chiefConfigs.$inferInsert;
export type ChiefOriginationRuleRow = typeof chiefOriginationRules.$inferSelect;
export type ChiefOriginationRuleInsert = typeof chiefOriginationRules.$inferInsert;
