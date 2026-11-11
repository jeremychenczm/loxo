CREATE TABLE "repositories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"root_path" text NOT NULL,
	"default_branch" text DEFAULT 'main' NOT NULL,
	"setup_command" text,
	"checks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fingerprint" text NOT NULL,
	"active_merge_workspace_id" uuid,
	"active_merge_operation_id" text,
	"active_merge_pre_head" text,
	"active_merge_started_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repositories" ADD CONSTRAINT "repositories_active_merge_workspace_id_execution_workspaces_id_fk" FOREIGN KEY ("active_merge_workspace_id") REFERENCES "public"."execution_workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "repositories_user_root" ON "repositories" USING btree ("user_id","root_path");--> statement-breakpoint
-- Legacy bindings pointed into platform-managed project folders, which are removed;
-- they are not carried over, and their workspace rows keep a null repository.
ALTER TABLE "execution_workspaces" DROP CONSTRAINT "execution_workspaces_repository_id_project_repositories_id_fk";--> statement-breakpoint
UPDATE "execution_workspaces" SET "repository_id" = NULL WHERE "repository_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "execution_workspaces" ADD CONSTRAINT "execution_workspaces_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_workspaces" DROP CONSTRAINT "execution_workspaces_project_id_projects_id_fk";--> statement-breakpoint
ALTER TABLE "execution_workspaces" DROP COLUMN "project_id";--> statement-breakpoint
ALTER TABLE "execution_workspaces" DROP COLUMN "location";--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "repository_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_repository_id_repositories_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repositories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
DROP INDEX "tasks_project_status";--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_project_id_projects_id_fk";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "project_id";--> statement-breakpoint
CREATE INDEX "tasks_repository_status" ON "tasks" USING btree ("repository_id","status");--> statement-breakpoint
DROP TABLE "project_repositories";--> statement-breakpoint
DROP TABLE "project_agents";--> statement-breakpoint
DROP TABLE "projects";
