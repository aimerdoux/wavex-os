CREATE TABLE IF NOT EXISTS "memberships" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid,
  "plan_type" text NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "stripe_subscription_id" text,
  "stripe_customer_id" text,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "cancelled_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "memberships_plan_type_check" CHECK ("plan_type" IN ('annual', 'monthly')),
  CONSTRAINT "memberships_status_check" CHECK ("status" IN ('active', 'cancelled', 'past_due'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "memberships_stripe_subscription_id_uniq" ON "memberships" ("stripe_subscription_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memberships_user_id_status_idx" ON "memberships" ("user_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "memberships_status_idx" ON "memberships" ("status");
