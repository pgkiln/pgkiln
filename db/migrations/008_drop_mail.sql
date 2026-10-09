-- =====================================================================
-- 008: remove the pre-release e-mail and "forgot password" features
--
-- Development builds of v0.5.0 shipped a mail queue, e-mail templates, a
-- "Send e-mail" process type and forgot-password links. They were removed
-- before release (the project owner's decision: pgkiln doesn't send mail;
-- use a PostgreSQL extension or your own service if you need it). Fresh
-- installs never create these objects; this migration cleans up databases
-- that ran the pre-release migrations. Everything here is idempotent.
-- =====================================================================

-- The pre-release HR sample mailed employees from a trigger.
drop trigger if exists leave_decided_mail on hr.leave_request;
drop function if exists hr.mail_leave_decided();

-- Export/import were wrapped to include e-mail templates: unwrap them.
do $$
begin
  if to_regprocedure('meta.export_app_base(text)') is not null then
    drop function meta.export_app(text);
    alter function meta.export_app_base(text) rename to export_app;
  end if;
  if to_regprocedure('meta.import_app_base(jsonb, text)') is not null then
    drop function meta.import_app(jsonb, text);
    alter function meta.import_app_base(jsonb, text) rename to import_app;
  end if;
end
$$;

-- "Send e-mail" processes and their settings column.
delete from meta.process where type = 'send_email';
alter table meta.process drop constraint if exists process_type_check;
alter table meta.process add constraint process_type_check check (type in ('form_dml', 'grid_dml', 'sql'));
alter table meta.process drop column if exists config;

drop function if exists meta.send_mail(text, text, text, text, text, text, text, text);
drop function if exists meta.send_mail_template(text, jsonb, text, text, text, text, text);
drop function if exists meta.add_attachment(bigint, bytea, text, text);
drop function if exists meta.mail_addresses_ok(text);
drop table if exists meta.mail_attachment;
drop table if exists meta.mail_queue;
drop table if exists meta.email_template;

-- Forgot password.
drop function if exists meta.start_password_reset(int, text);
drop function if exists meta.check_password_reset(int, text);
drop function if exists meta.finish_password_reset(int, text, text);
drop table if exists meta.password_reset;
alter table meta.app drop column if exists password_reset;

-- The sample's seed file was renamed from hr_04_i18n_mail.sql to hr_04_i18n.sql.
do $$
begin
  if to_regclass('public.pgkiln_seed') is not null then
    update public.pgkiln_seed set name = 'hr_04_i18n.sql' where name = 'hr_04_i18n_mail.sql';
  end if;
end
$$;
