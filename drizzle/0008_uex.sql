CREATE SCHEMA "uex";
--> statement-breakpoint
CREATE TABLE "uex"."snapshot" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "uex"."snapshot_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"endpoint" text NOT NULL,
	"content_hash" text NOT NULL,
	"data" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "snapshot_content_hash_format" CHECK ("uex"."snapshot"."content_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE INDEX "snapshot_endpoint_id_index" ON "uex"."snapshot" USING btree ("endpoint","id");