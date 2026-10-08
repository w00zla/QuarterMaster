-- The refining method only prefills the estimates when a job is started (web app); it is not stored
ALTER TABLE "app"."stock_batch" DROP CONSTRAINT "stock_batch_refine_job";--> statement-breakpoint
ALTER TABLE "app"."stock_batch" DROP COLUMN "refine_method";--> statement-breakpoint
ALTER TABLE "app"."stock_batch" ADD CONSTRAINT "stock_batch_refine_job" CHECK ("app"."stock_batch"."state" = 'refining' OR ("app"."stock_batch"."refine_started_at" IS NULL
    AND "app"."stock_batch"."refine_ends_at" IS NULL AND "app"."stock_batch"."refine_expected" IS NULL));