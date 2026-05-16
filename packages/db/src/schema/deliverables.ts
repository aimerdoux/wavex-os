import {
  bigint,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/** Mission Control — universal deliverable ledger.
 *
 *  Every successful task produces at least one Deliverable. This is the
 *  source of truth that backs the spec invariant *"every successful task
 *  has a Deliverable"*. Backfill script synthesizes a single migrated row
 *  per existing completed task; new code writes rows directly when output
 *  is produced.
 *
 *  `task_ref_type` discriminates the upstream record because v1 doesn't
 *  unify the Task model across Paperclip `issues` and Avatar `approvals`
 *  on-disk — adapters translate to the universal Task shape on read, and
 *  this column records which underlying store the deliverable was produced
 *  from. Possible values: `issue` (Paperclip), `avatar_approval` (Avatar
 *  on-disk JSON), `mission_control_task` (future, post-Avatar v2.1).
 *
 *  `kind` matches `DeliverableKind` in @wavex-os/shared.
 *  `status` matches `DeliverableStatus`.
 */

export const deliverables = pgTable(
  "deliverables",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    instanceId: text("instance_id").notNull(),
    taskRefType: text("task_ref_type").notNull(),
    taskRefId: text("task_ref_id").notNull(),
    producedByNodeId: text("produced_by_node_id").notNull(),
    producedAt: timestamp("produced_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    kind: text("kind").notNull(),

    // Where the artifact lives
    diskPath: text("disk_path").notNull().default(""),
    relPath: text("rel_path").notNull().default(""),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull().default(0),
    contentHash: text("content_hash").notNull().default(""),

    // What it is
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    previewText: text("preview_text"),
    mimeType: text("mime_type").notNull().default("application/octet-stream"),

    // Provenance
    inputsRef: jsonb("inputs_ref"),
    templateUsed: text("template_used"),
    promptUsedRef: text("prompt_used_ref"),

    // Status
    status: text("status").notNull().default("draft"),
    reviewedByNodeId: text("reviewed_by_node_id"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewNotes: text("review_notes"),

    // Linkage to KPI impact (string ref, no FK across packages)
    expectedKpiImpactId: text("expected_kpi_impact_id"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    byCompanyProduced: index("deliverables_company_produced_idx").on(
      t.companyId,
      t.producedAt,
    ),
    byTaskRef: index("deliverables_task_ref_idx").on(
      t.taskRefType,
      t.taskRefId,
    ),
  }),
);

export type Deliverable = typeof deliverables.$inferSelect;
export type DeliverableInsert = typeof deliverables.$inferInsert;
