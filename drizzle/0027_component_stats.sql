ALTER TABLE "app"."stock_batch" DROP CONSTRAINT "stock_batch_merge_key";--> statement-breakpoint
ALTER TABLE "app"."stock_batch" ADD COLUMN "stats" jsonb;--> statement-breakpoint
ALTER TABLE "app"."stock_journal" ADD COLUMN "stats" jsonb;--> statement-breakpoint
ALTER TABLE "app"."stock_batch" ADD CONSTRAINT "stock_batch_merge_key" UNIQUE NULLS NOT DISTINCT("owner_user_id","kind","resource_uuid","item_uuid","location_uuid","state","quality","refine_job","lot","stats");--> statement-breakpoint
ALTER TABLE "app"."stock_batch" ADD CONSTRAINT "stock_batch_stats" CHECK ("app"."stock_batch"."stats" IS NULL OR ("app"."stock_batch"."kind" = 'item' AND jsonb_typeof("app"."stock_batch"."stats") = 'object'));