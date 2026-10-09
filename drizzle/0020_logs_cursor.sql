DROP TABLE "bot"."logs_outbox" CASCADE;--> statement-breakpoint
ALTER TABLE "bot"."guild" ADD COLUMN "logs_after" bigint;