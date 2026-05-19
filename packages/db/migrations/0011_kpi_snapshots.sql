CREATE TABLE IF NOT EXISTS "mc_kpi_snapshots" (
  "id" text PRIMARY KEY NOT NULL,
  "company_id" text NOT NULL,
  "kpi_id" text NOT NULL,
  "value" double precision NOT NULL,
  "target" double precision,
  "measured_at" timestamp with time zone DEFAULT now() NOT NULL,
  "source" text DEFAULT 'scheduler' NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mc_kpi_snapshots_ck_at_idx" ON "mc_kpi_snapshots" ("company_id", "kpi_id", "measured_at");
