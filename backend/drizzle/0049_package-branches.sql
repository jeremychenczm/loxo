ALTER TABLE "work_packages" ADD COLUMN "attempt" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "work_packages" ADD COLUMN "branch" text;--> statement-breakpoint
ALTER TABLE "work_packages" ADD COLUMN "start_commit" text;--> statement-breakpoint
ALTER TABLE "work_packages" ADD COLUMN "head_commit" text;