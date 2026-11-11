CREATE TABLE "candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"fingerprint" text NOT NULL,
	"checks_digest" text NOT NULL,
	"plan_hash" text,
	"summary" text DEFAULT '' NOT NULL,
	"digest" text NOT NULL,
	"status" text DEFAULT 'collecting' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "check_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"workspace_id" uuid,
	"fingerprint" text NOT NULL,
	"name" text NOT NULL,
	"command" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"exit_code" integer,
	"duration_ms" integer,
	"log_ref" text,
	"log_truncated" boolean DEFAULT false NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "context_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_member_id" uuid NOT NULL,
	"session_epoch" integer NOT NULL,
	"delivered_through_seq" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"candidate_id" uuid,
	"approval_id" uuid,
	"method" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"merge_commit" text,
	"pull_request_url" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"cycle" integer DEFAULT 1 NOT NULL,
	"source" text NOT NULL,
	"reporter_agent_id" uuid,
	"check_run_id" uuid,
	"turn_id" uuid,
	"work_package_id" uuid,
	"severity" text NOT NULL,
	"location" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"body" text NOT NULL,
	"suggestion" text,
	"status" text DEFAULT 'open' NOT NULL,
	"resolution" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "human_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"choices" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"answer" jsonb,
	"status" text DEFAULT 'open' NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"answered_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "plan_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"task_member_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"suggestion" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_reviews_objection_has_reason" CHECK ("plan_reviews"."decision" = 'approve' OR length(trim("plan_reviews"."reason")) > 0)
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"hash" text NOT NULL,
	"author_agent_id" uuid,
	"body" jsonb NOT NULL,
	"status" text DEFAULT 'proposed' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "signoffs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"candidate_id" uuid NOT NULL,
	"task_member_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"finding_id" uuid,
	"turn_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signoffs_refusal_cites_finding" CHECK ("signoffs"."decision" = 'signed' OR "signoffs"."finding_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "work_packages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"key" text NOT NULL,
	"title" text NOT NULL,
	"owner_member_id" uuid,
	"scope" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"depends_on" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"acceptance" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"workspace_id" uuid,
	"attempt" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "candidate_id" uuid;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "transport" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "stop_reason" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "playbook" text DEFAULT 'solo' NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "base_ref" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "phase" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "settings" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "snapshot_hash" text;--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "work_package_id" uuid;--> statement-breakpoint
ALTER TABLE "candidates" ADD CONSTRAINT "candidates_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_runs" ADD CONSTRAINT "check_runs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_runs" ADD CONSTRAINT "check_runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_deliveries" ADD CONSTRAINT "context_deliveries_task_member_id_task_members_id_fk" FOREIGN KEY ("task_member_id") REFERENCES "public"."task_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_approval_id_approvals_id_fk" FOREIGN KEY ("approval_id") REFERENCES "public"."approvals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_reporter_agent_id_agents_id_fk" FOREIGN KEY ("reporter_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_check_run_id_check_runs_id_fk" FOREIGN KEY ("check_run_id") REFERENCES "public"."check_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "findings" ADD CONSTRAINT "findings_work_package_id_work_packages_id_fk" FOREIGN KEY ("work_package_id") REFERENCES "public"."work_packages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "human_requests" ADD CONSTRAINT "human_requests_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_reviews" ADD CONSTRAINT "plan_reviews_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_reviews" ADD CONSTRAINT "plan_reviews_task_member_id_task_members_id_fk" FOREIGN KEY ("task_member_id") REFERENCES "public"."task_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_author_agent_id_agents_id_fk" FOREIGN KEY ("author_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signoffs" ADD CONSTRAINT "signoffs_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signoffs" ADD CONSTRAINT "signoffs_task_member_id_task_members_id_fk" FOREIGN KEY ("task_member_id") REFERENCES "public"."task_members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signoffs" ADD CONSTRAINT "signoffs_finding_id_findings_id_fk" FOREIGN KEY ("finding_id") REFERENCES "public"."findings"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signoffs" ADD CONSTRAINT "signoffs_turn_id_turns_id_fk" FOREIGN KEY ("turn_id") REFERENCES "public"."turns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_packages" ADD CONSTRAINT "work_packages_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_packages" ADD CONSTRAINT "work_packages_plan_id_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_packages" ADD CONSTRAINT "work_packages_owner_member_id_task_members_id_fk" FOREIGN KEY ("owner_member_id") REFERENCES "public"."task_members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_packages" ADD CONSTRAINT "work_packages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "candidates_task_version" ON "candidates" USING btree ("task_id","version");--> statement-breakpoint
CREATE INDEX "check_runs_task_fingerprint" ON "check_runs" USING btree ("task_id","fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "context_deliveries_member_epoch" ON "context_deliveries" USING btree ("task_member_id","session_epoch");--> statement-breakpoint
CREATE INDEX "deliveries_task" ON "deliveries" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "findings_task_status" ON "findings" USING btree ("task_id","status");--> statement-breakpoint
CREATE INDEX "human_requests_task_status" ON "human_requests" USING btree ("task_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "plan_reviews_plan_member" ON "plan_reviews" USING btree ("plan_id","task_member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "plans_task_version" ON "plans" USING btree ("task_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "run_events_run_seq" ON "run_events" USING btree ("run_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "signoffs_candidate_member" ON "signoffs" USING btree ("candidate_id","task_member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "work_packages_plan_key" ON "work_packages" USING btree ("plan_id","key");--> statement-breakpoint
CREATE INDEX "work_packages_task_status" ON "work_packages" USING btree ("task_id","status");--> statement-breakpoint
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_candidate_id_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."candidates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "turns" ADD CONSTRAINT "turns_work_package_id_work_packages_id_fk" FOREIGN KEY ("work_package_id") REFERENCES "public"."work_packages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Terminal statuses are final: a row that reached one may not move again.
CREATE FUNCTION "loxo_forbid_terminal_exit"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF OLD.status = ANY (TG_ARGV) AND NEW.status IS DISTINCT FROM OLD.status THEN
		RAISE EXCEPTION '% % is in terminal status %, cannot become %', TG_TABLE_NAME, OLD.id, OLD.status, NEW.status
			USING ERRCODE = 'check_violation';
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "tasks_terminal_status" BEFORE UPDATE OF "status" ON "tasks"
	FOR EACH ROW EXECUTE FUNCTION "loxo_forbid_terminal_exit"('done', 'cancelled');--> statement-breakpoint
CREATE TRIGGER "candidates_terminal_status" BEFORE UPDATE OF "status" ON "candidates"
	FOR EACH ROW EXECUTE FUNCTION "loxo_forbid_terminal_exit"('delivered', 'rejected', 'invalidated', 'superseded');
