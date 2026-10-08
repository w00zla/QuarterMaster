ALTER TABLE "app"."stock_batch" DROP CONSTRAINT "stock_batch_merge_key";--> statement-breakpoint
ALTER TABLE "app"."stock_batch" ADD COLUMN "refine_job" uuid;--> statement-breakpoint
-- Refinery jobs become work orders with several ore batches: every job from before is a work order of its own
UPDATE "app"."stock_batch" SET "refine_job" = gen_random_uuid() WHERE "state" = 'refining';--> statement-breakpoint
CREATE INDEX "stock_batch_refine_job_index" ON "app"."stock_batch" USING btree ("refine_job");--> statement-breakpoint
ALTER TABLE "app"."stock_batch" ADD CONSTRAINT "stock_batch_merge_key" UNIQUE NULLS NOT DISTINCT("guild_id","owner_user_id","designation","kind","resource_uuid","item_uuid","location_uuid","state","quality","refine_job");--> statement-breakpoint
ALTER TABLE "app"."stock_batch" ADD CONSTRAINT "stock_batch_refine_job_id" CHECK (("app"."stock_batch"."state" = 'refining') = ("app"."stock_batch"."refine_job" IS NOT NULL));