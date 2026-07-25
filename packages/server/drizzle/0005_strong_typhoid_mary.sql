CREATE TABLE "deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"sync_id" text NOT NULL,
	"user_id" text NOT NULL,
	"target" text NOT NULL,
	"item_key" text NOT NULL,
	"ref" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_sync_id_syncs_id_fk" FOREIGN KEY ("sync_id") REFERENCES "public"."syncs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "deliveries_scope_key_uniq" ON "deliveries" USING btree ("sync_id","target","item_key");--> statement-breakpoint
CREATE INDEX "deliveries_scope_idx" ON "deliveries" USING btree ("sync_id","target");