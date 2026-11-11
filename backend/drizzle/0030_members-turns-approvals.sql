CREATE TABLE "task_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"paused_reason" text,
	"runtime_session_id" text,
	"session_epoch" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"phase" text,
	"kind" text NOT NULL,
	"agent_id" uuid,
	"author_user_id" uuid,
	"run_id" uuid,
	"permission" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"report" jsonb,
	"content" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "turns_author_matches_kind" CHECK (("turns"."kind" = 'agent' OR "turns"."agent_id" IS NULL) AND ("turns"."kind" = 'human' OR "turns"."author_user_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"body" text NOT NULL,
	"change_snapshot_id" uuid,
	"fingerprint" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "task_members" ADD CONSTRAINT "task_members_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_members" ADD CONSTRAINT "task_members_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_change_snapshot_id_run_change_snapshots_id_fk" FOREIGN KEY ("change_snapshot_id") REFERENCES "public"."run_change_snapshots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "task_members_task_agent" ON "task_members" USING btree ("task_id","agent_id");--> statement-breakpoint
CREATE INDEX "task_members_agent" ON "task_members" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "turns_task_seq" ON "turns" USING btree ("task_id","seq");--> statement-breakpoint
CREATE INDEX "turns_run" ON "turns" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "approvals_task_created" ON "approvals" USING btree ("task_id","created_at");--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "lead_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "turn_counter" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_lead_agent_id_agents_id_fk" FOREIGN KEY ("lead_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- The assignee agent leads; a distinct reviewer agent joins as the next member.
-- Human assignees and reviewers are dropped: a person always holds final approval.
UPDATE "tasks" SET "lead_agent_id" = "assignee_agent_id";--> statement-breakpoint
INSERT INTO "task_members" ("task_id", "agent_id", "position")
	SELECT "id", "assignee_agent_id", 0 FROM "tasks" WHERE "assignee_agent_id" IS NOT NULL;--> statement-breakpoint
INSERT INTO "task_members" ("task_id", "agent_id", "position")
	SELECT "id", "reviewer_agent_id", CASE WHEN "assignee_agent_id" IS NULL THEN 0 ELSE 1 END
	FROM "tasks"
	WHERE "reviewer_agent_id" IS NOT NULL AND "reviewer_agent_id" IS DISTINCT FROM "assignee_agent_id";--> statement-breakpoint
-- Comments become completed turns in their original order.
INSERT INTO "turns" ("task_id", "seq", "kind", "agent_id", "author_user_id", "status", "content", "created_at", "completed_at")
	SELECT "task_id",
		(row_number() OVER (PARTITION BY "task_id" ORDER BY "created_at", "id"))::integer,
		"author_type",
		CASE WHEN "author_type" = 'agent' THEN "author_agent_id" END,
		CASE WHEN "author_type" = 'human' THEN "author_user_id" END,
		'completed', "body", "created_at", "created_at"
	FROM "task_comments";--> statement-breakpoint
UPDATE "tasks" SET "turn_counter" = counts."n"
	FROM (SELECT "task_id", count(*)::integer AS "n" FROM "turns" GROUP BY "task_id") AS counts
	WHERE counts."task_id" = "tasks"."id";--> statement-breakpoint
-- Agent verdicts were also posted to the timeline under a decision label; the
-- structured verdict moves onto that turn.
UPDATE "turns" SET "report" = jsonb_build_object('type', 'review', 'decision', r."decision"), "run_id" = r."run_id"
	FROM "task_reviews" r
	WHERE r."reviewer_type" = 'agent'
		AND "turns"."task_id" = r."task_id"
		AND "turns"."kind" = 'agent'
		AND "turns"."agent_id" = r."reviewer_agent_id"
		AND "turns"."content" = (CASE r."decision" WHEN 'approved' THEN '[APPROVED] ' ELSE '[CHANGES REQUESTED] ' END) || r."body";--> statement-breakpoint
-- Human decisions become approvals pinned to their snapshot's fingerprint.
INSERT INTO "approvals" ("id", "task_id", "user_id", "decision", "body", "change_snapshot_id", "fingerprint", "created_at")
	SELECT r."id", r."task_id", COALESCE(r."reviewer_user_id", r."user_id"), r."decision", r."body",
		r."change_snapshot_id", s."change_fingerprint", r."created_at"
	FROM "task_reviews" r
	LEFT JOIN "run_change_snapshots" s ON s."id" = r."change_snapshot_id"
	WHERE r."reviewer_type" = 'human';--> statement-breakpoint
DROP INDEX "tasks_assignee_agent";--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_assignee_single_principal";--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_reviewer_single_principal";--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_assignee_agent_id_agents_id_fk";--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_assignee_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_reviewer_agent_id_agents_id_fk";--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_reviewer_user_id_users_id_fk";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "assignee_agent_id";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "assignee_user_id";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "reviewer_agent_id";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "reviewer_user_id";--> statement-breakpoint
CREATE INDEX "tasks_lead_agent" ON "tasks" USING btree ("lead_agent_id","status");--> statement-breakpoint
DROP TABLE "task_comments";--> statement-breakpoint
DROP TABLE "task_reviews";
