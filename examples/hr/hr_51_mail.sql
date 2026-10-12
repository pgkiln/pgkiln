-- =====================================================================
-- HR example, part 51: e-mail (migration 081; docs/guide/06-processing.md,
-- "Sending e-mail")
--
-- The example sends through a mail service of provider "log": the server
-- writes each mail to its log and sends nothing, so the example works on
-- any installation. An administrator points HR at a real service under
-- Workspace utilities → Mail services (SMTP, Microsoft 365, Amazon SES,
-- Resend, Postmark, SendGrid or Mailgun).
--
-- The template LEAVE_DECIDED tells an employee that a leave request was
-- approved or rejected; a trigger queues it from the running application
-- when the status changes (the decision's transaction: a rollback sends
-- nothing). A mail that can't be queued never stops the decision.
-- =====================================================================

insert into meta.mail_service (name, description, provider, senders, settings)
values ('DEVELOPMENT_LOG', 'Writes mail to the server log; sends nothing', 'log', '{@example.com}', '{"default_from": "hr@example.com"}')
on conflict (name) do nothing;

insert into meta.app_mail_service (app_id, service_id, from_address, max_per_day)
select a.id, s.id, 'hr@example.com', 500
  from meta.app a, meta.mail_service s
 where a.alias = 'hr' and s.name = 'DEVELOPMENT_LOG'
on conflict (app_id) do nothing;

insert into meta.email_template (app_id, name, subject, html_body, text_body)
select id, 'LEAVE_DECIDED', 'Your leave request was #STATUS#',
$h$<p>Dear #NAME#,</p>
<p>Your leave request from <b>#START#</b> to <b>#END#</b> was <b>#STATUS#</b> by #DECIDED_BY#.</p>
<p>Kind regards,<br>HR</p>$h$,
$t$Dear #NAME#,

Your leave request from #START# to #END# was #STATUS# by #DECIDED_BY#.

Kind regards,
HR$t$
  from meta.app where alias = 'hr';

create function hr.mail_leave_decided() returns trigger
language plpgsql security definer set search_path = hr, pg_catalog as $$
declare
  v_email text;
  v_name  text;
begin
  if new.status not in ('APPROVED', 'REJECTED') or meta.app_id() is null then
    return new;
  end if;
  select a.email, initcap(e.ename) into v_email, v_name
    from hr.emp e join meta.account a on lower(a.username) = lower(e.username)
   where e.empno = new.empno;
  if v_email is null then
    return new;
  end if;
  perform meta.send_mail_template('LEAVE_DECIDED', jsonb_build_object(
    'NAME', v_name,
    'STATUS', lower(new.status),
    'START', to_char(new.start_date, 'DD Mon YYYY'),
    'END', to_char(new.end_date, 'DD Mon YYYY'),
    'DECIDED_BY', coalesce(new.decided_by, 'HR')), v_email);
  return new;
exception when others then
  raise warning 'hr.mail_leave_decided: %', sqlerrm;
  return new;
end
$$;

create trigger leave_decided_mail after update of status on hr.leave_request
  for each row when (old.status is distinct from new.status)
  execute function hr.mail_leave_decided();
