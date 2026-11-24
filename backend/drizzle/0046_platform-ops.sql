CREATE TABLE "platform_ops" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"op_key" text NOT NULL,
	"kind" text NOT NULL,
	"args" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"workspace_id" uuid,
	"status" text DEFAULT 'wanted' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"phase" text,
	"cycle" integer,
	"result" jsonb,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "op_id" uuid;--> statement-breakpoint
ALTER TABLE "platform_ops" ADD CONSTRAINT "platform_ops_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_ops" ADD CONSTRAINT "platform_ops_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "platform_ops_key" ON "platform_ops" USING btree ("task_id","op_key");--> statement-breakpoint
CREATE INDEX "platform_ops_task_status" ON "platform_ops" USING btree ("task_id","status");--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_op_id_platform_ops_id_fk" FOREIGN KEY ("op_id") REFERENCES "public"."platform_ops"("id") ON DELETE set null ON UPDATE no action;