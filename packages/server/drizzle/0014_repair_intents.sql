CREATE TABLE IF NOT EXISTS "repair_intents" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"sync_id" text NOT NULL,
	"target" text NOT NULL,
	"item_key" text NOT NULL,
	"ref" text NOT NULL,
	"watched_at" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "repair_intents" ADD CONSTRAINT "repair_intents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "repair_intents_scope_uniq" ON "repair_intents" ("sync_id","target","item_key");
