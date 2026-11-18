ALTER TABLE "human_requests" ADD COLUMN "run_id" uuid;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "owner_instance" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "owner_epoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "attempt" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "parent_run_id" uuid;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "not_before" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "human_requests" ADD CONSTRAINT "human_requests_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_parent_run_id_runs_id_fk" FOREIGN KEY ("parent_run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "human_requests_run" ON "human_requests" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "human_requests_one_retry_per_run" ON "human_requests" USING btree ("run_id") WHERE "human_requests"."kind" = 'retry';--> statement-breakpoint
CREATE INDEX "runs_running_lease" ON "runs" USING btree ("lease_expires_at") WHERE "runs"."status" = 'running';--> statement-breakpoint
-- Runs left running by a backend that predates leases have no owner; give them
-- an already-expired lease so the first reconciler pass takes them over.
UPDATE "runs" SET "owner_instance" = 'pre-lease', "lease_expires_at" = now() WHERE "status" = 'running';
