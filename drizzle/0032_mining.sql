CREATE TABLE "catalog"."mineable" (
	"provider_uuid" uuid NOT NULL,
	"method" text NOT NULL,
	"resource_uuid" uuid NOT NULL,
	"quality_scale" numeric NOT NULL,
	"item_uuid" uuid,
	"share" numeric NOT NULL,
	"min_percent" numeric NOT NULL,
	"max_percent" numeric NOT NULL,
	"rarity" text,
	"quality_min" integer,
	"quality_max" integer,
	"quality_values" jsonb NOT NULL,
	CONSTRAINT "mineable_provider_uuid_method_resource_uuid_quality_scale_pk" PRIMARY KEY("provider_uuid","method","resource_uuid","quality_scale"),
	CONSTRAINT "mineable_method" CHECK ("catalog"."mineable"."method" IN ('ship', 'roc', 'fps'))
);
--> statement-breakpoint
CREATE TABLE "catalog"."mining_provider" (
	"uuid" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"location_uuids" uuid[] NOT NULL
);
--> statement-breakpoint
ALTER TABLE "catalog"."mineable" ADD CONSTRAINT "mineable_provider_uuid_mining_provider_uuid_fk" FOREIGN KEY ("provider_uuid") REFERENCES "catalog"."mining_provider"("uuid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog"."mineable" ADD CONSTRAINT "mineable_resource_uuid_resource_uuid_fk" FOREIGN KEY ("resource_uuid") REFERENCES "catalog"."resource"("uuid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog"."mineable" ADD CONSTRAINT "mineable_item_uuid_item_uuid_fk" FOREIGN KEY ("item_uuid") REFERENCES "catalog"."item"("uuid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mineable_resource_uuid_index" ON "catalog"."mineable" USING btree ("resource_uuid");--> statement-breakpoint
CREATE INDEX "mineable_item_uuid_index" ON "catalog"."mineable" USING btree ("item_uuid");