-- Publish request changes on a Postgres channel. Every writer (API, workers, sweeper)
-- emits events without extra code, and every API replica can listen.
CREATE OR REPLACE FUNCTION notify_request_change() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify(
    'request_events',
    json_build_object(
      'id', NEW.id,
      'status', NEW.status,
      'previousStatus', CASE WHEN TG_OP = 'UPDATE' THEN OLD.status ELSE NULL END,
      'category', NEW.category,
      'priority', NEW.priority,
      'at', NEW.updated_at
    )::text
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER requests_notify
AFTER INSERT OR UPDATE OF status ON requests
FOR EACH ROW EXECUTE FUNCTION notify_request_change();
