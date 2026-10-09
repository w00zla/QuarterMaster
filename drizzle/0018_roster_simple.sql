-- The roster without a freshness mark: membership is the active member row, kept current by the bot's
-- syncs. A server the bot left has no active members (the bot deactivates them; here for servers it
-- left before). The org trigger of 0016 reads the dropped column: dropped first, recreated without it.
-- The history gets merging a split-off part back.
DROP TRIGGER org_notify_update ON app.org;--> statement-breakpoint
ALTER TABLE "app"."history" DROP CONSTRAINT "history_action";--> statement-breakpoint
ALTER TABLE "app"."org" DROP COLUMN "roster_checked_at";--> statement-breakpoint
ALTER TABLE "app"."history" ADD CONSTRAINT "history_action" CHECK (("app"."history"."category" = 'stock' AND "app"."history"."action" IN ('add', 'remove', 'adjust', 'move', 'share', 'unshare', 'give', 'split', 'merge'))
    OR ("app"."history"."category" = 'refinery' AND "app"."history"."action" IN ('start', 'done', 'remove', 'adjust'))
    OR ("app"."history"."category" = 'blueprint' AND "app"."history"."action" IN ('add', 'remove')));--> statement-breakpoint
UPDATE app.member SET active = false, inactive_since = coalesce(inactive_since, now()), updated_at = now()
  WHERE active AND guild_id IN (SELECT guild_id FROM bot.guild WHERE left_at IS NOT NULL);--> statement-breakpoint
-- Org: name and roles
CREATE TRIGGER org_notify_update AFTER UPDATE ON app.org FOR EACH ROW
  WHEN ((OLD.name, OLD.member_role_ids) IS DISTINCT FROM (NEW.name, NEW.member_role_ids))
  EXECUTE FUNCTION app.notify_change('org', 'guild_id', '');
