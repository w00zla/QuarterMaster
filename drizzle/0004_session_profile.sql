-- Sessions are ephemeral: existing ones (none in production yet) end here, so the new NOT NULL column needs no default
DELETE FROM "web"."session";--> statement-breakpoint
ALTER TABLE "web"."session" ADD COLUMN "discord_username" text NOT NULL;--> statement-breakpoint
ALTER TABLE "web"."session" ADD COLUMN "discord_global_name" text;--> statement-breakpoint
ALTER TABLE "web"."session" ADD COLUMN "discord_avatar" text;