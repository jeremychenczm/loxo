ALTER TABLE "runs" ADD COLUMN "launcher_pid" integer;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "launcher_tag" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "launcher_host" text;