CREATE SCHEMA "web";
--> statement-breakpoint
CREATE TABLE "bot"."heartbeat" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"at" timestamp with time zone NOT NULL,
	CONSTRAINT "heartbeat_single_row" CHECK ("bot"."heartbeat"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "web"."session" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "session_token_hash_format" CHECK ("web"."session"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "session_user_id_format" CHECK ("web"."session"."user_id" ~ '^[0-9]{17,20}$')
);
--> statement-breakpoint
ALTER TABLE "app"."member" ADD COLUMN "officer" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "session_user_id_index" ON "web"."session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_expires_at_index" ON "web"."session" USING btree ("expires_at");