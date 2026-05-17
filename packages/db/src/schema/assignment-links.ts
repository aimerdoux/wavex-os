import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** Mission Control — append-only AssignmentLink ledger.
 *
 *  Every time a task moves between nodes (originated → assigned →
 *  accepted → delegated → completed/etc.) we append one row here. The
 *  full chain for a task is the rows where `task_ref_id` matches,
 *  ordered by `at`. No updates ever — rejections, re-assignments, and
 *  re-acceptances all land as new rows.
 *
 *  `kind` is one of:
 *    - assigned   (from_node → to_node, with reason)
 *    - accepted   (to_node accepts)
 *    - rejected   (to_node rejects)
 *    - delegated  (current owner delegates to another)
 *    - completed  (terminal)
 *    - failed     (terminal)
 *    - cancelled  (terminal)
 *
 *  Indexes:
 *    - (task_ref_id, at) for chain reconstruction
 *    - (to_node_id, at) for "what's on my plate" queries
 *    - (company_id, at) for the operator-wide assignment feed
 */

export const assignmentLinks = pgTable(
  "assignment_links",
  {
    id: text("id").primaryKey(),
    companyId: text("company_id").notNull(),
    instanceId: text("instance_id").notNull(),
    taskRefType: text("task_ref_type").notNull(),
    taskRefId: text("task_ref_id").notNull(),
    kind: text("kind").notNull(),

    fromNodeId: text("from_node_id"),
    toNodeId: text("to_node_id"),
    reason: text("reason"),

    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byTask: index("assignment_links_task_at_idx").on(t.taskRefId, t.at),
    byTo: index("assignment_links_to_at_idx").on(t.toNodeId, t.at),
    byCompany: index("assignment_links_company_at_idx").on(t.companyId, t.at),
  }),
);

export type AssignmentLinkRow = typeof assignmentLinks.$inferSelect;
export type AssignmentLinkInsert = typeof assignmentLinks.$inferInsert;
