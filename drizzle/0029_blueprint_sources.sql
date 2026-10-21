CREATE TABLE "catalog"."blueprint_source" (
	"blueprint_uuid" uuid NOT NULL,
	"source_index" integer NOT NULL,
	"kind" text NOT NULL,
	"pool_uuid" uuid NOT NULL,
	"pool_key" text NOT NULL,
	"weight" numeric NOT NULL,
	"pool_weight" numeric NOT NULL,
	"contract_id" uuid,
	"contract_key" text,
	"title_key" text,
	"mission_type_key" text,
	"faction_uuid" uuid,
	"faction_name_key" text,
	"min_rank_name_key" text,
	"min_reputation" numeric,
	"locality_uuids" uuid[] NOT NULL,
	"location_uuids" uuid[] NOT NULL,
	"requires_previous" boolean NOT NULL,
	"illegal" boolean NOT NULL,
	"chance" numeric,
	"on_accept" boolean NOT NULL,
	"event_key" text,
	"min_points" integer,
	CONSTRAINT "blueprint_source_blueprint_uuid_source_index_pk" PRIMARY KEY("blueprint_uuid","source_index"),
	CONSTRAINT "blueprint_source_kind" CHECK ("catalog"."blueprint_source"."kind" IN ('mission', 'event'))
);
--> statement-breakpoint
ALTER TABLE "catalog"."blueprint_source" ADD CONSTRAINT "blueprint_source_blueprint_uuid_blueprint_uuid_fk" FOREIGN KEY ("blueprint_uuid") REFERENCES "catalog"."blueprint"("uuid") ON DELETE no action ON UPDATE no action;