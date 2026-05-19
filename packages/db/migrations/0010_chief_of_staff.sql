CREATE TABLE IF NOT EXISTS "chief_configs" (
  "instance_id" text PRIMARY KEY NOT NULL,
  "mode" text NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "responsibilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "scope_of_authority" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "daily_budget_usd" double precision DEFAULT 0 NOT NULL,
  "cooldown_minutes" integer DEFAULT 15 NOT NULL,
  "max_originations_per_day" integer DEFAULT 20 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chief_origination_rules" (
  "id" text PRIMARY KEY NOT NULL,
  "instance_id" text NOT NULL,
  "name" text NOT NULL,
  "description" text DEFAULT '' NOT NULL,
  "trigger_kind" text NOT NULL,
  "trigger_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "task_template" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chief_origination_rules_instance_idx" ON "chief_origination_rules" ("instance_id");
