-- =====================================================================
-- HR example, part 99: several mail services per application (migration
-- 191, sprint 236; docs/guide/06-processing.md, "Several mail services")
--
-- HR sends its own mail (part 51) as hr@example.com through the service
-- DEVELOPMENT_LOG, its default. Safety notices come from a separate
-- mailbox, alerts@safety.example.org, with an account of its own: the
-- service SAFETY_LOG (provider "log": it writes to the server log and
-- sends nothing). Both are linked to HR. A mail whose From address only
-- SAFETY_LOG may send as goes through SAFETY_LOG; every other mail through
-- the default, as before. An administrator points either service at a
-- real account under Workspace utilities → Mail services.
--
-- hr.send_safety_notice(to, text) queues a safety notice from the running
-- application (meta.send_mail with p_from).
-- =====================================================================

insert into meta.mail_service (name, description, provider, senders, settings)
values ('SAFETY_LOG', 'Safety notices (alerts@safety.example.org); writes mail to the server log, sends nothing', 'log',
        '{@safety.example.org}', '{"default_from": "alerts@safety.example.org"}')
on conflict (name) do nothing;

-- the second link: not the default (part 51's DEVELOPMENT_LOG is), at most 50 safety mails a day
insert into meta.app_mail_service (app_id, service_id, from_address, max_per_day, is_default)
select a.id, s.id, 'alerts@safety.example.org', 50, false
  from meta.app a, meta.mail_service s
 where a.alias = 'hr' and s.name = 'SAFETY_LOG'
on conflict do nothing;

create function hr.send_safety_notice(p_to text, p_text text) returns bigint
language sql security invoker set search_path = hr, pg_catalog as $$
  select meta.send_mail(
    p_to      => p_to,
    p_subject => 'Safety notice',
    p_body    => p_text,
    p_from    => 'alerts@safety.example.org')   -- only SAFETY_LOG may send as this address: it goes through SAFETY_LOG
$$;
comment on function hr.send_safety_notice(text, text) is 'HR example (part 99): a safety notice through the mail service SAFETY_LOG';
