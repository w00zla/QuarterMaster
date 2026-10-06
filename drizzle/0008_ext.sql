CREATE SCHEMA "ext";
--> statement-breakpoint
CREATE TABLE "ext"."snapshot" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "ext"."snapshot_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"source" text NOT NULL,
	"endpoint" text NOT NULL,
	"content_hash" text NOT NULL,
	"data" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "snapshot_content_hash_format" CHECK ("ext"."snapshot"."content_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE INDEX "snapshot_source_endpoint_id_index" ON "ext"."snapshot" USING btree ("source","endpoint","id");