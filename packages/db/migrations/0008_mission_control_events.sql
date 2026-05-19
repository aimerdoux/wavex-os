CREATE TABLE IF NOT EXISTS "mission_control_events" (
  "id" text PRIMARY KEY NOT NULL,
  "instance_id" text NOT NULL,
  "company_id" text NOT NULL,
  "at" timestamp with time zone DEFAULT now() NOT NULL,
  "kind" text NOT NULL,
  "mode_context" text NOT NULL,
  "actor_node_id" text NOT NULL,
  "action" text NOT NULL,
  "subject_ref" jsonb NOT NULL,
  "scope_chain" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "task_ref_id" text,
  "task_ref_title" text,
  "task_ref_status" text,
  "kpi_ref_id" text,
  "kpi_ref_name" text,
  "deliverable_ref_id" text,
  "deliverable_ref_title" text,
  "deliverable_ref_kind" text,
  "cost_usd" text,
  "expected_impact" text,
  "plain_language_sentence" text DEFAULT '' NOT NULL,
  "severity" text DEFAULT 'info' NOT NULL,
  "detail_url" text DEFAULT '' NOT NULL,
  "visible_to_node_ids" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mc_events_company_at_idx" ON "mission_control_events" ("company_id", "at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mc_events_kind_at_idx" ON "mission_control_events" ("company_id", "kind", "at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mc_events_task_ref_idx" ON "mission_control_events" ("task_ref_id", "at");
