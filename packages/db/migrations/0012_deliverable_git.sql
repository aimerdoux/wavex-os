ALTER TABLE "deliverables" ADD COLUMN "commit_sha" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "deliverables" ADD COLUMN "git_ref" text DEFAULT '' NOT NULL;
