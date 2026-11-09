UPDATE "agents" SET "execution" = 'server' WHERE "execution" = 'machine';--> statement-breakpoint
ALTER TABLE "project_repositories" DROP CONSTRAINT "project_repositories_machine_binding";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "machine_id";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "machine_workdir";--> statement-breakpoint
ALTER TABLE "execution_workspaces" DROP COLUMN "machine_id";--> statement-breakpoint
ALTER TABLE "project_repositories" DROP COLUMN "machine_id";--> statement-breakpoint
DROP TABLE "machines";
