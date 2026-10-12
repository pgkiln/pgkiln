-- =====================================================================
-- 081: sending e-mail (APEX: APEX_MAIL, Email Templates, the "Send E-Mail"
-- process), through SMTP (password or OAuth2 / XOAUTH2), Microsoft Graph,
-- Amazon SES or an HTTP API (Resend, Postmark, SendGrid, Mailgun)
--
-- This replaces the decision of 008 (no e-mail): the project owner asked
-- for it on 2026-10-12.
--
-- meta.mail_service: an instance-level mail service (administrators,
--   Workspace utilities → Mail services). Provider, settings without
--   secrets, the secret (password, client secret or API key) encrypted by
--   the server with PGKILN_SECRET_KEY (write-only, never exported, never
--   readable by applications), the From addresses it may send as.
-- meta.app_mail_service: the service an application sends through, its
--   From address and a daily limit. Installation data: not exported.
-- meta.mail_queue, meta.mail_attachment: the outbox. meta.send_mail(),
--   meta.send_mail_template() and meta.add_mail_attachment() write it in
--   the caller's transaction (a rollback sends nothing) and NOTIFY
--   pgkiln_mail; the server sends after the commit (src/mail/), retries
--   with growing pauses, and keeps the log 30 days.
-- meta.email_template: an application's e-mail templates (subject, HTML
--   and plain text with #PLACEHOLDERS#), exported with the application.
--
-- The functions run for the current application (meta.app_id()) only when
-- the caller runs as that application's database role, so application code
-- can't send in another application's name.
--
-- export_app / import_app are redefined from 080 to carry email_templates.
-- =====================================================================

create table meta.mail_service (
  id          serial primary key,
  name        text not null unique check (name ~ '^[A-Z][A-Z0-9_]{0,59}$'),
  description text,
  provider    text not null check (provider in ('smtp', 'graph', 'ses', 'resend', 'postmark', 'sendgrid', 'mailgun', 'log')),
  -- host, port, security, auth, username, token_url, client_id, scope, tenant_id, access_key_id,
  -- region, domain, message_stream, save_to_sent_items, base_url (administrators only); no secrets
  settings    jsonb not null default '{}' check (jsonb_typeof(settings) = 'object'),
  -- "v1:" + base64(iv, tag, ciphertext); written by the server only (src/secrets.ts)
  secret_enc  text,
  -- the From addresses it may send as: user@example.com, or @example.com for a whole domain
  senders     text[] not null default '{}',
  enabled     boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
revoke all on meta.mail_service from public;
comment on table meta.mail_service is 'Mail services of this installation (081); the secret is encrypted and never readable by applications';

create table meta.app_mail_service (
  app_id       int primary key references meta.app on delete cascade,
  service_id   int not null references meta.mail_service on delete cascade,
  -- the application's From address when the caller gives none
  from_address text,
  -- per day (UTC); null = no limit
  max_per_day  int check (max_per_day >= 0)
);
revoke all on meta.app_mail_service from public;

create table meta.mail_queue (
  id            bigint generated always as identity primary key,
  app_id        int not null references meta.app on delete cascade,
  username      text,
  from_address  text,
  reply_to      text,
  to_addresses  text[] not null default '{}',
  cc_addresses  text[] not null default '{}',
  bcc_addresses text[] not null default '{}',
  subject       text not null,
  body_text     text,
  body_html     text,
  template      text,
  status        text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'error', 'cancelled')),
  attempts      int not null default 0,
  not_before    timestamptz not null default now(),
  -- the last problem, or what the provider said
  message       text,
  -- the provider's id of the message, the service that sent it
  provider_id   text,
  service       text,
  created_at    timestamptz not null default now(),
  -- attachments may be added in the transaction that queued the mail only
  created_xact  bigint not null default txid_current(),
  sent_at       timestamptz,
  check (cardinality(to_addresses) + cardinality(cc_addresses) + cardinality(bcc_addresses) between 1 and 50)
);
create index mail_queue_queued on meta.mail_queue (not_before) where status = 'queued';
create index mail_queue_app on meta.mail_queue (app_id, created_at);
revoke all on meta.mail_queue from public;

create table meta.mail_attachment (
  id       bigint generated always as identity primary key,
  mail_id  bigint not null references meta.mail_queue on delete cascade,
  filename text not null check (filename ~ '^[^/\\\r\n"<>:|?*]{1,200}$'),
  mime     text not null check (mime ~ '^[a-z]+/[a-z0-9.+-]{1,100}$'),
  content  bytea not null check (octet_length(content) <= 10 * 1024 * 1024)
);
create index mail_attachment_mail on meta.mail_attachment (mail_id);
revoke all on meta.mail_attachment from public;

