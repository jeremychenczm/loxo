ALTER TABLE "repositories" ADD COLUMN "active_merge_owner_instance" text;--> statement-breakpoint
ALTER TABLE "repositories" ADD COLUMN "active_merge_lease_expires_at" timestamp with time zone;