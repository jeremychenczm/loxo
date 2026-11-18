ALTER TABLE "approvals" DROP COLUMN "candidate_id";--> statement-breakpoint
DROP INDEX "turns_workspace_single_writer";--> statement-breakpoint
ALTER TABLE "turns" DROP COLUMN "phase";--> statement-breakpoint
ALTER TABLE "turns" DROP COLUMN "work_package_id";--> statement-breakpoint
ALTER TABLE "turns" DROP COLUMN "workspace_id";--> statement-breakpoint
ALTER TABLE "turns" DROP COLUMN "permission";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "playbook";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "phase";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "settings";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "snapshot";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "snapshot_hash";--> statement-breakpoint
ALTER TABLE "task_members" DROP COLUMN "paused_reason";--> statement-breakpoint
ALTER TABLE "task_members" DROP COLUMN "runtime_session_id";--> statement-breakpoint
ALTER TABLE "task_members" DROP COLUMN "session_epoch";--> statement-breakpoint
DROP TABLE "signoffs";--> statement-breakpoint
DROP TABLE "deliveries";--> statement-breakpoint
DROP TABLE "findings";--> statement-breakpoint
DROP TABLE "check_runs";--> statement-breakpoint
DROP TABLE "candidates";--> statement-breakpoint
DROP TABLE "context_deliveries";--> statement-breakpoint
DROP TABLE "work_packages";--> statement-breakpoint
DROP TABLE "plan_reviews";--> statement-breakpoint
DROP TABLE "plans";
