import { index, jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** Mission Control — universal ActivityEvent ledger (wavex-side).
 *
 *  Mirrors the shape of Paperclip's core `activity_log` table, but lives in
 *  @wavex-os/db so the wavex op-omega-server can write/read without
 *  cross-process DB access to Paperclip's Postgres. Phase 1.6 hooks the
 *  wavex-side runners (mail-triage, calendar-triage, slack-digest,
 *  bridge handoffs) to write here. Paperclip-side rows from its own
 *  `activity_log` are not mirrored in v1; Mission Control widgets that
 *  want both will need a future bridge.
 *
 *  Column shapes match `ActivityEvent` in @wavex-os/shared:
 *
 *    - `kind` is one of `ActivityEventKind` (text, not pg-enum, to avoid
 *      ALTER TYPE friction when shipping new kinds).
 *    - `severity` ∈ {info|notable|warning|critical} (also text).
 *    - `subject_ref` is the loose JSONB blob the renderer reads.
 *    - `scope_chain` is a JSONB array of node IDs from the root scope
 *      down to the actor node — populated at write time so the stream
 *      query can filter by any ancestor without a second join.
 *    - `visible_to_node_ids` is non-null only in Hybrid mode where the
 *      operator has restricted visibility; null = visible to everyone in
 *      the instance.
 *
 *  Indexes:
 *    - `(company_id, at)` for the default reverse-chrono stream query.
 *    - `(company_id, kind, at)` for kind-filtered views (Scoreboard etc).
 *    - `(task_ref_id, at)` for drill-down from a task to its event trail.
 */

export const missionControlEvents = pgTable(
  "mission_control_events",
  {
    id: text("id").primaryKey(),
    instanceId: text("instance_id").notNull(),
    companyId: text("company_id").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    kind: text("kind").notNull(),
    modeContext: text("mode_context").notNull(),

    actorNodeId: text("actor_node_id").notNull(),
    action: text("action").notNull(),
    subjectRef: jsonb("subject_ref").notNull(),
    scopeChain: jsonb("scope_chain").notNull().default([]),

    // Optional context refs (denormalized for stream rendering w/o joins)
    taskRefId: text("task_ref_id"),
    taskRefTitle: text("task_ref_title"),
    taskRefStatus: text("task_ref_status"),
    kpiRefId: text("kpi_ref_id"),
    kpiRefName: text("kpi_ref_name"),
    deliverableRefId: text("deliverable_ref_id"),
    deliverableRefTitle: text("deliverable_ref_title"),
    deliverableRefKind: text("deliverable_ref_kind"),

    costUsd: text("cost_usd"),
    expectedImpact: text("expected_impact"),

    plainLanguageSentence: text("plain_language_sentence")
      .notNull()
      .default(""),
    severity: text("severity").notNull().default("info"),
    detailUrl: text("detail_url").notNull().default(""),

    visibleToNodeIds: jsonb("visible_to_node_ids"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    byCompanyAt: index("mc_events_company_at_idx").on(t.companyId, t.at),
    byKindAt: index("mc_events_kind_at_idx").on(t.companyId, t.kind, t.at),
    byTaskRef: index("mc_events_task_ref_idx").on(t.taskRefId, t.at),
  }),
);

export type MissionControlEventRow = typeof missionControlEvents.$inferSelect;
export type MissionControlEventInsert =
  typeof missionControlEvents.$inferInsert;
