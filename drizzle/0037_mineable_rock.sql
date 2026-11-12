CREATE TABLE "catalog"."mineable_rock" (
	"uuid" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"method" text NOT NULL,
	"resource_uuid" uuid NOT NULL,
	"rarity" text,
	"radar_signature" numeric,
	CONSTRAINT "mineable_rock_method" CHECK ("catalog"."mineable_rock"."method" IN ('ship', 'roc', 'fps'))
);
--> statement-breakpoint
ALTER TABLE "catalog"."mineable_rock" ADD CONSTRAINT "mineable_rock_resource_uuid_resource_uuid_fk" FOREIGN KEY ("resource_uuid") REFERENCES "catalog"."resource"("uuid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mineable_rock_resource_uuid_index" ON "catalog"."mineable_rock" USING btree ("resource_uuid");