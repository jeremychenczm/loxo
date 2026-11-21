CREATE TABLE "dispatch_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dispatch_id" uuid NOT NULL,
	"run_id" uuid,
	"epoch" integer NOT NULL,
	"tool" text NOT NULL,
	"report" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dispatches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"phase" text NOT NULL,
	"purpose" text NOT NULL,
	"package_key" text DEFAULT '' NOT NULL,
	"cycle" integer NOT NULL,
	"round" integer NOT NULL,
	"agent_id" uuid,
	"workspace_id" uuid,
	"status" text DEFAULT 'pending' NOT NULL,
	"timeout_ms" integer NOT NULL,
	"started_at" timestamp with time zone,
	"paused_at" timestamp with time zone,
	"elapsed_ms" integer DEFAULT 0 NOT NULL,
	"cancel_requested_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "phase_transitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"from_phase" text,
	"to_phase" text NOT NULL,
	"cycle" integer NOT NULL,
	"round" integer NOT NULL,
	"cause" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "control_plane_requests_terminal";--> statement-breakpoint
ALTER TABLE "human_requests" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "actor" text DEFAULT 'agent' NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "workspace_id" uuid;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "gate_key" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "dispatch_id" uuid;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "playbook" text DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "phase" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "cycle" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "round" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "snapshot_hash" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "plan_hash" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "parallelism" integer;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "advance_pending" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "advance_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "dispatch_reports" ADD CONSTRAINT "dispatch_reports_dispatch_id_dispatches_id_fk" FOREIGN KEY ("dispatch_id") REFERENCES "public"."dispatches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatch_reports" ADD CONSTRAINT "dispatch_reports_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatches" ADD CONSTRAINT "dispatches_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatches" ADD CONSTRAINT "dispatches_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dispatches" ADD CONSTRAINT "dispatches_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "phase_transitions" ADD CONSTRAINT "phase_transitions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dispatch_reports_dispatch" ON "dispatch_reports" USING btree ("dispatch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dispatches_key" ON "dispatches" USING btree ("task_id","purpose","cycle","round","agent_id","package_key");--> statement-breakpoint
CREATE INDEX "dispatches_task_status" ON "dispatches" USING btree ("task_id","status");--> statement-breakpoint
CREATE INDEX "phase_transitions_task" ON "phase_transitions" USING btree ("task_id","created_at");--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_dispatch_id_dispatches_id_fk" FOREIGN KEY ("dispatch_id") REFERENCES "public"."dispatches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "human_requests_open_dedupe" ON "human_requests" USING btree ("task_id","dedupe_key") WHERE "human_requests"."status" = 'open' AND "human_requests"."dedupe_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "runs_dispatch" ON "runs" USING btree ("dispatch_id");--> statement-breakpoint
CREATE INDEX "tasks_advance_pending" ON "tasks" USING btree ("id") WHERE "tasks"."advance_pending";--> statement-breakpoint
CREATE UNIQUE INDEX "control_plane_requests_terminal" ON "control_plane_requests" USING btree ("run_id","tool") WHERE "control_plane_requests"."tool" IN ('submit_result', 'submit_review', 'submit_exploration', 'submit_plan', 'submit_plan_review', 'submit_verification', 'submit_triage', 'submit_sign_off');--> statement-breakpoint
UPDATE "runs" SET "gate_key" = 'task:' || "task_id" WHERE "task_id" IS NOT NULL;--> statement-breakpoint
UPDATE "runs" AS r SET "workspace_id" = w."id"
FROM (
  SELECT DISTINCT ON ("task_id") "id", "task_id" FROM "workspaces"
  WHERE "kind" = 'integration' ORDER BY "task_id", "created_at" DESC
) AS w
WHERE r."task_id" = w."task_id";
