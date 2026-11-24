CREATE TABLE "integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"op_id" uuid NOT NULL,
	"package_key" text NOT NULL,
	"cycle" integer NOT NULL,
	"outcome" text NOT NULL,
	"onto_commit" text NOT NULL,
	"package_head" text NOT NULL,
	"merge_commit" text,
	"conflict_files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "work_packages" ADD COLUMN "resolves" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "work_packages" ADD COLUMN "resolve_onto" text;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_op_id_platform_ops_id_fk" FOREIGN KEY ("op_id") REFERENCES "public"."platform_ops"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "integrations_op" ON "integrations" USING btree ("op_id");--> statement-breakpoint
CREATE INDEX "integrations_task" ON "integrations" USING btree ("task_id","created_at");