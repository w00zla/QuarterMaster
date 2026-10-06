CREATE TABLE "ext"."refining_method" (
	"code" text PRIMARY KEY NOT NULL,
	"name_key" text NOT NULL,
	"yield_pct" numeric(5, 2) NOT NULL,
	"seconds_per_scu" integer NOT NULL,
	"source" text NOT NULL,
	"game_version" text NOT NULL,
	CONSTRAINT "refining_method_code_format" CHECK ("ext"."refining_method"."code" ~ '^[A-Z]{3}$'),
	CONSTRAINT "refining_method_yield" CHECK ("ext"."refining_method"."yield_pct" > 0 AND "ext"."refining_method"."yield_pct" <= 100),
	CONSTRAINT "refining_method_seconds" CHECK ("ext"."refining_method"."seconds_per_scu" > 0)
);
--> statement-breakpoint
ALTER TABLE "app"."stock_batch" DROP CONSTRAINT "stock_batch_merge_key";--> statement-breakpoint
ALTER TABLE "app"."stock_batch" ADD COLUMN "refine_method" text;--> statement-breakpoint
ALTER TABLE "app"."stock_batch" ADD COLUMN "refine_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."stock_batch" ADD COLUMN "refine_ends_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."stock_batch" ADD COLUMN "refine_expected" numeric(14, 6);--> statement-breakpoint
ALTER TABLE "app"."stock_batch" ADD CONSTRAINT "stock_batch_merge_key" UNIQUE NULLS NOT DISTINCT("guild_id","owner_user_id","designation","kind","resource_uuid","item_uuid","location_uuid","state","quality","refine_started_at");--> statement-breakpoint
ALTER TABLE "app"."stock_batch" ADD CONSTRAINT "stock_batch_refine_job" CHECK ("app"."stock_batch"."state" = 'refining' OR ("app"."stock_batch"."refine_method" IS NULL AND "app"."stock_batch"."refine_started_at" IS NULL
    AND "app"."stock_batch"."refine_ends_at" IS NULL AND "app"."stock_batch"."refine_expected" IS NULL));--> statement-breakpoint
ALTER TABLE "app"."stock_batch" ADD CONSTRAINT "stock_batch_refine_ends" CHECK ("app"."stock_batch"."refine_ends_at" IS NULL OR "app"."stock_batch"."refine_ends_at" >= "app"."stock_batch"."refine_started_at");--> statement-breakpoint
ALTER TABLE "app"."stock_batch" ADD CONSTRAINT "stock_batch_refine_expected" CHECK ("app"."stock_batch"."refine_expected" IS NULL OR "app"."stock_batch"."refine_expected" >= 0);--> statement-breakpoint
-- Community values (scminer.rocks, Star Citizen 4.10.1; times per SCU of ore). Estimates only: the game computes them server-side.
INSERT INTO "ext"."refining_method" ("code", "name_key", "yield_pct", "seconds_per_scu", "source", "game_version") VALUES
	('DIN', 'refinery_ui_processingtype_slowcareful', 93.3, 69120, 'scminer.rocks', '4.10.1'),
	('FRX', 'refinery_ui_processingtype_normalcareful', 90.0, 34560, 'scminer.rocks', '4.10.1'),
	('PYR', 'refinery_ui_processingtype_fastcareful', 87.5, 34560, 'scminer.rocks', '4.10.1'),
	('EST', 'refinery_ui_processingtype_normalnormal', 85.0, 19200, 'scminer.rocks', '4.10.1'),
	('TND', 'refinery_ui_processingtype_slownormal', 83.0, 34560, 'scminer.rocks', '4.10.1'),
	('GAS', 'refinery_ui_processingtype_fastnormal', 80.0, 9600, 'scminer.rocks', '4.10.1'),
	('COR', 'refinery_ui_processingtype_normalwasteful', 75.0, 9600, 'scminer.rocks', '4.10.1'),
	('KZW', 'refinery_ui_processingtype_slowwasteful', 72.0, 19200, 'scminer.rocks', '4.10.1'),
	('XCR', 'refinery_ui_processingtype_fastwasteful', 70.0, 2880, 'scminer.rocks', '4.10.1');
