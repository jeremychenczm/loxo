CREATE TABLE "crews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crew_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"crew_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"position" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "crews" ADD CONSTRAINT "crews_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crew_members" ADD CONSTRAINT "crew_members_crew_id_crews_id_fk" FOREIGN KEY ("crew_id") REFERENCES "public"."crews"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crew_members" ADD CONSTRAINT "crew_members_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "crew_members_crew_agent" ON "crew_members" USING btree ("crew_id","agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "crew_members_crew_position" ON "crew_members" USING btree ("crew_id","position");--> statement-breakpoint
-- Each agent group becomes a crew with the same id; its agents become members in creation order.
INSERT INTO "crews" ("id", "user_id", "name", "created_at", "updated_at")
	SELECT "id", "user_id", "name", "created_at", "updated_at" FROM "agent_groups";--> statement-breakpoint
INSERT INTO "crew_members" ("crew_id", "agent_id", "position")
	SELECT "group_id", "id", (row_number() OVER (PARTITION BY "group_id" ORDER BY "created_at", "id") - 1)::integer
	FROM "agents" WHERE "group_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" DROP CONSTRAINT "agents_group_id_agent_groups_id_fk";--> statement-breakpoint
ALTER TABLE "agents" DROP COLUMN "group_id";--> statement-breakpoint
DROP TABLE "agent_groups";