create table meta.email_template (
  id        serial primary key,
  app_id    int not null references meta.app on delete cascade,
  name      text not null check (name ~ '^[A-Z][A-Z0-9_]{0,59}$'),
  subject   text not null check (length(subject) between 1 and 998 and subject !~ '[\r\n]'),
  html_body text,
  text_body text,
  unique (app_id, name)
);
revoke all on meta.email_template from public;
comment on table meta.email_template is 'E-mail templates (081): subject, HTML and plain text with #PLACEHOLDERS#; exported with the application';

alter table meta.process drop constraint process_type_check;
alter table meta.process add constraint process_type_check check (type in (
  'ai_generate', 'chain', 'data_load', 'download', 'form_dml', 'grid_dml', 'invoke_api', 'sql', 'workflow', 'plugin', 'send_push', 'send_email'));

-- ---------------------------------------------------------------- SQL API

-- The addresses of a list (comma or semicolon separated, or one per element),
-- checked: plain addresses only (no names, no line breaks), each at most 254
-- characters. Raises with p_what in the message.
create function meta.mail_addresses(p_list text, p_what text) returns text[]
language plpgsql immutable set search_path = pg_catalog as $$
declare
  v_out text[] := '{}';
  v     text;
begin
  if p_list is null or btrim(p_list) = '' then
    return v_out;
  end if;
  foreach v in array regexp_split_to_array(p_list, '\s*[,;]\s*') loop
    v := btrim(v);
    continue when v = '';
    if length(v) > 254 or v !~ '^[A-Za-z0-9.!#$%&''*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$' then
      raise exception 'meta.send_mail: "%" is not an e-mail address (%)', left(v, 100), p_what;
    end if;
    if not v = any (v_out) then
      v_out := v_out || v;
    end if;
  end loop;
  return v_out;
end
$$;

-- The calling application and its mail service: the current application, called as its own
-- database role, with a mail service an administrator gave it.
create function meta.mail_caller(out app_id int, out service_id int, out from_address text, out max_per_day int, out senders text[])
language plpgsql stable security definer set search_path = meta, pg_catalog as $$
declare
  v_role text;
begin
  app_id := meta.app_id();
  if app_id is null then
    raise exception 'meta.send_mail: no current application (call it from application code)';
  end if;
  select a.db_role into v_role from meta.app a where a.id = app_id;
  if not found then
    raise exception 'meta.send_mail: no current application (call it from application code)';
  end if;
  if v_role is not null and current_setting('role') is distinct from v_role then
    raise exception 'meta.send_mail: called outside the application''s own database role';
  end if;
  select x.service_id, coalesce(x.from_address, nullif(s.settings->>'default_from', '')), x.max_per_day, s.senders
    into service_id, from_address, max_per_day, senders
    from meta.app_mail_service x join meta.mail_service s on s.id = x.service_id
   where x.app_id = mail_caller.app_id and s.enabled;
  if not found then
    raise exception 'meta.send_mail: this application may not send e-mail (an administrator chooses its mail service under Workspace utilities → Mail services)';
  end if;
end
$$;
revoke all on function meta.mail_caller() from public;

-- May the service send as this address? (user@example.com, or @example.com for the whole domain)
create function meta.mail_sender_allowed(p_senders text[], p_from text) returns boolean
language sql immutable set search_path = pg_catalog as $$
  select exists (select 1 from unnest(p_senders) s
                  where lower(s) = lower(p_from) or (left(s, 1) = '@' and lower(p_from) like '%' || lower(s)))
$$;

-- Queue one mail (the functions below check their arguments first).
create function meta.mail_enqueue(p_to text, p_subject text, p_body text, p_body_html text, p_from text, p_cc text, p_bcc text, p_reply_to text, p_template text)
returns bigint
language plpgsql volatile security definer set search_path = meta, pg_catalog as $$
declare
  c        record;
  v_to     text[] := meta.mail_addresses(p_to, 'to');
  v_cc     text[] := meta.mail_addresses(p_cc, 'cc');
  v_bcc    text[] := meta.mail_addresses(p_bcc, 'bcc');
  v_reply  text[] := meta.mail_addresses(p_reply_to, 'reply to');
  v_from   text[];
  v_count  int;
  v_id     bigint;
