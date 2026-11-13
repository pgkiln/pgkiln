-- =====================================================================
-- HR example, part 86: meta.web_request as an outbox (sprint 177;
-- docs/guide/09-reference.md → "Web requests from SQL").
--
-- Page 35 "Parse and fetch" gains "Fetch in the background": the request
-- to the sample CRM is queued with a callback, an ordering key and three
-- attempts. The server sends it when the submit has committed (at once:
-- queueing notifies it), tries again after a network error, a 5xx or a
-- 429 answer, and then calls hr.contacts_fetched(request id) as the
-- application's role, which notes the outcome in hr.contact_fetch. The
-- report "Background requests" shows what the callbacks noted; the
-- builder lists the queue itself under SQL Workshop → RESTful Services →
-- Web requests (re-queue, cancel).
-- =====================================================================

create table hr.contact_fetch (
  request_id  bigint primary key,
  status      text not null,
  status_code int,
  attempts    int,
  contacts    int,
  noted_at    timestamptz not null default now()
);
grant select, insert on hr.contact_fetch to hr_app;

-- The callback: called by the server with the request's id once the request is final (ok, error or gave_up).
create function hr.contacts_fetched(p_id bigint) returns void
language plpgsql as $$
declare
  r jsonb := meta.web_response(p_id);
begin
  insert into hr.contact_fetch (request_id, status, status_code, attempts, contacts)
  values (p_id, r ->> 'status', (r ->> 'status_code')::int, (r ->> 'attempts')::int, jsonb_array_length(coalesce(r -> 'json' -> 'items', '[]')))
  on conflict (request_id) do nothing;
end $$;
revoke execute on function hr.contacts_fetched(bigint) from public;
grant execute on function hr.contacts_fetched(bigint) to hr_app;

insert into meta.region (page_id, seq, title, type, columns, template, source, config)
select p.id, 60, 'Background requests', 'report', 12, 'standard',
       $q$select f.request_id, f.status, f.status_code, f.attempts, f.contacts, to_char(f.noted_at, 'YYYY-MM-DD HH24:MI:SS') as noted
  from hr.contact_fetch f order by f.request_id desc$q$,
       '{"page_size": 5, "headings": {"request_id": "Request", "status": "Status", "status_code": "HTTP", "attempts": "Attempts", "contacts": "Contacts", "noted": "Noted by the callback"}, "empty": "Nothing yet: choose Fetch in the background, then reload the page."}'::jsonb
  from meta.page p join meta.app a on a.id = p.app_id
 where a.alias = 'hr' and p.page_no = 35;

insert into meta.button (page_id, region_id, seq, name, label, action, hot)
select p.id, r.id, 30, 'FETCH_LATER', 'Fetch in the background', 'submit', false
  from meta.page p join meta.app a on a.id = p.app_id and a.alias = 'hr'
  join meta.region r on r.page_id = p.id and r.title = 'Call a web service'
 where p.page_no = 35;

-- with a callback the request is the outbox's: sent after the commit, retried, then hr.contacts_fetched is called
insert into meta.process (page_id, seq, name, type, point, code, when_button, success_message)
select p.id, 40, 'Queue for the background', 'sql', 'submit',
       $c$select meta.web_request(current_setting('pgkiln.public_url') || '/a/hr/rest/crm/contacts', p_timeout_s => 10,
                        p_max_attempts => 3, p_callback => 'hr.contacts_fetched', p_ordering_key => 'crm-contacts') as p35_request$c$,
       'FETCH_LATER', 'The request is queued: the server sends it now and notes the outcome below.'
  from meta.page p join meta.app a on a.id = p.app_id
 where a.alias = 'hr' and p.page_no = 35;

insert into meta.translation (app_id, language, source, target)
select a.id, 'nl', t.source, t.target
  from meta.app a, (values
  ('Fetch in the background', 'Op de achtergrond ophalen'),
  ('Background requests', 'Verzoeken op de achtergrond'),
  ('The request is queued: the server sends it now and notes the outcome below.', 'Het verzoek staat in de wachtrij: de server verstuurt het nu en noteert de uitkomst hieronder.')
  ) as t (source, target)
 where a.alias = 'hr'
on conflict do nothing;
