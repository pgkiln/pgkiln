-- =====================================================================
-- 161: inbound webhooks (sprint 177): the REST handler type "webhook"
--
-- A REST module handler of type webhook receives another system's events
-- (a payment provider, a code host): POST /a/<alias>/rest/<module>/<path>.
--
--   signature    the request is checked against a shared secret before
--                anything is stored: an HMAC-SHA256 of the raw body in a
--                header (hex or base64, an optional prefix: GitHub's
--                X-Hub-Signature-256: sha256=<hex>), or Stripe's
--                Stripe-Signature (t=…,v1=…: the HMAC of "t.body", with a
--                tolerance for t against replay). The secret is a web
--                credential's (encrypted with the instance key, never
--                exported); the handler names the credential. A wrong or
--                missing signature answers 401.
--   idempotency  the event's id (a field of the JSON body, or a header)
--                is unique per handler: an id seen before answers 200 and
--                nothing happens.
--   processing   the request only stores the event here and answers 202;
--                the server then runs the handler's PL/pgSQL block as the
--                application's database role (NOTIFY pgkiln_webhook_event,
--                polling as the fallback; FOR UPDATE SKIP LOCKED and a
--                lease, so several servers share the queue), with retries
--                and backoff, ending in done or failed.
--
-- The handler's definition (scheme, header, credential name, event id,
-- retention) is part of meta.rest_module.handlers and travels with the
-- application's export. The events are installation data: never exported,
-- readable only by pgkiln's owner connection (the builder shows them to
-- the developers of the application's workspace), removed when their
-- retention ends.
-- =====================================================================

create table meta.webhook_event (
  id              bigserial primary key,
  app_id          int  not null references meta.app on delete cascade,
  module          text not null,
  path            text not null,
  -- the sender's id of the event (null: the handler names none, or the request had none)
  event_key       text check (length(event_key) between 1 and 255),
  headers         jsonb not null default '{}',
  content_type    text,
  body            bytea not null,
  received_at     timestamptz not null default now(),
  purge_after     timestamptz not null default now() + interval '30 days',
  state           text not null default 'received' check (state in ('received', 'running', 'retry', 'done', 'failed')),
  attempts        int  not null default 0,
  max_attempts    int  not null default 5 check (max_attempts between 1 and 20),
  next_attempt_at timestamptz,
  lease_until     timestamptz,
  worker          text,
  error           text,
  processed_at    timestamptz
);
-- an event id is handled once per handler (events without one are all distinct)
create unique index webhook_event_key on meta.webhook_event (app_id, module, path, event_key);
create index webhook_event_due on meta.webhook_event (next_attempt_at, id) where state in ('received', 'retry');
create index webhook_event_running on meta.webhook_event (lease_until) where state = 'running';
create index webhook_event_purge on meta.webhook_event (purge_after);
create index webhook_event_list on meta.webhook_event (app_id, id desc);
revoke all on meta.webhook_event from public;
comment on table meta.webhook_event is
  'events received by REST handlers of type webhook (161): the raw body and selected headers, processed afterwards by the handler''s PL/pgSQL block; installation data, removed after the handler''s retention';
comment on column meta.webhook_event.state is 'received · running · retry (waits for its next attempt) · done · failed (every attempt raised)';
comment on column meta.webhook_event.event_key is 'the sender''s event id: a second request with the same id for the same handler is answered 200 and not stored';

-- The event a webhook handler's block runs for, as JSON: {"id", "event_id" (the sender's), "received_at",
-- "attempt", "content_type", "headers"}. The body is :BODY (text) in the block.
create function meta.webhook_event() returns jsonb
language sql stable set search_path = pg_catalog as $$
  select nullif(current_setting('pgkiln_webhook.event', true), '')::jsonb
$$;
comment on function meta.webhook_event() is 'webhook handlers (161): the event the block runs for: {"id", "event_id", "received_at", "attempt", "content_type", "headers"}';
grant execute on function meta.webhook_event() to public;