begin
  select * into c from meta.mail_caller();
  if cardinality(v_to) + cardinality(v_cc) + cardinality(v_bcc) = 0 then
    raise exception 'meta.send_mail: no recipient';
  end if;
  if cardinality(v_to) + cardinality(v_cc) + cardinality(v_bcc) > 50 then
    raise exception 'meta.send_mail: at most 50 recipients per mail (to, cc and bcc together)';
  end if;
  if cardinality(v_reply) > 1 then
    raise exception 'meta.send_mail: one reply-to address';
  end if;
  if p_subject is null or length(p_subject) not between 1 and 998 or p_subject ~ '[\r\n]' then
    raise exception 'meta.send_mail: the subject is required, on one line (at most 998 characters)';
  end if;
  if p_body is null and p_body_html is null then
    raise exception 'meta.send_mail: a plain text or HTML body is required';
  end if;
  if coalesce(octet_length(p_body), 0) > 1048576 or coalesce(octet_length(p_body_html), 0) > 1048576 then
    raise exception 'meta.send_mail: each body is at most 1 MB';
  end if;
  v_from := meta.mail_addresses(coalesce(nullif(btrim(p_from), ''), c.from_address), 'from');
  if cardinality(v_from) <> 1 then
    raise exception 'meta.send_mail: no From address (give one, or an administrator sets the application''s)';
  end if;
  if not meta.mail_sender_allowed(c.senders, v_from[1]) then
    raise exception 'meta.send_mail: the mail service may not send as % (its allowed senders are set by an administrator)', v_from[1];
  end if;
  if c.max_per_day is not null then
    select count(*) into v_count from meta.mail_queue
     where app_id = c.app_id and created_at >= date_trunc('day', now() at time zone 'UTC') at time zone 'UTC' and status <> 'cancelled';
    if v_count >= c.max_per_day then
      raise exception 'meta.send_mail: this application''s limit of % mails per day is reached', c.max_per_day;
    end if;
  end if;
  insert into meta.mail_queue (app_id, username, from_address, reply_to, to_addresses, cc_addresses, bcc_addresses, subject, body_text, body_html, template)
  values (c.app_id, nullif(current_setting('pgkiln.app_user', true), ''), v_from[1], v_reply[1], v_to, v_cc, v_bcc, p_subject, p_body, p_body_html, p_template)
  returning id into v_id;
  perform pg_notify('pgkiln_mail', v_id::text);
  return v_id;
end
$$;
revoke all on function meta.mail_enqueue(text, text, text, text, text, text, text, text, text) from public;

-- APEX_MAIL.SEND: queue a mail; it is sent after the transaction commits.
create function meta.send_mail(
  p_to        text,
  p_subject   text,
  p_body      text default null,
  p_body_html text default null,
  p_from      text default null,
  p_cc        text default null,
  p_bcc       text default null,
  p_reply_to  text default null
) returns bigint
language sql volatile security definer set search_path = meta, pg_catalog as $$
  select meta.mail_enqueue(p_to, p_subject, p_body, p_body_html, p_from, p_cc, p_bcc, p_reply_to, null)
$$;
grant execute on function meta.send_mail(text, text, text, text, text, text, text, text) to public;

-- A template with its placeholders filled, in one pass (a value is never searched for
-- placeholders itself): #NAME# is the value (HTML-escaped in the HTML body), #NAME!RAW#
-- the value as it is (trusted HTML). Names are case-insensitive; unknown ones stay.
create function meta.mail_fill(p_text text, p_values jsonb, p_html boolean) returns text
language plpgsql immutable set search_path = meta, pg_catalog as $$
declare
  c_pat  constant text := '#([A-Za-z][A-Za-z0-9_]{0,59})(!RAW)?#';
  v_vals jsonb;
  v_out  text := '';
  v_rest text := p_text;
  v_pos  int;
  v_tok  text;
  v_m    text[];
  v_val  text;
begin
  if p_text is null then
    return null;
  end if;
  select coalesce(jsonb_object_agg(upper(key), value), '{}') into v_vals
    from jsonb_each(case when jsonb_typeof(p_values) = 'object' then p_values else '{}' end);
  loop
    v_pos := regexp_instr(v_rest, c_pat);
    exit when v_pos = 0;
    v_tok := regexp_substr(v_rest, c_pat);
    v_m := regexp_match(v_tok, '^' || c_pat || '$');
    v_out := v_out || left(v_rest, v_pos - 1);
    if v_vals ? upper(v_m[1]) then
      v_val := case jsonb_typeof(v_vals->upper(v_m[1])) when 'string' then v_vals->>upper(v_m[1]) when 'null' then '' else (v_vals->upper(v_m[1]))::text end;
      v_out := v_out || case when p_html and v_m[2] is null then meta.html_escape(v_val) else v_val end;
    else
      v_out := v_out || v_tok;
    end if;
    v_rest := substr(v_rest, v_pos + length(v_tok));
  end loop;
  return v_out || v_rest;
