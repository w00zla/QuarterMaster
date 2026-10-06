-- Realtime: every change the user web app shows is announced on the channel qm_changes, whoever
-- writes it (bot, web app, admin, psql). The payload only says what changed ({"t": topic, "g": guild,
-- "u": user}); clients fetch the data through the normal endpoints, which check the rights.
-- pg_notify is delivered on commit, identical payloads within one transaction only once.
CREATE FUNCTION app.notify_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  rec jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    rec := to_jsonb(OLD);
  ELSE
    rec := to_jsonb(NEW);
  END IF;
  -- Arguments: topic, guild column, user column ('' = none)
  PERFORM pg_notify('qm_changes', json_build_object(
    't', TG_ARGV[0],
    'g', rec ->> nullif(TG_ARGV[1], ''),
    'u', rec ->> nullif(TG_ARGV[2], ''))::text);
  RETURN NULL;
END
$$;
--> statement-breakpoint
-- Roster: joins, leaves, role and name changes (not the inactive rows' updated_at churn)
CREATE TRIGGER member_notify_insert_delete AFTER INSERT OR DELETE ON app.member
  FOR EACH ROW EXECUTE FUNCTION app.notify_change('member', 'guild_id', 'user_id');
--> statement-breakpoint
CREATE TRIGGER member_notify_update AFTER UPDATE ON app.member FOR EACH ROW
  WHEN ((OLD.active, OLD.officer, OLD.display_name) IS DISTINCT FROM (NEW.active, NEW.officer, NEW.display_name))
  EXECUTE FUNCTION app.notify_change('member', 'guild_id', 'user_id');
--> statement-breakpoint
-- Org: name, roles, and the roster freshness flipping (not the bot's minute beat)
CREATE TRIGGER org_notify_insert AFTER INSERT ON app.org
  FOR EACH ROW EXECUTE FUNCTION app.notify_change('org', 'guild_id', '');
--> statement-breakpoint
CREATE TRIGGER org_notify_update AFTER UPDATE ON app.org FOR EACH ROW
  WHEN ((OLD.name, OLD.member_role_ids, OLD.officer_role_ids, OLD.roster_checked_at IS NULL)
    IS DISTINCT FROM (NEW.name, NEW.member_role_ids, NEW.officer_role_ids, NEW.roster_checked_at IS NULL))
  EXECUTE FUNCTION app.notify_change('org', 'guild_id', '');
--> statement-breakpoint
-- The bot left or rejoined the server
CREATE TRIGGER guild_notify_presence AFTER UPDATE ON bot.guild FOR EACH ROW
  WHEN ((OLD.left_at IS NULL) IS DISTINCT FROM (NEW.left_at IS NULL))
  EXECUTE FUNCTION app.notify_change('org', 'guild_id', '');
--> statement-breakpoint
-- Stock: personal (no guild, the owner) or org stock
CREATE TRIGGER stock_batch_notify AFTER INSERT OR UPDATE OR DELETE ON app.stock_batch
  FOR EACH ROW EXECUTE FUNCTION app.notify_change('stock', 'guild_id', 'owner_user_id');
--> statement-breakpoint
-- Blueprint registry (visible to the user's orgs)
CREATE TRIGGER user_blueprint_notify AFTER INSERT OR DELETE ON app.user_blueprint
  FOR EACH ROW EXECUTE FUNCTION app.notify_change('blueprint', '', 'user_id');
--> statement-breakpoint
-- Profile shown to the user's orgs (RSI handle)
CREATE TRIGGER app_user_notify_update AFTER UPDATE ON app.app_user FOR EACH ROW
  WHEN (OLD.rsi_handle IS DISTINCT FROM NEW.rsi_handle)
  EXECUTE FUNCTION app.notify_change('user', '', 'user_id');
