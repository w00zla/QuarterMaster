-- Shares: a batch is offered in any number of its owner's orgs (app.stock_share) instead of belonging
-- to one org (stock_batch.guild_id/designation, dropped). A split-off part keeps its own `lot` in the
-- merge key. The journal loses its org columns (sharing changes no quantity). Existing org batches
-- become shares; batches the new merge key would hold twice are merged.
CREATE TABLE "app"."stock_share" (
	"batch_id" bigint NOT NULL,
	"guild_id" text NOT NULL,
	"shared_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "stock_share_batch_id_guild_id_pk" PRIMARY KEY("batch_id","guild_id")
);
--> statement-breakpoint
ALTER TABLE "app"."stock_batch" DROP CONSTRAINT "stock_batch_merge_key";--> statement-breakpoint
ALTER TABLE "app"."history" DROP CONSTRAINT "history_action";--> statement-breakpoint
ALTER TABLE "app"."stock_batch" DROP CONSTRAINT "stock_batch_designation";--> statement-breakpoint
ALTER TABLE "app"."stock_batch" DROP CONSTRAINT "stock_batch_personal_global";--> statement-breakpoint
ALTER TABLE "app"."stock_batch" DROP CONSTRAINT "stock_batch_refining_personal";--> statement-breakpoint
ALTER TABLE "app"."stock_journal" DROP CONSTRAINT "stock_journal_personal_global";--> statement-breakpoint
ALTER TABLE "app"."stock_journal" DROP CONSTRAINT "stock_journal_designation";--> statement-breakpoint
ALTER TABLE "app"."stock_journal" DROP CONSTRAINT "stock_journal_refining_personal";--> statement-breakpoint
ALTER TABLE "app"."stock_batch" DROP CONSTRAINT "stock_batch_guild_id_owner_user_id_member_guild_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "app"."stock_journal" DROP CONSTRAINT "stock_journal_guild_id_actor_user_id_member_guild_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "app"."stock_journal" DROP CONSTRAINT "stock_journal_guild_id_owner_user_id_member_guild_id_user_id_fk";
--> statement-breakpoint
DROP INDEX "app"."stock_batch_guild_id_resource_uuid_index";--> statement-breakpoint
DROP INDEX "app"."stock_batch_guild_id_item_uuid_index";--> statement-breakpoint
DROP INDEX "app"."stock_batch_owner_user_id_guild_id_index";--> statement-breakpoint
DROP INDEX "app"."stock_batch_guild_id_location_uuid_index";--> statement-breakpoint
DROP INDEX "app"."stock_journal_guild_id_created_at_index";--> statement-breakpoint
DROP INDEX "app"."stock_journal_owner_user_id_guild_id_created_at_index";--> statement-breakpoint
ALTER TABLE "app"."stock_batch" ADD COLUMN "lot" uuid;--> statement-breakpoint
ALTER TABLE "app"."stock_share" ADD CONSTRAINT "stock_share_batch_id_stock_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "app"."stock_batch"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."stock_share" ADD CONSTRAINT "stock_share_guild_id_org_guild_id_fk" FOREIGN KEY ("guild_id") REFERENCES "app"."org"("guild_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stock_share_guild_id_index" ON "app"."stock_share" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX "stock_batch_owner_user_id_index" ON "app"."stock_batch" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "stock_journal_owner_user_id_created_at_index" ON "app"."stock_journal" USING btree ("owner_user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
-- Org batches become shares of the same batch
INSERT INTO app.stock_share (batch_id, guild_id) SELECT id, guild_id FROM app.stock_batch WHERE guild_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."stock_batch" DROP COLUMN "guild_id";--> statement-breakpoint
ALTER TABLE "app"."stock_batch" DROP COLUMN "designation";--> statement-breakpoint
ALTER TABLE "app"."stock_journal" DROP COLUMN "guild_id";--> statement-breakpoint
ALTER TABLE "app"."stock_journal" DROP COLUMN "designation";--> statement-breakpoint
-- Batches that differed only by their org: the oldest keeps the sum and every share, the others go
CREATE TEMP TABLE batch_merge ON COMMIT DROP AS
  SELECT id, first_value(id) OVER w AS keep, sum(quantity) OVER w AS total, count(*) OVER w AS n
  FROM app.stock_batch
  WINDOW w AS (PARTITION BY owner_user_id, kind, resource_uuid, item_uuid, location_uuid, state, quality, refine_job, lot
    ORDER BY id ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING);--> statement-breakpoint
