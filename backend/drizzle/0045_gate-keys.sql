DROP INDEX "runs_one_running_per_task";--> statement-breakpoint
CREATE UNIQUE INDEX "runs_one_running_per_gate" ON "runs" USING btree ("gate_key") WHERE "runs"."status" IN ('running', 'interrupted');