CREATE TABLE "app"."feature_entry" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "app"."feature_entry_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"key" text NOT NULL,
	"user_id" text NOT NULL,
	"subject" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"blob" "bytea",
	"blob_type" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feature_entry_user_subject" UNIQUE("key","user_id","subject"),
	CONSTRAINT "feature_entry_user_id_format" CHECK ("app"."feature_entry"."user_id" ~ '^[0-9]{17,20}$'),
	CONSTRAINT "feature_entry_subject" CHECK (length("app"."feature_entry"."subject") BETWEEN 1 AND 200),
	CONSTRAINT "feature_entry_payload" CHECK (jsonb_typeof("app"."feature_entry"."payload") = 'object'),
	CONSTRAINT "feature_entry_blob" CHECK (("app"."feature_entry"."blob" IS NULL) = ("app"."feature_entry"."blob_type" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "app"."privilege" (
	"key" text PRIMARY KEY NOT NULL,
	"description" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	CONSTRAINT "privilege_key_format" CHECK ("app"."privilege"."key" ~ '^[a-z][a-z0-9-]{1,40}$')
);
--> statement-breakpoint
CREATE TABLE "app"."user_privilege" (
	"user_id" text NOT NULL,
	"key" text NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_privilege_user_id_key_pk" PRIMARY KEY("user_id","key"),
	CONSTRAINT "user_privilege_user_id_format" CHECK ("app"."user_privilege"."user_id" ~ '^[0-9]{17,20}$')
);
--> statement-breakpoint
ALTER TABLE "app"."feature_entry" ADD CONSTRAINT "feature_entry_key_privilege_key_fk" FOREIGN KEY ("key") REFERENCES "app"."privilege"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."user_privilege" ADD CONSTRAINT "user_privilege_key_privilege_key_fk" FOREIGN KEY ("key") REFERENCES "app"."privilege"("key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "feature_entry_key_subject_index" ON "app"."feature_entry" USING btree ("key","subject");--> statement-breakpoint
CREATE INDEX "user_privilege_key_index" ON "app"."user_privilege" USING btree ("key");--> statement-breakpoint
-- Realtime (app.notify_change of 0006): a user's privileges changed (their /api/me), a feature's data changed
-- (its key travels as "g": the holders of that key reload)
CREATE TRIGGER user_privilege_notify AFTER INSERT OR UPDATE OR DELETE ON app.user_privilege
  FOR EACH ROW EXECUTE FUNCTION app.notify_change('privilege', '', 'user_id');
--> statement-breakpoint
CREATE TRIGGER feature_entry_notify AFTER INSERT OR UPDATE OR DELETE ON app.feature_entry
  FOR EACH ROW EXECUTE FUNCTION app.notify_change('feature', 'key', 'user_id');
--> statement-breakpoint
-- The first feature: reviewing the item thumbnails in the web app
INSERT INTO app.privilege (key, description) VALUES
  ('thumb-review', 'Thumbnail-Prüfung');
