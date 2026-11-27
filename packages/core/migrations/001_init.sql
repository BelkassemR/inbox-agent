-- Core schema for Inbox Agent.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  external_id   text NOT NULL,
  channel       text NOT NULL CHECK (channel IN ('email', 'form', 'dm', 'webhook')),
  sender_name   text NOT NULL,
  sender_email  text,
  subject       text,
  body          text NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  status        text NOT NULL DEFAULT 'received'
                CHECK (status IN ('received','queued','processing','needs_review','approved','rejected','sent','failed')),
  category      text,
  priority      text,
  extracted     jsonb,
  summary       text,
  draft_reply   text,
  risk_flags    text[] NOT NULL DEFAULT '{}',
  agent_trace   jsonb,
  error         text,
  reviewed_by   text,
  reviewed_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- Idempotency: the same upstream message can be delivered more than once.
  CONSTRAINT requests_channel_external_id_key UNIQUE (channel, external_id)
);

CREATE INDEX requests_status_received_idx ON requests (status, received_at DESC);
CREATE INDEX requests_sender_email_idx ON requests (lower(sender_email));

CREATE TABLE contacts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  email         text,
  organization  text,
  tags          text[] NOT NULL DEFAULT '{}',
  notes         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX contacts_email_key ON contacts (lower(email)) WHERE email IS NOT NULL;
CREATE INDEX contacts_name_idx ON contacts (lower(name));

CREATE TABLE calendar_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('show', 'hold', 'studio', 'travel', 'private')),
  status      text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'tentative')),
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz NOT NULL,
  location    text,
  request_id  uuid REFERENCES requests(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);

CREATE INDEX calendar_events_range_idx ON calendar_events (starts_at, ends_at);
-- At most one hold per request per day, so agent retries can't pile up duplicate holds.
CREATE UNIQUE INDEX calendar_events_request_day_key
  ON calendar_events (request_id, ((starts_at AT TIME ZONE 'UTC')::date))
  WHERE request_id IS NOT NULL;

CREATE TABLE rate_cards (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type   text NOT NULL,
  region       text NOT NULL,
  min_fee_eur  integer NOT NULL CHECK (min_fee_eur >= 0),
  notes        text,
  UNIQUE (event_type, region)
);

CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  actor       text NOT NULL,
  action      text NOT NULL,
  request_id  uuid REFERENCES requests(id) ON DELETE CASCADE,
  details     jsonb NOT NULL DEFAULT '{}'
);

CREATE INDEX audit_log_request_idx ON audit_log (request_id, at);
