-- Stock ownership: every batch belongs to one user, shared stock is offered by its owner. The officer
-- role goes away everywhere. The roster and org change triggers of 0006 read the dropped columns:
-- dropped first, recreated without them.
DROP TRIGGER member_notify_update ON app.member;--> statement-breakpoint
DROP TRIGGER org_notify_update ON app.org;--> statement-breakpoint
ALTER TABLE "app"."history" DROP CONSTRAINT "history_action";--> statement-breakpoint
ALTER TABLE "app"."member" DROP COLUMN "officer";--> statement-breakpoint
ALTER TABLE "app"."org" DROP COLUMN "officer_role_ids";--> statement-breakpoint
ALTER TABLE "app"."history" ADD CONSTRAINT "history_action" CHECK (("app"."history"."category" = 'stock' AND "app"."history"."action" IN ('add', 'remove', 'adjust', 'move', 'share', 'unshare', 'give'))
    OR ("app"."history"."category" = 'refinery' AND "app"."history"."action" IN ('start', 'done', 'remove', 'adjust'))
    OR ("app"."history"."category" = 'blueprint' AND "app"."history"."action" IN ('add', 'remove')));--> statement-breakpoint
-- Roster: joins, leaves and name changes (not the inactive rows' updated_at churn)
CREATE TRIGGER member_notify_update AFTER UPDATE ON app.member FOR EACH ROW
  WHEN ((OLD.active, OLD.display_name) IS DISTINCT FROM (NEW.active, NEW.display_name))
  EXECUTE FUNCTION app.notify_change('member', 'guild_id', 'user_id');--> statement-breakpoint
-- Org: name, roles, and the roster freshness flipping (not the bot's minute beat)
CREATE TRIGGER org_notify_update AFTER UPDATE ON app.org FOR EACH ROW
  WHEN ((OLD.name, OLD.member_role_ids, OLD.roster_checked_at IS NULL)
    IS DISTINCT FROM (NEW.name, NEW.member_role_ids, NEW.roster_checked_at IS NULL))
  EXECUTE FUNCTION app.notify_change('org', 'guild_id', '');
