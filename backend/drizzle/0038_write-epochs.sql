ALTER TABLE "change_snapshots" ADD COLUMN "epoch" integer;--> statement-breakpoint
ALTER TABLE "run_events" ADD COLUMN "epoch" integer;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "epoch" integer;