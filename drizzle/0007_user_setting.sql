CREATE TABLE "web"."user_setting" (
	"user_id" text PRIMARY KEY NOT NULL,
	"lang" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_setting_user_id_format" CHECK ("web"."user_setting"."user_id" ~ '^[0-9]{17,20}$'),
	CONSTRAINT "user_setting_lang" CHECK ("web"."user_setting"."lang" IS NULL OR "web"."user_setting"."lang" IN ('de', 'en'))
);
--> statement-breakpoint
-- Realtime (see 0006): the user's other tabs pick up a changed language
CREATE TRIGGER user_setting_notify AFTER INSERT OR UPDATE OR DELETE ON web.user_setting
  FOR EACH ROW EXECUTE FUNCTION app.notify_change('setting', '', 'user_id');