end
$$;

-- APEX_MAIL.SEND with p_template_static_id and p_placeholders.
create function meta.send_mail_template(
  p_template     text,
  p_placeholders jsonb,
  p_to           text,
  p_cc           text default null,
  p_bcc          text default null,
  p_from         text default null,
  p_reply_to     text default null
) returns bigint
language plpgsql volatile security definer set search_path = meta, pg_catalog as $$
declare
  t record;
begin
  select * into t from meta.email_template where app_id = meta.app_id() and name = upper(p_template);
  if not found then
    raise exception 'meta.send_mail_template: no e-mail template %', p_template;
  end if;
  return meta.mail_enqueue(p_to, regexp_replace(meta.mail_fill(t.subject, p_placeholders, false), '[\r\n]+', ' ', 'g'),
                           meta.mail_fill(t.text_body, p_placeholders, false), meta.mail_fill(t.html_body, p_placeholders, true),
                           p_from, p_cc, p_bcc, p_reply_to, t.name);
end
$$;
grant execute on function meta.send_mail_template(text, jsonb, text, text, text, text, text) to public;

-- APEX_MAIL.ADD_ATTACHMENT: a file for a mail queued in this transaction.
create function meta.add_mail_attachment(p_mail_id bigint, p_content bytea, p_filename text, p_mime text default 'application/octet-stream')
returns void
language plpgsql volatile security definer set search_path = meta, pg_catalog as $$
declare
  c       record;
  v_count int;
  v_size  bigint;
begin
  select * into c from meta.mail_caller();
  if not exists (select 1 from meta.mail_queue where id = p_mail_id and app_id = c.app_id and status = 'queued' and created_xact = txid_current()) then
    raise exception 'meta.add_mail_attachment: mail % was not queued in this transaction', p_mail_id;
  end if;
  if p_content is null then
    raise exception 'meta.add_mail_attachment: no content';
  end if;
  select count(*), coalesce(sum(octet_length(content)), 0) into v_count, v_size from meta.mail_attachment where mail_id = p_mail_id;
  if v_count >= 20 or v_size + octet_length(p_content) > 20 * 1024 * 1024 then
    raise exception 'meta.add_mail_attachment: at most 20 attachments and 20 MB per mail';
  end if;
  insert into meta.mail_attachment (mail_id, filename, mime, content)
  values (p_mail_id, regexp_replace(coalesce(p_filename, 'attachment'), '[/\\\r\n"<>:|?*]', '_', 'g'), lower(coalesce(p_mime, 'application/octet-stream')), p_content);
end
$$;
grant execute on function meta.add_mail_attachment(bigint, bytea, text, text) to public;

-- The status of a mail of the current application: queued, sending, sent, error or cancelled.
create function meta.mail_status(p_mail_id bigint) returns text
language sql stable security definer set search_path = meta, pg_catalog as $$
  select status from meta.mail_queue where id = p_mail_id and app_id = meta.app_id()
$$;
grant execute on function meta.mail_status(bigint) to public;

