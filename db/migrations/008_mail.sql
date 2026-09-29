-- =====================================================================
-- 008: e-mail (like APEX_MAIL and Shared Components → Email Templates)
--
-- Application SQL queues mail with meta.send_mail() / meta.send_mail_template()
-- inside its own transaction: when the transaction rolls back, the mail is
-- never sent. The pgapex server delivers the queue over SMTP (see
-- src/mail.ts), with retries; Builder → Mail shows the queue and the log.
-- =====================================================================

create table meta.mail_queue (
  id              bigserial primary key,
  app_id          int references meta.app on delete set null,
  created_by      text,
  mail_from       text,
  mail_to         text not null,
  mail_cc         text,
  mail_bcc        text,
  reply_to        text,
  subject         text not null default '',
  body_text       text,
  body_html       text,
  template        text,
  status          text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'failed')),
  attempts        int  not null default 0,
  last_error      text,
  next_attempt_at timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  sent_at         timestamptz
);
create index on meta.mail_queue (next_attempt_at) where status = 'queued';
create index on meta.mail_queue (created_at desc);

create table meta.mail_attachment (
  id        bigserial primary key,
  mail_id   bigint not null references meta.mail_queue on delete cascade,
  filename  text not null,
  mime_type text not null default 'application/octet-stream',
  content   bytea not null
);

-- E-mail templates per application, with #PLACEHOLDER# substitution.
create table meta.email_template (
  id        serial primary key,
  app_id    int  not null references meta.app on delete cascade,
  static_id text not null check (static_id ~ '^[A-Za-z][A-Za-z0-9_]{0,59}$'),
  name      text not null,
  subject   text not null,
  body_html text,
  body_text text,
  unique (app_id, static_id)
);

-- Page process "Send e-mail": its settings live in config.
alter table meta.process add column config jsonb not null default '{}';
alter table meta.process drop constraint process_type_check;
alter table meta.process add constraint process_type_check check (type in ('form_dml', 'sql', 'grid_dml', 'send_email'));

-- A comma-separated list of plain addresses (name <addr> is allowed too).
create function meta.mail_addresses_ok(p_list text) returns boolean
language sql immutable as $$
  select p_list is null or (
    array_length(string_to_array(p_list, ','), 1) <= 50
    and not exists (
      select 1 from unnest(string_to_array(p_list, ',')) a
       where trim(a) !~ '^([^<>,\r\n]*<)?[^@\s<>,;:"()\[\]]+@[^@\s<>,;:"()\[\]]+\.[^@\s<>,;:"()\[\]]+>?$'))
$$;

-- Queue an e-mail (APEX_MAIL.SEND). Returns the mail id (for attachments).
create function meta.send_mail(
  p_to text, p_subject text, p_body text,
  p_body_html text default null, p_from text default null,
  p_cc text default null, p_bcc text default null, p_reply_to text default null)
returns bigint
language plpgsql security definer set search_path = meta, pg_catalog as $$
declare
  v_id bigint;
begin
  if coalesce(trim(p_to), '') = '' and coalesce(trim(p_cc), '') = '' and coalesce(trim(p_bcc), '') = '' then
    raise exception 'An e-mail needs at least one recipient.';
  end if;
  if not (meta.mail_addresses_ok(nullif(trim(p_to), '')) and meta.mail_addresses_ok(p_cc) and meta.mail_addresses_ok(p_bcc)
          and meta.mail_addresses_ok(p_reply_to) and meta.mail_addresses_ok(p_from)) then
    raise exception 'Invalid e-mail address (or more than 50 recipients).';
  end if;
  if length(coalesce(p_body, '')) + length(coalesce(p_body_html, '')) > 2000000 then
    raise exception 'The e-mail is too large.';
  end if;
  insert into meta.mail_queue (app_id, created_by, mail_from, mail_to, mail_cc, mail_bcc, reply_to, subject, body_text, body_html)
  values (meta.app_id(), meta.app_user(), p_from, coalesce(trim(p_to), ''), p_cc, p_bcc, p_reply_to,
          left(regexp_replace(coalesce(p_subject, ''), '[\r\n]+', ' ', 'g'), 500), p_body, p_body_html)
  returning id into v_id;
  perform pg_notify('pgapex_mail', v_id::text);
  return v_id;
