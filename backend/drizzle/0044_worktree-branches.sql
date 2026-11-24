ALTER TABLE "workspaces" ALTER COLUMN "branch_name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "change_snapshots" ADD COLUMN "tree_id" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "current_branch" text;--> statement-breakpoint
UPDATE "workspaces" SET "current_branch" = "branch_name";
