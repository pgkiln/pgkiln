-- =====================================================================
-- HR example, part 87: an inbound webhook (sprint 177;
-- docs/guide/13-rest-api.md → "Webhooks").
--
-- POST /a/hr/rest/hr/events/crm receives the sample CRM's events as a
-- webhook: the request must carry X-Signature: sha256=<hex>, the
-- HMAC-SHA256 of the raw body with the secret of the web credential
-- HR_WEBHOOK. The event is stored and answered 202 at once; the handler's
-- block then runs as hr_app and notes it in hr.crm_event. An event id
-- (the body's "id") seen before is answered 200 and not processed again.
--
-- The secret is not in this file (secrets are never in an export): enter
-- one in the builder (Shared Components → Web credentials → HR_WEBHOOK),
-- then:
--
--   body='{"id": "evt-1", "type": "contact.updated", "contact": 3}'
--   sig=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')
--   curl -i -X POST http://127.0.0.1:3100/a/hr/rest/hr/events/crm \
--        -H "Content-Type: application/json" -H "X-Signature: sha256=$sig" -d "$body"
--
-- The events are under SQL Workshop → RESTful Services → Webhook events.
-- =====================================================================

create table hr.crm_event (
  event_id    text primary key,
  kind        text,
  payload     jsonb,
  received_at timestamptz,
  attempt     int
);
grant select, insert on hr.crm_event to hr_app;

insert into meta.web_credential (app_id, name, description, type)
select id, 'HR_WEBHOOK', 'The shared secret that signs the sample CRM''s webhook events (enter it here; POST events/crm of the REST module hr checks it).', 'bearer'
  from meta.app where alias = 'hr';

update meta.rest_module m
   set templates = m.templates || $t$[{"uri": "events/crm", "description": "Events of the sample CRM (a webhook)"}]$t$::jsonb,
       handlers = m.handlers || $h$[
  {"method": "POST", "path": "events/crm", "type": "webhook", "auth": "public",
   "description": "Receives the sample CRM's events: signed with HMAC-SHA256, stored, processed afterwards",
   "source": "insert into hr.crm_event (event_id, kind, payload, received_at, attempt)\nvalues (coalesce(:EVENT_ID, meta.webhook_event() ->> 'id'), :TYPE, :BODY::jsonb,\n        (meta.webhook_event() ->> 'received_at')::timestamptz, (meta.webhook_event() ->> 'attempt')::int)\non conflict (event_id) do nothing",
   "webhook": {"scheme": "hmac-sha256", "credential": "HR_WEBHOOK", "header": "X-Signature", "prefix": "sha256=", "event_id": "body:id",
               "headers": ["X-Crm-Event"], "retention_days": 14, "max_attempts": 3}}
]$h$::jsonb
  from meta.app a
 where a.id = m.app_id and a.alias = 'hr' and m.name = 'hr'
   and not exists (select 1 from jsonb_array_elements(m.handlers) h where h->>'path' = 'events/crm');
