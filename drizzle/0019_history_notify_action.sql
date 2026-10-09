-- The history notice also says what was done (`x`: the action), so the web app can tell an org's
-- members about stock shared there (not only the users it concerns).
CREATE OR REPLACE FUNCTION app.notify_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('qm_changes', json_build_object(
    't', 'history', 'g', NEW.guild_id, 'u', NEW.owner_user_id,
    'id', NEW.id, 's', NEW.source, 'a', NEW.actor_user_id, 'o', NEW.to_owner_user_id, 'x', NEW.action)::text);
  RETURN NULL;
END
$$;
