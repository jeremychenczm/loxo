ALTER TABLE "issues" RENAME TO "tasks";--> statement-breakpoint
ALTER TABLE "tasks" RENAME COLUMN "issue_number" TO "number";--> statement-breakpoint
ALTER TABLE "tasks" RENAME COLUMN "description" TO "brief";--> statement-breakpoint
ALTER TABLE "tasks" RENAME CONSTRAINT "issues_pkey" TO "tasks_pkey";--> statement-breakpoint
ALTER TABLE "tasks" RENAME CONSTRAINT "issues_user_id_users_id_fk" TO "tasks_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "tasks" RENAME CONSTRAINT "issues_project_id_projects_id_fk" TO "tasks_project_id_projects_id_fk";--> statement-breakpoint
ALTER TABLE "tasks" RENAME CONSTRAINT "issues_assignee_agent_id_agents_id_fk" TO "tasks_assignee_agent_id_agents_id_fk";--> statement-breakpoint
ALTER TABLE "tasks" RENAME CONSTRAINT "issues_assignee_user_id_users_id_fk" TO "tasks_assignee_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "tasks" RENAME CONSTRAINT "issues_reviewer_agent_id_agents_id_fk" TO "tasks_reviewer_agent_id_agents_id_fk";--> statement-breakpoint
ALTER TABLE "tasks" RENAME CONSTRAINT "issues_reviewer_user_id_users_id_fk" TO "tasks_reviewer_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "tasks" RENAME CONSTRAINT "issues_active_run_id_runs_id_fk" TO "tasks_active_run_id_runs_id_fk";--> statement-breakpoint
ALTER TABLE "tasks" RENAME CONSTRAINT "issues_source_conversation_id_conversations_id_fk" TO "tasks_source_conversation_id_conversations_id_fk";--> statement-breakpoint
ALTER TABLE "tasks" RENAME CONSTRAINT "issues_assignee_single_principal" TO "tasks_assignee_single_principal";--> statement-breakpoint
ALTER TABLE "tasks" RENAME CONSTRAINT "issues_reviewer_single_principal" TO "tasks_reviewer_single_principal";--> statement-breakpoint
ALTER INDEX "issues_user_number" RENAME TO "tasks_user_number";--> statement-breakpoint
ALTER INDEX "issues_user_status" RENAME TO "tasks_user_status";--> statement-breakpoint
ALTER INDEX "issues_project_status" RENAME TO "tasks_project_status";--> statement-breakpoint
ALTER INDEX "issues_assignee_agent" RENAME TO "tasks_assignee_agent";--> statement-breakpoint
ALTER INDEX "issues_source_conversation" RENAME TO "tasks_source_conversation";--> statement-breakpoint
ALTER TABLE "users" RENAME COLUMN "issue_counter" TO "task_counter";--> statement-breakpoint
ALTER TABLE "issue_comments" RENAME TO "task_comments";--> statement-breakpoint
ALTER TABLE "task_comments" RENAME COLUMN "issue_id" TO "task_id";--> statement-breakpoint
ALTER TABLE "task_comments" RENAME CONSTRAINT "issue_comments_pkey" TO "task_comments_pkey";--> statement-breakpoint
ALTER TABLE "task_comments" RENAME CONSTRAINT "issue_comments_issue_id_issues_id_fk" TO "task_comments_task_id_tasks_id_fk";--> statement-breakpoint
ALTER TABLE "task_comments" RENAME CONSTRAINT "issue_comments_author_user_id_users_id_fk" TO "task_comments_author_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "task_comments" RENAME CONSTRAINT "issue_comments_author_agent_id_agents_id_fk" TO "task_comments_author_agent_id_agents_id_fk";--> statement-breakpoint
ALTER INDEX "issue_comments_issue_created" RENAME TO "task_comments_task_created";--> statement-breakpoint
ALTER TABLE "issue_reviews" RENAME TO "task_reviews";--> statement-breakpoint
ALTER TABLE "task_reviews" RENAME COLUMN "issue_id" TO "task_id";--> statement-breakpoint
ALTER TABLE "task_reviews" RENAME CONSTRAINT "issue_reviews_pkey" TO "task_reviews_pkey";--> statement-breakpoint
ALTER TABLE "task_reviews" RENAME CONSTRAINT "issue_reviews_user_id_users_id_fk" TO "task_reviews_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "task_reviews" RENAME CONSTRAINT "issue_reviews_issue_id_issues_id_fk" TO "task_reviews_task_id_tasks_id_fk";--> statement-breakpoint
ALTER TABLE "task_reviews" RENAME CONSTRAINT "issue_reviews_reviewer_user_id_users_id_fk" TO "task_reviews_reviewer_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "task_reviews" RENAME CONSTRAINT "issue_reviews_reviewer_agent_id_agents_id_fk" TO "task_reviews_reviewer_agent_id_agents_id_fk";--> statement-breakpoint
ALTER TABLE "task_reviews" RENAME CONSTRAINT "issue_reviews_run_id_runs_id_fk" TO "task_reviews_run_id_runs_id_fk";--> statement-breakpoint
ALTER TABLE "task_reviews" RENAME CONSTRAINT "issue_reviews_change_snapshot_id_run_change_snapshots_id_fk" TO "task_reviews_change_snapshot_id_run_change_snapshots_id_fk";--> statement-breakpoint
ALTER TABLE "task_reviews" RENAME CONSTRAINT "issue_reviews_single_principal" TO "task_reviews_single_principal";--> statement-breakpoint
ALTER INDEX "issue_reviews_issue_created" RENAME TO "task_reviews_task_created";--> statement-breakpoint
ALTER TABLE "runs" RENAME COLUMN "issue_id" TO "task_id";--> statement-breakpoint
ALTER TABLE "runs" RENAME CONSTRAINT "runs_issue_id_issues_id_fk" TO "runs_task_id_tasks_id_fk";--> statement-breakpoint
ALTER INDEX "runs_issue_status" RENAME TO "runs_task_status";--> statement-breakpoint
ALTER TABLE "execution_workspaces" RENAME COLUMN "issue_id" TO "task_id";--> statement-breakpoint
ALTER TABLE "execution_workspaces" RENAME CONSTRAINT "execution_workspaces_issue_id_issues_id_fk" TO "execution_workspaces_task_id_tasks_id_fk";--> statement-breakpoint
ALTER INDEX "execution_workspaces_issue_active" RENAME TO "execution_workspaces_task_active";--> statement-breakpoint
-- Chat breadcrumbs recorded the filed item under meta.issueId.
UPDATE "messages" SET "meta" = ("meta" - 'issueId') || jsonb_build_object('taskId', "meta"->'issueId')
	WHERE "meta" ? 'issueId';
