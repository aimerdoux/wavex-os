CREATE TABLE IF NOT EXISTS "expected_kpi_impacts" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL,
  "task_ref_type" text NOT NULL,
  "task_ref_id" text NOT NULL,
  "kpi_id" text NOT NULL,
  "scope_node_id" text NOT NULL,
  "direction" text NOT NULL,
  "estimated_delta" double precision NOT NULL,
  "unit" text NOT NULL,
  "time_horizon" text NOT NULL,
  "confidence" double precision NOT NULL,
  "rationale" text NOT NULL,
  "based_on_prior_tasks" jsonb,
  "measure_at" timestamp with time zone NOT NULL,
  "actual_delta" double precision,
  "measurement_method" text NOT NULL,
  "measurement_completed_at" timestamp with time zone,
  "variance" double precision,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "expected_kpi_impacts_scan_idx" ON "expected_kpi_impacts" ("kpi_id", "measure_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "expected_kpi_impacts_task_ref_idx" ON "expected_kpi_impacts" ("task_ref_type", "task_ref_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "expected_kpi_impacts_company_idx" ON "expected_kpi_impacts" ("company_id");