end
$$;

-- Queue an e-mail from a template of the current application
-- (APEX_MAIL.SEND with p_template_static_id). #NAME# is replaced by the
-- placeholder value, HTML-escaped in the HTML body; #NAME!RAW# is not escaped.
create function meta.send_mail_template(
  p_template text, p_placeholders jsonb, p_to text,
  p_from text default null, p_cc text default null, p_bcc text default null, p_reply_to text default null)
returns bigint
language plpgsql security definer set search_path = meta, pg_catalog as $$
declare
  t      meta.email_template;
  v_subj text;
  v_html text;
  v_text text;
  k      text;
  v      text;
  v_id   bigint;
begin
  select * into t from meta.email_template e where e.app_id = meta.app_id() and upper(e.static_id) = upper(p_template);
  if not found then
    raise exception 'E-mail template "%" not found.', p_template;
  end if;
  v_subj := t.subject; v_html := t.body_html; v_text := t.body_text;
  for k, v in select key, value from jsonb_each_text(coalesce(p_placeholders, '{}')) loop
    v_subj := replace(v_subj, '#' || upper(k) || '#', coalesce(v, ''));
    v_text := replace(v_text, '#' || upper(k) || '#', coalesce(v, ''));
    v_html := replace(replace(v_html, '#' || upper(k) || '!RAW#', coalesce(v, '')), '#' || upper(k) || '#', meta.html_escape(coalesce(v, '')));
  end loop;
  v_id := meta.send_mail(p_to, v_subj, v_text, v_html, p_from, p_cc, p_bcc, p_reply_to);
  update meta.mail_queue set template = t.static_id where id = v_id;
  return v_id;
end
$$;

-- Attach a file to a queued mail of the current application (APEX_MAIL.ADD_ATTACHMENT).
create function meta.add_attachment(p_mail_id bigint, p_content bytea, p_filename text, p_mime_type text default 'application/octet-stream')
returns void
language plpgsql security definer set search_path = meta, pg_catalog as $$
begin
  if not exists (select 1 from meta.mail_queue q where q.id = p_mail_id and q.status = 'queued'
                    and q.app_id is not distinct from meta.app_id() and q.created_by = meta.app_user()) then
    raise exception 'Mail % is not a queued mail of this application.', p_mail_id;
  end if;
  if length(p_content) > 10 * 1024 * 1024 then
    raise exception 'Attachments are limited to 10 MB.';
  end if;
  insert into meta.mail_attachment (mail_id, filename, mime_type, content)
  values (p_mail_id, regexp_replace(coalesce(p_filename, 'attachment'), '[\r\n/\\]+', '_', 'g'), coalesce(p_mime_type, 'application/octet-stream'), p_content);
end
$$;

revoke all on function meta.send_mail(text, text, text, text, text, text, text, text),
  meta.send_mail_template(text, jsonb, text, text, text, text, text), meta.add_attachment(bigint, bytea, text, text) from public;
grant execute on function meta.send_mail(text, text, text, text, text, text, text, text),
  meta.send_mail_template(text, jsonb, text, text, text, text, text), meta.add_attachment(bigint, bytea, text, text),
  meta.mail_addresses_ok(text) to public;
grant select on meta.email_template to pgapex_runtime;

-- Export and import include e-mail templates (wrapping the 007 versions).
alter function meta.export_app(text) rename to export_app_base;
alter function meta.import_app(jsonb, text) rename to import_app_base;

create function meta.export_app(p_alias text) returns jsonb
language sql stable as $$
  select jsonb_set(meta.export_app_base(p_alias), '{email_templates}',
    coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.static_id)
                from meta.email_template x join meta.app a on a.id = x.app_id where a.alias = p_alias), '[]'))
$$;

create function meta.import_app(p_doc jsonb, p_alias text default null) returns int
language plpgsql as $$
declare
  v_app_id int := meta.import_app_base(p_doc, p_alias);
begin
  insert into meta.email_template (app_id, static_id, name, subject, body_html, body_text)
  select v_app_id, e->>'static_id', e->>'name', e->>'subject', e->>'body_html', e->>'body_text'
    from jsonb_array_elements(coalesce(p_doc->'email_templates', '[]')) e;
  return v_app_id;
end
$$;
