CREATE TABLE IF NOT EXISTS "corporate_inquiries" (
  "id" text PRIMARY KEY NOT NULL,
  "company_name" text NOT NULL,
  "contact_name" text NOT NULL,
  "contact_email" text NOT NULL,
  "headcount" text NOT NULL,
  "event_type" text NOT NULL,
  "preferred_dates" text,
  "budget_range" text,
  "message" text,
  "booking_source" text DEFAULT 'corporate' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
