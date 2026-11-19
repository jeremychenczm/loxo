DROP INDEX "change_snapshots_run";--> statement-breakpoint
DROP INDEX "runs_one_running_per_task";--> statement-breakpoint
ALTER TABLE "change_snapshots" ADD COLUMN "kind" text DEFAULT 'run' NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "recovery_step" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "recovery_class" text;--> statement-breakpoint
CREATE UNIQUE INDEX "change_snapshots_run_kind" ON "change_snapshots" USING btree ("run_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_one_running_per_task" ON "runs" USING btree ("task_id") WHERE "runs"."status" IN ('running', 'interrupted');--> statement-breakpoint
ALTER TABLE "change_snapshots" ADD CONSTRAINT "change_snapshots_kind" CHECK ("change_snapshots"."kind" IN ('run', 'recovery'));--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_interrupted_by_recovery" CHECK ("runs"."status" <> 'interrupted' OR ("runs"."recovery_class" IS NOT NULL AND "runs"."recovery_class" = 'interrupted' AND "runs"."lease_expires_at" IS NULL));