-- ---------------------------------------------------------------- export / import
-- Same as 080, plus email_templates. Mail services, the application's service, the queue
-- and attachments belong to the installation: not exported.
create or replace function meta.export_app(p_alias text) returns jsonb
language sql stable set search_path = meta, pg_catalog as $$
  select jsonb_build_object(
    'format', 'pgkiln/2',
    'app', to_jsonb(a) - 'id' - 'created_at' - 'updated_at',
    'authz_schemes', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.name) from meta.authz_scheme x where x.app_id = a.id), '[]'),
    'app_items', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.name) from meta.app_item x where x.app_id = a.id), '[]'),
    'app_processes', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.seq, x.id) from meta.app_process x where x.app_id = a.id), '[]'),
    'lovs', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.name) from meta.lov x where x.app_id = a.id), '[]'),
    'group_roles', coalesce((select jsonb_agg(to_jsonb(x) - 'app_id' order by x.group_name, x.role) from meta.app_group_role x where x.app_id = a.id), '[]'),
    'text_messages', coalesce((select jsonb_agg(to_jsonb(x) - 'app_id' order by x.name, x.language) from meta.text_message x where x.app_id = a.id), '[]'),
    'translations', coalesce((select jsonb_agg(to_jsonb(x) - 'app_id' order by x.language, x.source) from meta.translation x where x.app_id = a.id), '[]'),
    'report_layouts', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' - 'logo' || jsonb_build_object('logo', encode(x.logo, 'base64')) order by x.name)
                                  from meta.report_layout x where x.app_id = a.id), '[]'),
    'automations', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' - 'next_run_at' - 'last_run_at' - 'last_status' - 'code' order by x.name)
                               from meta.automation x where x.app_id = a.id), '[]'),
    -- (044) the actions of the automations, by automation name
    'automation_actions', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.automation_name collate "C", x.seq, x.name collate "C")
                                      from meta.automation_action x where x.app_id = a.id), '[]'),
    'document_templates', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.name) from meta.document_template x where x.app_id = a.id), '[]'),
    'task_definitions', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.name) from meta.task_definition x where x.app_id = a.id), '[]'),
    'workflow_definitions', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.name) from meta.workflow_definition x where x.app_id = a.id), '[]'),
    'rest_modules', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.name) from meta.rest_module x where x.app_id = a.id), '[]'),
    'template_components', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.static_id) from meta.template_component x where x.app_id = a.id), '[]'),
    'build_options', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.name) from meta.build_option x where x.app_id = a.id), '[]'),
    -- (030) secrets never leave the installation: they are entered again after an import
    -- (050) nor do the password and refresh token of the OAuth2 flows, or the token state
    'web_credentials', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' - 'secret_enc' - 'password_enc' - 'refresh_token_enc' - 'token_refreshed_at' order by x.name)
                                   from meta.web_credential x where x.app_id = a.id), '[]'),
    -- (050) the synchronisation's state (next and last run) belongs to the installation
    'rest_sources', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' - 'sync_next_at' - 'sync_last_at' - 'sync_last_status' order by x.name)
                                from meta.rest_source x where x.app_id = a.id), '[]'),
    -- (041) data load definitions
    'data_load_definitions', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.name) from meta.data_load_def x where x.app_id = a.id), '[]'),
    -- (042) lists; entries keep their ids so parents can be remapped on import
    'lists', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.name) from meta.list x where x.app_id = a.id), '[]'),
    'list_entries', coalesce((select jsonb_agg(to_jsonb(x) - 'app_id' order by x.list_name, x.parent_id nulls first, x.seq, x.id) from meta.list_entry x where x.app_id = a.id), '[]'),
    -- (042) supporting objects: install, upgrade and deinstall scripts (never run on import)
    'supporting_scripts', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.name) from meta.supporting_script x where x.app_id = a.id), '[]'),
    -- (069) plug-ins (their files are static files, their templates template components)
    'plugins', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.name) from meta.plugin x where x.app_id = a.id), '[]'),
    -- (080) search configurations
    'search_configs', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.name) from meta.search_config x where x.app_id = a.id), '[]'),
    -- (081) e-mail templates
    'email_templates', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.name) from meta.email_template x where x.app_id = a.id), '[]'),
    -- (068) static application files (JavaScript, CSS, images, fonts) as base64
    'static_files', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' - 'content' - 'updated_at' || jsonb_build_object('content', translate(encode(x.content, 'base64'), E'\n', '')) order by x.name)
                                from meta.static_file x where x.app_id = a.id), '[]'),
    -- nav entries and regions keep their ids, so parents and references can be remapped on import
    'nav', coalesce((select jsonb_agg(to_jsonb(x) - 'app_id' order by x.parent_id nulls first, x.seq, x.id) from meta.nav_entry x where x.app_id = a.id), '[]'),
    'pages', coalesce((
      select jsonb_agg(to_jsonb(p) - 'id' - 'app_id' || jsonb_build_object(
        'regions', coalesce((select jsonb_agg(to_jsonb(r) - 'page_id' order by r.seq, r.id) from meta.region r where r.page_id = p.id), '[]'),
        'items', coalesce((select jsonb_agg(to_jsonb(i) - 'id' - 'page_id' order by i.seq, i.id) from meta.item i where i.page_id = p.id), '[]'),
        'buttons', coalesce((select jsonb_agg(to_jsonb(b) - 'id' - 'page_id' order by b.seq, b.id) from meta.button b where b.page_id = p.id), '[]'),
        'dynamic_actions', coalesce((select jsonb_agg(to_jsonb(d) - 'id' - 'page_id' order by d.seq, d.id) from meta.dynamic_action d where d.page_id = p.id), '[]'),
        'validations', coalesce((select jsonb_agg(to_jsonb(v) - 'id' - 'page_id' order by v.seq, v.id) from meta.validation v where v.page_id = p.id), '[]'),
        'processes', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'page_id' order by x.seq, x.id) from meta.process x where x.page_id = p.id), '[]'),
        'computations', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'page_id' order by x.seq, x.id) from meta.computation x where x.page_id = p.id), '[]'),
        'branches', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'page_id' order by x.seq, x.id) from meta.branch x where x.page_id = p.id), '[]')
      ) order by p.page_no)
      from meta.page p where p.app_id = a.id), '[]'))
  from meta.app a
  where a.alias = p_alias
