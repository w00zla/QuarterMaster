ALTER TABLE "bot"."guild" ADD COLUMN "board_channel_id" text;--> statement-breakpoint
ALTER TABLE "bot"."guild" ADD COLUMN "board_message_id" text;--> statement-breakpoint
ALTER TABLE "bot"."guild" ADD CONSTRAINT "guild_board_channel_id_format" CHECK ("bot"."guild"."board_channel_id" IS NULL OR "bot"."guild"."board_channel_id" ~ '^[0-9]{17,20}$');--> statement-breakpoint
ALTER TABLE "bot"."guild" ADD CONSTRAINT "guild_board_message_id_format" CHECK ("bot"."guild"."board_message_id" IS NULL OR "bot"."guild"."board_message_id" ~ '^[0-9]{17,20}$');