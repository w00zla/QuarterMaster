ALTER TABLE "bot"."guild" DROP CONSTRAINT "guild_logs_level";--> statement-breakpoint
ALTER TABLE "bot"."guild" ALTER COLUMN "logs_level" SET DEFAULT 'stock';--> statement-breakpoint
-- The former level 'org' is now 'stock' (the shared stock); blueprints come as a level of their own
UPDATE "bot"."guild" SET "logs_level" = 'stock' WHERE "logs_level" = 'org';--> statement-breakpoint
ALTER TABLE "bot"."guild" ADD CONSTRAINT "guild_logs_level" CHECK ("bot"."guild"."logs_level" IN ('off', 'stock', 'blueprints', 'all'));