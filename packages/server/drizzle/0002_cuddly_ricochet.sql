CREATE TABLE "sync_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"sync_id" text NOT NULL,
	"user_id" text NOT NULL,
	"trigger" text NOT NULL,
	"status" text NOT NULL,
	"report" text,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "syncs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"source" text NOT NULL,
	"target" text NOT NULL,
	"data_types" text NOT NULL,
	"direction" text DEFAULT 'one_way' NOT NULL,
	"interval_minutes" integer,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_run_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_sync_id_syncs_id_fk" FOREIGN KEY ("sync_id") REFERENCES "public"."syncs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "syncs" ADD CONSTRAINT "syncs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sync_runs_sync_idx" ON "sync_runs" USING btree ("sync_id");--> statement-breakpoint
CREATE INDEX "sync_runs_user_idx" ON "sync_runs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "syncs_user_idx" ON "syncs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "syncs_enabled_idx" ON "syncs" USING btree ("enabled");