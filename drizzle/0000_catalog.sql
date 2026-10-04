CREATE SCHEMA "catalog";
--> statement-breakpoint
CREATE TABLE "catalog"."blueprint" (
	"uuid" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"category_uuid" uuid,
	"output_item_uuid" uuid,
	"is_default" boolean NOT NULL,
	"content_hash" text NOT NULL,
	"first_seen_import_id" integer NOT NULL,
	"last_seen_import_id" integer NOT NULL,
	"retired_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "catalog"."blueprint_category" (
	"uuid" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"content_hash" text NOT NULL,
	"first_seen_import_id" integer NOT NULL,
	"last_seen_import_id" integer NOT NULL,
	"retired_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "catalog"."blueprint_input" (
	"blueprint_uuid" uuid NOT NULL,
	"tier_index" integer NOT NULL,
	"slot_index" integer NOT NULL,
	"input_index" integer NOT NULL,
	"kind" text NOT NULL,
	"resource_uuid" uuid,
	"item_uuid" uuid,
	"quantity" numeric NOT NULL,
	"min_quality" integer NOT NULL,
	CONSTRAINT "blueprint_input_blueprint_uuid_tier_index_slot_index_input_index_pk" PRIMARY KEY("blueprint_uuid","tier_index","slot_index","input_index"),
	CONSTRAINT "blueprint_input_kind" CHECK (("catalog"."blueprint_input"."kind" = 'resource' AND "catalog"."blueprint_input"."resource_uuid" IS NOT NULL AND "catalog"."blueprint_input"."item_uuid" IS NULL)
    OR ("catalog"."blueprint_input"."kind" = 'item' AND "catalog"."blueprint_input"."item_uuid" IS NOT NULL AND "catalog"."blueprint_input"."resource_uuid" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "catalog"."blueprint_slot" (
	"blueprint_uuid" uuid NOT NULL,
	"tier_index" integer NOT NULL,
	"slot_index" integer NOT NULL,
	"key" text NOT NULL,
	"name_key" text,
	"required_count" integer NOT NULL,
	"modifiers" jsonb NOT NULL,
	CONSTRAINT "blueprint_slot_blueprint_uuid_tier_index_slot_index_pk" PRIMARY KEY("blueprint_uuid","tier_index","slot_index")
);
--> statement-breakpoint
CREATE TABLE "catalog"."blueprint_tier" (
	"blueprint_uuid" uuid NOT NULL,
	"tier_index" integer NOT NULL,
	"craft_seconds" numeric NOT NULL,
	"required_slots" integer NOT NULL,
	CONSTRAINT "blueprint_tier_blueprint_uuid_tier_index_pk" PRIMARY KEY("blueprint_uuid","tier_index")
);
--> statement-breakpoint
CREATE TABLE "catalog"."crafted_property" (
	"uuid" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"name_key" text,
	"unit_key" text,
	"display_transformation" jsonb,
	"content_hash" text NOT NULL,
	"first_seen_import_id" integer NOT NULL,
	"last_seen_import_id" integer NOT NULL,
	"retired_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "catalog"."import" (
	"id" serial PRIMARY KEY NOT NULL,
	"channel" text NOT NULL,
	"game_build" integer NOT NULL,
	"game_branch" text NOT NULL,
	"game_version" text NOT NULL,
	"game_label" text,
	"manifest" jsonb,
	"schema_version" integer NOT NULL,
	"snapshot_sha256" text NOT NULL,
	"extractor_version" text NOT NULL,
	"starbreaker_version" text NOT NULL,
	"extracted_at" timestamp with time zone NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"forced" boolean DEFAULT false NOT NULL,
	"summary" jsonb,
	"anomalies" jsonb
);
--> statement-breakpoint
CREATE TABLE "catalog"."item" (
	"uuid" uuid PRIMARY KEY NOT NULL,
	"class_name" text NOT NULL,
	"type" text,
	"sub_type" text,
	"size" integer,
	"grade" integer,
	"manufacturer_uuid" uuid,
	"name_key" text,
	"description_key" text,
	"content_hash" text NOT NULL,
	"first_seen_import_id" integer NOT NULL,
	"last_seen_import_id" integer NOT NULL,
	"retired_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "catalog"."localization" (
	"source" text NOT NULL,
	"lang" text NOT NULL,
	"key" text NOT NULL,
	"value" text NOT NULL,
	CONSTRAINT "localization_source_lang_key_pk" PRIMARY KEY("source","lang","key")
);
--> statement-breakpoint
CREATE TABLE "catalog"."localization_source" (
	"source" text NOT NULL,
	"lang" text NOT NULL,
	"priority" integer NOT NULL,
	"origin" text NOT NULL,
	"content_sha256" text NOT NULL,
	"key_count" integer NOT NULL,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "localization_source_source_lang_pk" PRIMARY KEY("source","lang")
);
--> statement-breakpoint
CREATE TABLE "catalog"."manufacturer" (
	"uuid" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"code" text,
	"name_key" text,
	"description_key" text,
	"content_hash" text NOT NULL,
	"first_seen_import_id" integer NOT NULL,
	"last_seen_import_id" integer NOT NULL,
	"retired_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "catalog"."quality_quantization" (
	"uuid" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"bands" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"first_seen_import_id" integer NOT NULL,
	"last_seen_import_id" integer NOT NULL,
	"retired_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "catalog"."raw_record" (
	"uuid" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"path" text NOT NULL,
	"data" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"first_seen_import_id" integer NOT NULL,
	"last_seen_import_id" integer NOT NULL,
	"retired_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "catalog"."resource" (
	"uuid" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"group_path" text[] NOT NULL,
	"name_key" text,
	"description_key" text,
	"is_ore" boolean NOT NULL,
	"refined_uuid" uuid,
	"density_g_per_cc" numeric,
	"box_sizes_scu" numeric[] NOT NULL,
	"crafting_data" jsonb NOT NULL,
	"data" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"first_seen_import_id" integer NOT NULL,
	"last_seen_import_id" integer NOT NULL,
	"retired_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "catalog"."blueprint" ADD CONSTRAINT "blueprint_category_uuid_blueprint_category_uuid_fk" FOREIGN KEY ("category_uuid") REFERENCES "catalog"."blueprint_category"("uuid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog"."blueprint" ADD CONSTRAINT "blueprint_output_item_uuid_item_uuid_fk" FOREIGN KEY ("output_item_uuid") REFERENCES "catalog"."item"("uuid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog"."blueprint" ADD CONSTRAINT "blueprint_first_seen_import_id_import_id_fk" FOREIGN KEY ("first_seen_import_id") REFERENCES "catalog"."import"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog"."blueprint" ADD CONSTRAINT "blueprint_last_seen_import_id_import_id_fk" FOREIGN KEY ("last_seen_import_id") REFERENCES "catalog"."import"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog"."blueprint_category" ADD CONSTRAINT "blueprint_category_first_seen_import_id_import_id_fk" FOREIGN KEY ("first_seen_import_id") REFERENCES "catalog"."import"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog"."blueprint_category" ADD CONSTRAINT "blueprint_category_last_seen_import_id_import_id_fk" FOREIGN KEY ("last_seen_import_id") REFERENCES "catalog"."import"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog"."blueprint_input" ADD CONSTRAINT "blueprint_input_blueprint_uuid_blueprint_uuid_fk" FOREIGN KEY ("blueprint_uuid") REFERENCES "catalog"."blueprint"("uuid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog"."blueprint_input" ADD CONSTRAINT "blueprint_input_resource_uuid_resource_uuid_fk" FOREIGN KEY ("resource_uuid") REFERENCES "catalog"."resource"("uuid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog"."blueprint_input" ADD CONSTRAINT "blueprint_input_item_uuid_item_uuid_fk" FOREIGN KEY ("item_uuid") REFERENCES "catalog"."item"("uuid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog"."blueprint_slot" ADD CONSTRAINT "blueprint_slot_blueprint_uuid_blueprint_uuid_fk" FOREIGN KEY ("blueprint_uuid") REFERENCES "catalog"."blueprint"("uuid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog"."blueprint_tier" ADD CONSTRAINT "blueprint_tier_blueprint_uuid_blueprint_uuid_fk" FOREIGN KEY ("blueprint_uuid") REFERENCES "catalog"."blueprint"("uuid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog"."crafted_property" ADD CONSTRAINT "crafted_property_first_seen_import_id_import_id_fk" FOREIGN KEY ("first_seen_import_id") REFERENCES "catalog"."import"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog"."crafted_property" ADD CONSTRAINT "crafted_property_last_seen_import_id_import_id_fk" FOREIGN KEY ("last_seen_import_id") REFERENCES "catalog"."import"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog"."item" ADD CONSTRAINT "item_manufacturer_uuid_manufacturer_uuid_fk" FOREIGN KEY ("manufacturer_uuid") REFERENCES "catalog"."manufacturer"("uuid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog"."item" ADD CONSTRAINT "item_first_seen_import_id_import_id_fk" FOREIGN KEY ("first_seen_import_id") REFERENCES "catalog"."import"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog"."item" ADD CONSTRAINT "item_last_seen_import_id_import_id_fk" FOREIGN KEY ("last_seen_import_id") REFERENCES "catalog"."import"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog"."localization" ADD CONSTRAINT "localization_source_lang_localization_source_source_lang_fk" FOREIGN KEY ("source","lang") REFERENCES "catalog"."localization_source"("source","lang") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog"."manufacturer" ADD CONSTRAINT "manufacturer_first_seen_import_id_import_id_fk" FOREIGN KEY ("first_seen_import_id") REFERENCES "catalog"."import"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog"."manufacturer" ADD CONSTRAINT "manufacturer_last_seen_import_id_import_id_fk" FOREIGN KEY ("last_seen_import_id") REFERENCES "catalog"."import"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog"."quality_quantization" ADD CONSTRAINT "quality_quantization_first_seen_import_id_import_id_fk" FOREIGN KEY ("first_seen_import_id") REFERENCES "catalog"."import"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog"."quality_quantization" ADD CONSTRAINT "quality_quantization_last_seen_import_id_import_id_fk" FOREIGN KEY ("last_seen_import_id") REFERENCES "catalog"."import"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog"."raw_record" ADD CONSTRAINT "raw_record_first_seen_import_id_import_id_fk" FOREIGN KEY ("first_seen_import_id") REFERENCES "catalog"."import"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog"."raw_record" ADD CONSTRAINT "raw_record_last_seen_import_id_import_id_fk" FOREIGN KEY ("last_seen_import_id") REFERENCES "catalog"."import"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog"."resource" ADD CONSTRAINT "resource_first_seen_import_id_import_id_fk" FOREIGN KEY ("first_seen_import_id") REFERENCES "catalog"."import"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "catalog"."resource" ADD CONSTRAINT "resource_last_seen_import_id_import_id_fk" FOREIGN KEY ("last_seen_import_id") REFERENCES "catalog"."import"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "blueprint_key_index" ON "catalog"."blueprint" USING btree ("key");--> statement-breakpoint
CREATE INDEX "blueprint_output_item_uuid_index" ON "catalog"."blueprint" USING btree ("output_item_uuid");--> statement-breakpoint
CREATE INDEX "blueprint_input_resource_uuid_index" ON "catalog"."blueprint_input" USING btree ("resource_uuid");--> statement-breakpoint
CREATE INDEX "blueprint_input_item_uuid_index" ON "catalog"."blueprint_input" USING btree ("item_uuid");--> statement-breakpoint
CREATE INDEX "item_class_name_index" ON "catalog"."item" USING btree ("class_name");--> statement-breakpoint
CREATE INDEX "localization_lang_key_index" ON "catalog"."localization" USING btree ("lang","key");--> statement-breakpoint
CREATE INDEX "raw_record_type_index" ON "catalog"."raw_record" USING btree ("type");--> statement-breakpoint
CREATE INDEX "resource_key_index" ON "catalog"."resource" USING btree ("key");--> statement-breakpoint
CREATE VIEW "catalog"."localization_effective" AS (
  SELECT DISTINCT ON (l.lang, l.key) l.lang, l.key, l.value, l.source
  FROM "catalog"."localization" l
  JOIN "catalog"."localization_source" s ON s.source = l.source AND s.lang = l.lang
  ORDER BY l.lang, l.key, s.priority DESC, l.source);