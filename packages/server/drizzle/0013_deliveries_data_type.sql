DROP INDEX "deliveries_scope_key_uniq";--> statement-breakpoint
DROP INDEX "deliveries_scope_idx";--> statement-breakpoint
ALTER TABLE "deliveries" ADD COLUMN "data_type" text DEFAULT 'history' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "deliveries_scope_key_uniq" ON "deliveries" USING btree ("sync_id","target","data_type","item_key");--> statement-breakpoint
CREATE INDEX "deliveries_scope_idx" ON "deliveries" USING btree ("sync_id","target","data_type");