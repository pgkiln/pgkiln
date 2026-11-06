-- 155: meta.mail_available() (sprint 166)
--
-- A Send E-Mail process (and meta.send_mail) raises an error when the application has
-- no mail service, which rolls back the whole submit; until now application code had
-- no way to ask first (meta.mail_caller is internal). meta.mail_available() answers
-- whether the current application may send e-mail: it is called from application code
-- (meta.app_id() set), it has an enabled mail service, and that service has a From
-- address (the application's own or the service's default). Use it as a process's
-- condition: condition_type sql, condition_expr meta.mail_available(). It says nothing
-- about other applications and never raises. Found by the App Gallery's Sample Processes.

create function meta.mail_available() returns boolean
language sql stable security definer set search_path = meta, pg_catalog as $$
  select meta.app_id() is not null and exists (
    select 1
      from meta.mail_service s
      left join meta.app_mail_service x on x.app_id = meta.app_id() and x.service_id = s.id
     where s.id = meta.mail_service_for_app(meta.app_id()) and s.enabled
       and coalesce(x.from_address, nullif(s.settings->>'default_from', '')) is not null)
$$;
revoke all on function meta.mail_available() from public;
grant execute on function meta.mail_available() to public;
comment on function meta.mail_available() is 'Whether the current application may send e-mail: an enabled mail service with a From address (155)';