INSERT INTO app.stock_share (batch_id, guild_id)
  SELECT m.keep, s.guild_id FROM app.stock_share s JOIN batch_merge m ON m.id = s.batch_id WHERE m.id <> m.keep
  ON CONFLICT DO NOTHING;--> statement-breakpoint
UPDATE app.stock_batch b SET quantity = m.total FROM batch_merge m WHERE b.id = m.id AND m.id = m.keep AND m.n > 1;--> statement-breakpoint
DELETE FROM app.stock_batch b USING batch_merge m WHERE b.id = m.id AND m.id <> m.keep;--> statement-breakpoint
ALTER TABLE "app"."stock_batch" ADD CONSTRAINT "stock_batch_merge_key" UNIQUE NULLS NOT DISTINCT("owner_user_id","kind","resource_uuid","item_uuid","location_uuid","state","quality","refine_job","lot");--> statement-breakpoint
ALTER TABLE "app"."history" ADD CONSTRAINT "history_action" CHECK (("app"."history"."category" = 'stock' AND "app"."history"."action" IN ('add', 'remove', 'adjust', 'move', 'share', 'unshare', 'give', 'split'))
    OR ("app"."history"."category" = 'refinery' AND "app"."history"."action" IN ('start', 'done', 'remove', 'adjust'))
    OR ("app"."history"."category" = 'blueprint' AND "app"."history"."action" IN ('add', 'remove')));--> statement-breakpoint
-- Realtime: a batch concerns its owner and every org it is shared in; a share coming or going concerns
-- that org and the owner (whose own list marks shared batches). Replaces 0006's stock_batch trigger.
DROP TRIGGER stock_batch_notify ON app.stock_batch;--> statement-breakpoint
CREATE FUNCTION app.notify_stock() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  rec record;
BEGIN
  IF TG_OP = 'DELETE' THEN
    rec := OLD;
  ELSE
    rec := NEW;
  END IF;
  IF TG_TABLE_NAME = 'stock_share' THEN
    PERFORM pg_notify('qm_changes', json_build_object('t', 'stock', 'g', rec.guild_id, 'u', NULL)::text);
    -- Gone already when the share went with its batch: the batch's own trigger told the owner
    PERFORM pg_notify('qm_changes', json_build_object('t', 'stock', 'g', NULL, 'u', b.owner_user_id)::text)
      FROM app.stock_batch b WHERE b.id = rec.batch_id;
  ELSE
    PERFORM pg_notify('qm_changes', json_build_object('t', 'stock', 'g', NULL, 'u', rec.owner_user_id)::text);
    PERFORM pg_notify('qm_changes', json_build_object('t', 'stock', 'g', s.guild_id, 'u', rec.owner_user_id)::text)
      FROM app.stock_share s WHERE s.batch_id = rec.id;
  END IF;
  RETURN NULL;
END
$$;--> statement-breakpoint
CREATE TRIGGER stock_batch_notify AFTER INSERT OR UPDATE OR DELETE ON app.stock_batch
  FOR EACH ROW EXECUTE FUNCTION app.notify_stock();--> statement-breakpoint
CREATE TRIGGER stock_share_notify AFTER INSERT OR DELETE ON app.stock_share
  FOR EACH ROW EXECUTE FUNCTION app.notify_stock();
