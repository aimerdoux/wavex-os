CREATE TABLE IF NOT EXISTS "assignment_links" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL,
  "instance_id" text NOT NULL,
  "task_ref_type" text NOT NULL,
  "task_ref_id" text NOT NULL,
  "kind" text NOT NULL,
  "from_node_id" text,
  "to_node_id" text,
  "reason" text,
  "at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assignment_links_task_at_idx" ON "assignment_links" ("task_ref_id", "at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assignment_links_to_at_idx" ON "assignment_links" ("to_node_id", "at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "assignment_links_company_at_idx" ON "assignment_links" ("company_id", "at");
