CREATE TABLE "web"."api_token" (
	"user_id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"discord_username" text NOT NULL,
	"discord_global_name" text,
	"discord_avatar" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "api_token_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "api_token_user_id_format" CHECK ("web"."api_token"."user_id" ~ '^[0-9]{17,20}$'),
	CONSTRAINT "api_token_token_hash_format" CHECK ("web"."api_token"."token_hash" ~ '^[0-9a-f]{64}$')
);