$$;

create or replace function meta.import_app(p_doc jsonb, p_alias text default null) returns int
language plpgsql set search_path = meta, pg_catalog as $$
declare
  v_app_id  int;
  v_page_id int;
  v_page    jsonb;
  v_e       jsonb;
  v_rmap    jsonb;
  v_nmap    jsonb := '{}';
  v_lmap    jsonb := '{}';
  v_new_id  int;
begin
  if p_doc->>'format' is distinct from 'pgkiln/2' then
    raise exception 'unsupported export format %', coalesce(p_doc->>'format', '(none)');
  end if;

  insert into meta.app
  select (jsonb_populate_record(null::meta.app, p_doc->'app' || jsonb_build_object(
            'id', nextval('meta.app_id_seq'),
            'alias', coalesce(p_alias, p_doc->'app'->>'alias'),
            'created_at', now(), 'updated_at', now()))).*
  returning id into v_app_id;

  insert into meta.authz_scheme
  select (jsonb_populate_record(null::meta.authz_scheme, e || jsonb_build_object('id', nextval('meta.authz_scheme_id_seq'), 'app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'authz_schemes', '[]')) e;
  insert into meta.app_item
  select (jsonb_populate_record(null::meta.app_item, e || jsonb_build_object('id', nextval('meta.app_item_id_seq'), 'app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'app_items', '[]')) e;
  insert into meta.app_process
  select (jsonb_populate_record(null::meta.app_process, e || jsonb_build_object('id', nextval('meta.app_process_id_seq'), 'app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'app_processes', '[]')) e;
  insert into meta.lov
  select (jsonb_populate_record(null::meta.lov, e || jsonb_build_object('id', nextval('meta.lov_id_seq'), 'app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'lovs', '[]')) e;
  insert into meta.app_group_role
  select (jsonb_populate_record(null::meta.app_group_role, e || jsonb_build_object('app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'group_roles', '[]')) e;
  insert into meta.text_message
  select (jsonb_populate_record(null::meta.text_message, e || jsonb_build_object('app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'text_messages', '[]')) e;
  insert into meta.translation
  select (jsonb_populate_record(null::meta.translation, e || jsonb_build_object('app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'translations', '[]')) e;
  insert into meta.report_layout
  select (jsonb_populate_record(null::meta.report_layout, (e - 'logo') || jsonb_build_object(
            'id', nextval('meta.report_layout_id_seq'), 'app_id', v_app_id,
            'logo', null))).*
    from jsonb_array_elements(coalesce(p_doc->'report_layouts', '[]')) e;
  update meta.report_layout l
     set logo = decode(e->>'logo', 'base64')
    from jsonb_array_elements(coalesce(p_doc->'report_layouts', '[]')) e
   where l.app_id = v_app_id and l.name = e->>'name' and e->>'logo' is not null;
  -- imported automations start switched off: the copy must not run the original's jobs unasked.
  -- (044) a file with actions: the automations' code is ignored; an older file: code becomes the single action
  insert into meta.automation
  select (jsonb_populate_record(null::meta.automation, '{"error_handling": "stop"}'::jsonb
            || jsonb_strip_nulls(case when p_doc ? 'automation_actions' then e - 'code' else e end)
            || jsonb_build_object('id', nextval('meta.automation_id_seq'), 'app_id', v_app_id, 'enabled', false))).*
    from jsonb_array_elements(coalesce(p_doc->'automations', '[]')) e;
  insert into meta.automation_action
  select (jsonb_populate_record(null::meta.automation_action, '{"seq": 10}'::jsonb || jsonb_strip_nulls(e)
            || jsonb_build_object('id', nextval('meta.automation_action_id_seq'), 'app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'automation_actions', '[]')) e;
  insert into meta.document_template
  select (jsonb_populate_record(null::meta.document_template, e || jsonb_build_object('id', nextval('meta.document_template_id_seq'), 'app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'document_templates', '[]')) e;
  insert into meta.task_definition
  select (jsonb_populate_record(null::meta.task_definition, e || jsonb_build_object('id', nextval('meta.task_definition_id_seq'), 'app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'task_definitions', '[]')) e;
  insert into meta.workflow_definition
  select (jsonb_populate_record(null::meta.workflow_definition, e || jsonb_build_object('id', nextval('meta.workflow_definition_id_seq'), 'app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'workflow_definitions', '[]')) e;
  insert into meta.rest_module
  select (jsonb_populate_record(null::meta.rest_module, e || jsonb_build_object('id', nextval('meta.rest_module_id_seq'), 'app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'rest_modules', '[]')) e;
  -- (028) template components: regions and report columns refer to them by static id
  insert into meta.template_component
  select (jsonb_populate_record(null::meta.template_component, e || jsonb_build_object('id', nextval('meta.template_component_id_seq'), 'app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'template_components', '[]')) e;
  -- (029) build options (components name them by name)
  insert into meta.build_option
  select (jsonb_populate_record(null::meta.build_option, e || jsonb_build_object('id', nextval('meta.build_option_id_seq'), 'app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'build_options', '[]')) e;
  -- (030) web credentials arrive without a secret, whatever the document holds
  -- (050) nor a password or refresh token
  insert into meta.web_credential
  select (jsonb_populate_record(null::meta.web_credential, '{"type": "basic", "valid_for": [], "grant_type": "client_credentials"}'::jsonb
            || jsonb_strip_nulls(e - 'secret_enc' - 'password_enc' - 'refresh_token_enc' - 'token_refreshed_at')
            || jsonb_build_object('id', nextval('meta.web_credential_id_seq'), 'app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'web_credentials', '[]')) e;
  -- (050) write-back operations and synchronisation; an imported synchronisation starts switched off
  insert into meta.rest_source
  select (jsonb_populate_record(null::meta.rest_source, '{"method": "GET", "headers": {}, "params": [], "columns": [], "cache_seconds": 0, "timeout_s": 10, "max_rows": 1000,
                                                          "operations": {}, "key_columns": [], "sync_mode": "merge", "sync_delete": false, "sync_time_zone": "UTC"}'::jsonb
            || jsonb_strip_nulls(e - 'sync_next_at' - 'sync_last_at' - 'sync_last_status')
            || jsonb_build_object('id', nextval('meta.rest_source_id_seq'), 'app_id', v_app_id, 'sync_enabled', false))).*
    from jsonb_array_elements(coalesce(p_doc->'rest_sources', '[]')) e;

  -- (041) data load definitions (the data_load process names them)
  insert into meta.data_load_def
  select (jsonb_populate_record(null::meta.data_load_def, '{"format": "auto", "headers": true, "mode": "append", "skip_errors": false, "columns": []}'::jsonb
            || jsonb_strip_nulls(e) || jsonb_build_object('id', nextval('meta.data_load_def_id_seq'), 'app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'data_load_definitions', '[]')) e;

  -- (042) lists and their entries, supporting scripts. Entries are inserted
  -- without a parent first and the parents set afterwards, so the order of
  -- the entries in the document doesn't matter (a moved entry may have a
  -- higher id than its children).
  insert into meta.list
  select (jsonb_populate_record(null::meta.list, '{"type": "static"}'::jsonb || jsonb_strip_nulls(e) || jsonb_build_object('id', nextval('meta.list_id_seq'), 'app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'lists', '[]')) e;
  for v_e in select * from jsonb_array_elements(coalesce(p_doc->'list_entries', '[]')) loop
    insert into meta.list_entry
    select (jsonb_populate_record(null::meta.list_entry, '{"target_items": {}}'::jsonb || jsonb_strip_nulls(v_e) || jsonb_build_object(
              'id', nextval('meta.list_entry_id_seq'), 'app_id', v_app_id, 'parent_id', null))).*
    returning id into v_new_id;
    if v_e->>'id' is not null then
      v_lmap := v_lmap || jsonb_build_object(v_e->>'id', v_new_id);
    end if;
  end loop;
  update meta.list_entry x
     set parent_id = (v_lmap->>(e->>'parent_id'))::int
    from jsonb_array_elements(coalesce(p_doc->'list_entries', '[]')) e
   where e->>'parent_id' is not null and v_lmap ? (e->>'parent_id') and v_lmap ? (e->>'id')
     and x.id = (v_lmap->>(e->>'id'))::int;
  insert into meta.supporting_script
  select (jsonb_populate_record(null::meta.supporting_script, '{"kind": "install", "seq": 10, "script": ""}'::jsonb || jsonb_strip_nulls(e)
            || jsonb_build_object('id', nextval('meta.supporting_script_id_seq'), 'app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'supporting_scripts', '[]')) e;

  -- (069) plug-ins
  insert into meta.plugin
  select (jsonb_populate_record(null::meta.plugin, e || jsonb_build_object('id', nextval('meta.plugin_id_seq'), 'app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'plugins', '[]')) e;

  -- (080) search configurations (search regions name them)
  insert into meta.search_config
  select (jsonb_populate_record(null::meta.search_config, '{"seq": 10, "source_type": "table", "searchable_columns": [], "max_results": 10}'::jsonb
            || jsonb_strip_nulls(e) || jsonb_build_object('id', nextval('meta.search_config_id_seq'), 'app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'search_configs', '[]')) e;

  -- (081) e-mail templates (meta.send_mail_template and the send_email process name them)
  insert into meta.email_template
  select (jsonb_populate_record(null::meta.email_template, e || jsonb_build_object('id', nextval('meta.email_template_id_seq'), 'app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'email_templates', '[]')) e;

  -- (068) static application files
  insert into meta.static_file (app_id, name, mime, content, updated_at)
  select v_app_id, e->>'name', e->>'mime', decode(coalesce(e->>'content', ''), 'base64'), now()
    from jsonb_array_elements(coalesce(p_doc->'static_files', '[]')) e;

  for v_e in select * from jsonb_array_elements(coalesce(p_doc->'nav', '[]')) loop
    insert into meta.nav_entry
    select (jsonb_populate_record(null::meta.nav_entry, v_e || jsonb_build_object(
              'id', nextval('meta.nav_entry_id_seq'), 'app_id', v_app_id,
              'parent_id', v_nmap->>(v_e->>'parent_id')))).*
    returning id into v_new_id;
    v_nmap := v_nmap || jsonb_build_object(v_e->>'id', v_new_id);
  end loop;

  for v_page in select * from jsonb_array_elements(coalesce(p_doc->'pages', '[]')) loop
    insert into meta.page
    select (jsonb_populate_record(null::meta.page, v_page || jsonb_build_object('id', nextval('meta.page_id_seq'), 'app_id', v_app_id))).*
    returning id into v_page_id;

    v_rmap := '{}';
    for v_e in select * from jsonb_array_elements(coalesce(v_page->'regions', '[]')) loop
      insert into meta.region
      select (jsonb_populate_record(null::meta.region, v_e || jsonb_build_object('id', nextval('meta.region_id_seq'), 'page_id', v_page_id))).*
      returning id into v_new_id;
      v_rmap := v_rmap || jsonb_build_object(v_e->>'id', v_new_id);
    end loop;
    -- facet and map regions point at their report region by id
    update meta.region r
       set config = jsonb_set(r.config, '{report}', to_jsonb((v_rmap->>(r.config->>'report'))::int))
     where r.page_id = v_page_id and r.type in ('facets', 'smart_filters', 'map') and v_rmap ? (r.config->>'report');

    insert into meta.item
    select (jsonb_populate_record(null::meta.item, e || jsonb_build_object('id', nextval('meta.item_id_seq'), 'page_id', v_page_id, 'region_id', v_rmap->>(e->>'region_id')))).*
      from jsonb_array_elements(coalesce(v_page->'items', '[]')) e;
    insert into meta.button
    select (jsonb_populate_record(null::meta.button, e || jsonb_build_object('id', nextval('meta.button_id_seq'), 'page_id', v_page_id, 'region_id', v_rmap->>(e->>'region_id')))).*
      from jsonb_array_elements(coalesce(v_page->'buttons', '[]')) e;
    insert into meta.dynamic_action
    select (jsonb_populate_record(null::meta.dynamic_action, e || jsonb_build_object('id', nextval('meta.dynamic_action_id_seq'), 'page_id', v_page_id, 'affected_region_id', v_rmap->>(e->>'affected_region_id')))).*
      from jsonb_array_elements(coalesce(v_page->'dynamic_actions', '[]')) e;
    insert into meta.validation
    select (jsonb_populate_record(null::meta.validation, e || jsonb_build_object('id', nextval('meta.validation_id_seq'), 'page_id', v_page_id))).*
      from jsonb_array_elements(coalesce(v_page->'validations', '[]')) e;
    insert into meta.process
    select (jsonb_populate_record(null::meta.process, e || jsonb_build_object('id', nextval('meta.process_id_seq'), 'page_id', v_page_id, 'region_id', v_rmap->>(e->>'region_id')))).*
      from jsonb_array_elements(coalesce(v_page->'processes', '[]')) e;
    insert into meta.computation
    select (jsonb_populate_record(null::meta.computation, e || jsonb_build_object('id', nextval('meta.computation_id_seq'), 'page_id', v_page_id))).*
      from jsonb_array_elements(coalesce(v_page->'computations', '[]')) e;
    insert into meta.branch
    select (jsonb_populate_record(null::meta.branch, e || jsonb_build_object('id', nextval('meta.branch_id_seq'), 'page_id', v_page_id))).*
      from jsonb_array_elements(coalesce(v_page->'branches', '[]')) e;
  end loop;

  return v_app_id;
end
$$;
