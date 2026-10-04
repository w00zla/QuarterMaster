CREATE TABLE "catalog"."location" (
	"uuid" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"name_key" text,
	"description_key" text,
	"parent_uuid" uuid,
	"type" text,
	"nav_icon" text,
	"hide_in_starmap" boolean NOT NULL,
	"respawn_location_type" text,
	"content_hash" text NOT NULL,
	"first_seen_import_id" integer NOT NULL,
	"last_seen_import_id" integer NOT NULL,
	"retired_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "catalog"."location" ADD CONSTRAINT "location_first_seen_import_id_import_id_fk" FOREIGN KEY ("first_seen_import_id") REFERENCES "catalog"."import"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog"."location" ADD CONSTRAINT "location_last_seen_import_id_import_id_fk" FOREIGN KEY ("last_seen_import_id") REFERENCES "catalog"."import"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "location_parent_uuid_index" ON "catalog"."location" USING btree ("parent_uuid");--> statement-breakpoint
CREATE INDEX "location_nav_icon_index" ON "catalog"."location" USING btree ("nav_icon");