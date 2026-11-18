CREATE TABLE "control_plane_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"epoch" integer NOT NULL,
	"seq" integer NOT NULL,
	"tool" text NOT NULL,
	"args_hash" text NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "control_plane_requests" ADD CONSTRAINT "control_plane_requests_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "control_plane_requests_run_seq" ON "control_plane_requests" USING btree ("run_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "control_plane_requests_terminal" ON "control_plane_requests" USING btree ("run_id","tool") WHERE "control_plane_requests"."tool" IN ('submit_result', 'submit_review');