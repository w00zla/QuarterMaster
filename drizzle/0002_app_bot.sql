CREATE SCHEMA "app";
--> statement-breakpoint
CREATE SCHEMA "bot";
--> statement-breakpoint
CREATE TABLE "app"."app_user" (
	"user_id" text PRIMARY KEY NOT NULL,
	"rsi_handle" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_user_id_format" CHECK ("app"."app_user"."user_id" ~ '^[0-9]{17,20}$')
);
--> statement-breakpoint
CREATE TABLE "app"."member" (
	"guild_id" text NOT NULL,
	"user_id" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"display_name" text NOT NULL,
	"default_location_uuid" uuid,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"inactive_since" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_guild_id_user_id_pk" PRIMARY KEY("guild_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "app"."org" (
	"guild_id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"member_role_ids" text[] DEFAULT '{}' NOT NULL,
	"officer_role_ids" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_guild_id_format" CHECK ("app"."org"."guild_id" ~ '^[0-9]{17,20}$')
);
--> statement-breakpoint
CREATE TABLE "app"."stock_batch" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "app"."stock_batch_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"guild_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"designation" text NOT NULL,
	"kind" text NOT NULL,
	"resource_uuid" uuid,
	"item_uuid" uuid,
	"location_uuid" uuid NOT NULL,
	"state" text DEFAULT 'stored' NOT NULL,
	"quality" integer NOT NULL,
	"quantity" numeric(14, 6) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_batch_merge_key" UNIQUE NULLS NOT DISTINCT("guild_id","owner_user_id","designation","kind","resource_uuid","item_uuid","location_uuid","state","quality"),
	CONSTRAINT "stock_batch_designation" CHECK ("app"."stock_batch"."designation" IN ('personal', 'org')),
	CONSTRAINT "stock_batch_kind" CHECK (("app"."stock_batch"."kind" = 'resource' AND "app"."stock_batch"."resource_uuid" IS NOT NULL AND "app"."stock_batch"."item_uuid" IS NULL)
    OR ("app"."stock_batch"."kind" = 'item' AND "app"."stock_batch"."item_uuid" IS NOT NULL AND "app"."stock_batch"."resource_uuid" IS NULL)),
	CONSTRAINT "stock_batch_state" CHECK ("app"."stock_batch"."state" IN ('stored', 'refining')),
	CONSTRAINT "stock_batch_refining_resource" CHECK ("app"."stock_batch"."state" = 'stored' OR "app"."stock_batch"."kind" = 'resource'),
	CONSTRAINT "stock_batch_quality" CHECK ("app"."stock_batch"."quality" BETWEEN 0 AND 1000),
	CONSTRAINT "stock_batch_quantity" CHECK ("app"."stock_batch"."quantity" > 0),
	CONSTRAINT "stock_batch_item_pieces" CHECK ("app"."stock_batch"."kind" = 'resource' OR "app"."stock_batch"."quantity" = trunc("app"."stock_batch"."quantity"))
);
--> statement-breakpoint
CREATE TABLE "app"."stock_journal" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "app"."stock_journal_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"guild_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"action" text NOT NULL,
	"group_id" uuid,
	"actor_user_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"designation" text NOT NULL,
	"kind" text NOT NULL,
	"resource_uuid" uuid,
	"item_uuid" uuid,
	"location_uuid" uuid NOT NULL,
	"state" text NOT NULL,
	"quality" integer NOT NULL,
	"delta" numeric(14, 6) NOT NULL,
	"note" text,
	CONSTRAINT "stock_journal_action" CHECK ("app"."stock_journal"."action" IN ('add', 'remove', 'adjust', 'move_out', 'move_in', 'refine_out', 'refine_in')),
	CONSTRAINT "stock_journal_group" CHECK (("app"."stock_journal"."action" IN ('move_out', 'move_in', 'refine_out', 'refine_in')) = ("app"."stock_journal"."group_id" IS NOT NULL)),
	CONSTRAINT "stock_journal_designation" CHECK ("app"."stock_journal"."designation" IN ('personal', 'org')),
	CONSTRAINT "stock_journal_kind" CHECK (("app"."stock_journal"."kind" = 'resource' AND "app"."stock_journal"."resource_uuid" IS NOT NULL AND "app"."stock_journal"."item_uuid" IS NULL)
    OR ("app"."stock_journal"."kind" = 'item' AND "app"."stock_journal"."item_uuid" IS NOT NULL AND "app"."stock_journal"."resource_uuid" IS NULL)),
	CONSTRAINT "stock_journal_state" CHECK ("app"."stock_journal"."state" IN ('stored', 'refining')),
	CONSTRAINT "stock_journal_quality" CHECK ("app"."stock_journal"."quality" BETWEEN 0 AND 1000),
	CONSTRAINT "stock_journal_delta" CHECK ("app"."stock_journal"."delta" <> 0)
);
--> statement-breakpoint
CREATE TABLE "app"."user_blueprint" (
	"user_id" text NOT NULL,
	"blueprint_uuid" uuid NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_blueprint_user_id_blueprint_uuid_pk" PRIMARY KEY("user_id","blueprint_uuid")
);
--> statement-breakpoint
CREATE TABLE "bot"."guild" (
	"guild_id" text PRIMARY KEY NOT NULL,
	"base_lang" text DEFAULT 'en' NOT NULL,
	"logs_channel_id" text,
	"logs_level" text DEFAULT 'org' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guild_logs_channel_id_format" CHECK ("bot"."guild"."logs_channel_id" IS NULL OR "bot"."guild"."logs_channel_id" ~ '^[0-9]{17,20}$'),
	CONSTRAINT "guild_base_lang" CHECK ("bot"."guild"."base_lang" IN ('de', 'en')),
	CONSTRAINT "guild_logs_level" CHECK ("bot"."guild"."logs_level" IN ('off', 'org', 'all'))
);
--> statement-breakpoint
CREATE TABLE "bot"."logs_outbox" (
	"journal_id" bigint PRIMARY KEY NOT NULL,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bot"."user_config" (
	"user_id" text PRIMARY KEY NOT NULL,
	"lang_override" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_config_lang_override" CHECK ("bot"."user_config"."lang_override" IS NULL OR "bot"."user_config"."lang_override" IN ('de', 'en'))
);
--> statement-breakpoint
ALTER TABLE "app"."member" ADD CONSTRAINT "member_guild_id_org_guild_id_fk" FOREIGN KEY ("guild_id") REFERENCES "app"."org"("guild_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."member" ADD CONSTRAINT "member_user_id_app_user_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."app_user"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."member" ADD CONSTRAINT "member_default_location_uuid_location_uuid_fk" FOREIGN KEY ("default_location_uuid") REFERENCES "catalog"."location"("uuid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."stock_batch" ADD CONSTRAINT "stock_batch_resource_uuid_resource_uuid_fk" FOREIGN KEY ("resource_uuid") REFERENCES "catalog"."resource"("uuid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."stock_batch" ADD CONSTRAINT "stock_batch_item_uuid_item_uuid_fk" FOREIGN KEY ("item_uuid") REFERENCES "catalog"."item"("uuid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."stock_batch" ADD CONSTRAINT "stock_batch_location_uuid_location_uuid_fk" FOREIGN KEY ("location_uuid") REFERENCES "catalog"."location"("uuid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."stock_batch" ADD CONSTRAINT "stock_batch_guild_id_owner_user_id_member_guild_id_user_id_fk" FOREIGN KEY ("guild_id","owner_user_id") REFERENCES "app"."member"("guild_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."stock_journal" ADD CONSTRAINT "stock_journal_resource_uuid_resource_uuid_fk" FOREIGN KEY ("resource_uuid") REFERENCES "catalog"."resource"("uuid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."stock_journal" ADD CONSTRAINT "stock_journal_item_uuid_item_uuid_fk" FOREIGN KEY ("item_uuid") REFERENCES "catalog"."item"("uuid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."stock_journal" ADD CONSTRAINT "stock_journal_location_uuid_location_uuid_fk" FOREIGN KEY ("location_uuid") REFERENCES "catalog"."location"("uuid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."stock_journal" ADD CONSTRAINT "stock_journal_guild_id_actor_user_id_member_guild_id_user_id_fk" FOREIGN KEY ("guild_id","actor_user_id") REFERENCES "app"."member"("guild_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."stock_journal" ADD CONSTRAINT "stock_journal_guild_id_owner_user_id_member_guild_id_user_id_fk" FOREIGN KEY ("guild_id","owner_user_id") REFERENCES "app"."member"("guild_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."user_blueprint" ADD CONSTRAINT "user_blueprint_user_id_app_user_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."app_user"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."user_blueprint" ADD CONSTRAINT "user_blueprint_blueprint_uuid_blueprint_uuid_fk" FOREIGN KEY ("blueprint_uuid") REFERENCES "catalog"."blueprint"("uuid") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot"."guild" ADD CONSTRAINT "guild_guild_id_org_guild_id_fk" FOREIGN KEY ("guild_id") REFERENCES "app"."org"("guild_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot"."logs_outbox" ADD CONSTRAINT "logs_outbox_journal_id_stock_journal_id_fk" FOREIGN KEY ("journal_id") REFERENCES "app"."stock_journal"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot"."user_config" ADD CONSTRAINT "user_config_user_id_app_user_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."app_user"("user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stock_batch_guild_id_resource_uuid_index" ON "app"."stock_batch" USING btree ("guild_id","resource_uuid");--> statement-breakpoint
CREATE INDEX "stock_batch_guild_id_item_uuid_index" ON "app"."stock_batch" USING btree ("guild_id","item_uuid");--> statement-breakpoint
CREATE INDEX "stock_batch_guild_id_owner_user_id_index" ON "app"."stock_batch" USING btree ("guild_id","owner_user_id");--> statement-breakpoint
CREATE INDEX "stock_batch_guild_id_location_uuid_index" ON "app"."stock_batch" USING btree ("guild_id","location_uuid");--> statement-breakpoint
CREATE INDEX "stock_journal_guild_id_created_at_index" ON "app"."stock_journal" USING btree ("guild_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "stock_journal_group_id_index" ON "app"."stock_journal" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "stock_journal_guild_id_owner_user_id_created_at_index" ON "app"."stock_journal" USING btree ("guild_id","owner_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "user_blueprint_blueprint_uuid_index" ON "app"."user_blueprint" USING btree ("blueprint_uuid");