ALTER TABLE "tasks" DROP CONSTRAINT "tasks_active_run_id_runs_id_fk";
--> statement-breakpoint
-- Builds without leases could leave several runs marked running for one agent
-- or task. Keep the most recent of each conflict and close the rest so the
-- gate indexes can be built.
UPDATE "runs" AS r
SET "status" = 'failed', "error" = 'Owner lost before upgrade', "finished_at" = now(), "lease_expires_at" = NULL
WHERE r."status" = 'running' AND EXISTS (
  SELECT 1 FROM "runs" o
  WHERE o."status" = 'running' AND o."id" <> r."id"
    AND (o."agent_id" = r."agent_id" OR o."task_id" = r."task_id")
    AND (COALESCE(o."started_at", o."created_at"), o."id") > (COALESCE(r."started_at", r."created_at"), r."id")
);--> statement-breakpoint
CREATE UNIQUE INDEX "runs_one_running_per_agent" ON "runs" USING btree ("agent_id") WHERE "runs"."status" = 'running';--> statement-breakpoint
CREATE UNIQUE INDEX "runs_one_running_per_task" ON "runs" USING btree ("task_id") WHERE "runs"."status" = 'running';--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "active_run_id";--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_running_has_lease" CHECK ("runs"."status" <> 'running' OR ("runs"."owner_instance" IS NOT NULL AND "runs"."lease_expires_at" IS NOT NULL));