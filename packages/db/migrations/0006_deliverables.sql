CREATE TABLE IF NOT EXISTS "deliverables" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL,
  "instance_id" text NOT NULL,
  "task_ref_type" text NOT NULL,
  "task_ref_id" text NOT NULL,
  "produced_by_node_id" text NOT NULL,
  "produced_at" timestamp with time zone DEFAULT now() NOT NULL,
  "kind" text NOT NULL,
  "disk_path" text DEFAULT '' NOT NULL,
  "rel_path" text DEFAULT '' NOT NULL,
  "size_bytes" bigint DEFAULT 0 NOT NULL,
  "content_hash" text DEFAULT '' NOT NULL,
  "title" text NOT NULL,
  "description" text DEFAULT '' NOT NULL,
  "preview_text" text,
  "mime_type" text DEFAULT 'application/octet-stream' NOT NULL,
  "inputs_ref" jsonb,
  "template_used" text,
  "prompt_used_ref" text,
  "status" text DEFAULT 'draft' NOT NULL,
  "reviewed_by_node_id" text,
  "reviewed_at" timestamp with time zone,
  "review_notes" text,
  "expected_kpi_impact_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deliverables_company_produced_idx" ON "deliverables" ("company_id", "produced_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deliverables_task_ref_idx" ON "deliverables" ("task_ref_type", "task_ref_id");
