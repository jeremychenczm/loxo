ALTER TABLE "execution_workspaces" RENAME TO "workspaces";--> statement-breakpoint
ALTER TABLE "workspaces" RENAME CONSTRAINT "execution_workspaces_pkey" TO "workspaces_pkey";--> statement-breakpoint
ALTER TABLE "workspaces" RENAME CONSTRAINT "execution_workspaces_user_id_users_id_fk" TO "workspaces_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "workspaces" RENAME CONSTRAINT "execution_workspaces_task_id_tasks_id_fk" TO "workspaces_task_id_tasks_id_fk";--> statement-breakpoint
ALTER TABLE "workspaces" RENAME CONSTRAINT "execution_workspaces_repository_id_repositories_id_fk" TO "workspaces_repository_id_repositories_id_fk";--> statement-breakpoint
ALTER TABLE "workspaces" RENAME CONSTRAINT "execution_workspaces_last_run_id_runs_id_fk" TO "workspaces_last_run_id_runs_id_fk";--> statement-breakpoint
ALTER INDEX "execution_workspaces_repository_status" RENAME TO "workspaces_repository_status";--> statement-breakpoint
ALTER INDEX "execution_workspaces_user_status" RENAME TO "workspaces_user_status";--> statement-breakpoint
-- Every existing workspace was the task's single shared branch, which is the integration role.
ALTER TABLE "workspaces" ADD COLUMN "kind" text DEFAULT 'integration' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ALTER COLUMN "kind" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "agent_id" uuid;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
DROP INDEX "execution_workspaces_task_active";--> statement-breakpoint
CREATE UNIQUE INDEX "workspaces_task_integration_active" ON "workspaces" USING btree ("task_id") WHERE "workspaces"."kind" = 'integration' AND "workspaces"."status" NOT IN ('merged', 'retained', 'abandoned');--> statement-breakpoint
CREATE UNIQUE INDEX "workspaces_task_agent_active" ON "workspaces" USING btree ("task_id","kind","agent_id") WHERE "workspaces"."kind" <> 'integration' AND "workspaces"."status" NOT IN ('merged', 'retained', 'abandoned');--> statement-breakpoint
ALTER TABLE "repositories" DROP CONSTRAINT "repositories_active_merge_workspace_id_execution_workspaces_id_";--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_active_merge_workspace_id_workspaces_id_fk" FOREIGN KEY ("active_merge_workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_change_snapshots" RENAME TO "change_snapshots";--> statement-breakpoint
ALTER TABLE "change_snapshots" RENAME COLUMN "execution_workspace_id" TO "workspace_id";--> statement-breakpoint
ALTER TABLE "change_snapshots" RENAME CONSTRAINT "run_change_snapshots_pkey" TO "change_snapshots_pkey";--> statement-breakpoint
ALTER TABLE "change_snapshots" RENAME CONSTRAINT "run_change_snapshots_run_id_runs_id_fk" TO "change_snapshots_run_id_runs_id_fk";--> statement-breakpoint
ALTER TABLE "change_snapshots" RENAME CONSTRAINT "run_change_snapshots_execution_workspace_id_execution_workspace" TO "change_snapshots_workspace_id_workspaces_id_fk";--> statement-breakpoint
ALTER INDEX "run_change_snapshots_run" RENAME TO "change_snapshots_run";--> statement-breakpoint
ALTER INDEX "run_change_snapshots_workspace" RENAME TO "change_snapshots_workspace";--> statement-breakpoint
ALTER TABLE "approvals" RENAME CONSTRAINT "approvals_change_snapshot_id_run_change_snapshots_id_fk" TO "approvals_change_snapshot_id_change_snapshots_id_fk";--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "turns_workspace_single_writer" ON "turns" USING btree ("workspace_id") WHERE "turns"."status" = 'running' AND "turns"."permission" IN ('edit', 'full');
