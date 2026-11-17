DROP INDEX "tasks_source_conversation";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "source_conversation_id";--> statement-breakpoint
DROP TABLE "messages";--> statement-breakpoint
DROP TABLE "conversations";
