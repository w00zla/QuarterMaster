CREATE TABLE "app"."history" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "app"."history_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source" text NOT NULL,
	"category" text NOT NULL,
	"action" text NOT NULL,
	"actor_user_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"to_owner_user_id" text,
	"guild_id" text,
	"target_kind" text NOT NULL,
	"target_uuid" uuid NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "history_source" CHECK ("app"."history"."source" IN ('bot', 'webapp', 'companion')),
	CONSTRAINT "history_action" CHECK (("app"."history"."category" = 'stock' AND "app"."history"."action" IN ('add', 'remove', 'adjust', 'move'))
    OR ("app"."history"."category" = 'refinery' AND "app"."history"."action" IN ('start', 'done', 'remove', 'adjust'))
    OR ("app"."history"."category" = 'blueprint' AND "app"."history"."action" IN ('add', 'remove'))),
	CONSTRAINT "history_target" CHECK (("app"."history"."category" = 'blueprint') = ("app"."history"."target_kind" = 'blueprint')
    AND "app"."history"."target_kind" IN ('resource', 'item', 'blueprint')),
	CONSTRAINT "history_users" CHECK ("app"."history"."actor_user_id" ~ '^[0-9]{17,20}$' AND "app"."history"."owner_user_id" ~ '^[0-9]{17,20}$'
    AND ("app"."history"."to_owner_user_id" IS NULL OR "app"."history"."to_owner_user_id" ~ '^[0-9]{17,20}$') AND ("app"."history"."guild_id" IS NULL OR "app"."history"."guild_id" ~ '^[0-9]{17,20}$'))
);
--> statement-breakpoint
CREATE INDEX "history_actor_user_id_id_index" ON "app"."history" USING btree ("actor_user_id","id");--> statement-breakpoint
CREATE INDEX "history_owner_user_id_id_index" ON "app"."history" USING btree ("owner_user_id","id");--> statement-breakpoint
CREATE INDEX "history_to_owner_user_id_id_index" ON "app"."history" USING btree ("to_owner_user_id","id");