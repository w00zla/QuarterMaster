DROP TABLE "bot"."heartbeat" CASCADE;--> statement-breakpoint
ALTER TABLE "app"."org" ADD COLUMN "roster_checked_at" timestamp with time zone;