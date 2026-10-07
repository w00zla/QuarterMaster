-- Realtime for the history: every new row is announced on qm_changes with its id, source and the
-- users it concerns (actor, owner, new owner), so the user web app can show actions from the bot and
-- the companion app as they happen. Like app.notify_change, the payload holds no data itself.
CREATE FUNCTION app.notify_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('qm_changes', json_build_object(
    't', 'history', 'g', NEW.guild_id, 'u', NEW.owner_user_id,
    'id', NEW.id, 's', NEW.source, 'a', NEW.actor_user_id, 'o', NEW.to_owner_user_id)::text);
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE TRIGGER history_notify AFTER INSERT ON app.history
  FOR EACH ROW EXECUTE FUNCTION app.notify_history();
