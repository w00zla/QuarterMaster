-- Refinery jobs hold refined materials only: a running ore batch becomes its refined material with the expected
-- yield as quantity; one without a yield (or a refined material) cannot be converted and is dropped.
DELETE FROM "app"."stock_batch" b WHERE b."state" = 'refining' AND (coalesce(b."refine_expected", 0) <= 0
  OR NOT EXISTS (SELECT 1 FROM "catalog"."resource" r WHERE r."uuid" = b."resource_uuid" AND r."refined_uuid" IS NOT NULL));--> statement-breakpoint
UPDATE "app"."stock_batch" b SET "resource_uuid" = r."refined_uuid", "quantity" = b."refine_expected", "updated_at" = now()
  FROM "catalog"."resource" r WHERE b."state" = 'refining' AND r."uuid" = b."resource_uuid" AND r."is_ore";--> statement-breakpoint
ALTER TABLE "app"."stock_batch" DROP CONSTRAINT "stock_batch_refine_expected";--> statement-breakpoint
ALTER TABLE "app"."stock_batch" DROP CONSTRAINT "stock_batch_refine_job";--> statement-breakpoint
ALTER TABLE "app"."stock_batch" DROP COLUMN "refine_expected";--> statement-breakpoint
ALTER TABLE "app"."stock_batch" ADD CONSTRAINT "stock_batch_refine_job" CHECK ("app"."stock_batch"."state" = 'refining' OR ("app"."stock_batch"."refine_started_at" IS NULL
    AND "app"."stock_batch"."refine_ends_at" IS NULL));
