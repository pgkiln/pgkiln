-- (sprint 237, MG-3) PDF bytes of a document template from SQL, for mail attachments.
--
-- Document templates (020) are drawn as PDF by the server (src/runtime/document.ts), in Node: SQL cannot run the
-- renderer. meta.document_pdf(template, items) therefore returns a *reference* (a short bytea), which the server
-- renders right after the process that called it ends: in the same transaction, on the same connection, as the
-- application's role (grants and RLS apply), with the data as the process left it, the page's session state and the
-- given items (src/runtime/document-pdf.ts). Wherever the reference became a mail attachment (meta.add_mail_attachment)
-- the server puts the PDF in its place before the transaction commits, so the mail sender only ever sees the PDF.
--
-- Safety:
--   * meta.document_pdf only answers for the current application when the caller runs as its database role
--     (as meta.send_mail does) and only names that application's own templates; the server renders with the
--     application of the request, never with an application named in SQL.
--   * a reference is a random UUID registered in a transaction-local setting by meta.document_pdf: bytes that only
--     look like one (an uploaded file) are never rendered; a reference that reaches the mail sender unrendered (SQL
--     outside a process the server runs) fails that mail instead of sending the reference.
--   * meta.document_pdf_pending / meta.document_pdf_fill touch only attachments of mails the current application
--     queued in the current transaction.
-- No table: nothing here is exported or kept.

-- The current application when the caller runs as its database role (meta.mail_caller without the mail service).
create function meta.document_pdf_caller() returns int
language plpgsql stable security definer set search_path = meta, pg_catalog as $$
declare
  v_app  int := meta.app_id();
  v_role text;
begin
  if v_app is null then
    raise exception 'meta.document_pdf: no current application (call it from application code)';
  end if;
  select a.db_role into v_role from meta.app a where a.id = v_app;
  if not found then
    raise exception 'meta.document_pdf: no current application (call it from application code)';
  end if;
  if v_role is not null and current_setting('role') is distinct from v_role then
    raise exception 'meta.document_pdf: called outside the application''s own database role';
  end if;
  return v_app;
end
$$;
revoke all on function meta.document_pdf_caller() from public;

-- The references registered in this transaction: {"<uuid>": {"template": "NAME", "items": {...}}}.
create function meta.document_pdf_requests() returns jsonb
language plpgsql stable set search_path = meta, pg_catalog as $$
declare
  v text := current_setting('pgkiln.document_pdf', true);
begin
  if coalesce(v, '') = '' then
    return '{}';
  end if;
  begin
    return case when jsonb_typeof(v::jsonb) = 'object' then v::jsonb else '{}' end;
  exception when others then
    return '{}';
  end;
end
$$;
revoke all on function meta.document_pdf_requests() from public;

-- APEX_PRINT.GENERATE_DOCUMENT for a document template: a reference to its PDF, filled with p_items (item name →
-- value) over the session state. Give it to meta.add_mail_attachment: the server renders the PDF when the process ends.
create function meta.document_pdf(p_template text, p_items jsonb default '{}') returns bytea
language plpgsql volatile security definer set search_path = meta, pg_catalog as $$
declare
  v_app   int := meta.document_pdf_caller();
  v_name  text := upper(trim(coalesce(p_template, '')));
  v_items jsonb := '{}';
  v_k     text;
  v_v     jsonb;
  v_reqs  jsonb := meta.document_pdf_requests();
  v_id    text := gen_random_uuid()::text;
begin
  if not exists (select 1 from meta.document_template where app_id = v_app and name = v_name) then
    raise exception 'meta.document_pdf: the application has no document template %', coalesce(p_template, '(none)');
  end if;
  if p_items is not null and jsonb_typeof(p_items) <> 'object' then
    raise exception 'meta.document_pdf: p_items is a JSON object of item names and values, e.g. jsonb_build_object(''P3_ID'', 42)';
  end if;
  for v_k, v_v in select key, value from jsonb_each(coalesce(p_items, '{}')) loop
    if v_k !~ '^[A-Za-z][A-Za-z0-9_$]{0,127}$' then
      raise exception 'meta.document_pdf: % is not an item name', left(v_k, 130);
    end if;
    if jsonb_typeof(v_v) in ('object', 'array') then
      raise exception 'meta.document_pdf: the value of % is text, a number, a boolean or null', v_k;
    end if;
    v_items := v_items || jsonb_build_object(upper(v_k), case jsonb_typeof(v_v) when 'null' then null when 'string' then v_v #>> '{}' else v_v::text end);
  end loop;
  if (select count(*) from jsonb_object_keys(v_reqs)) >= 50 then
    raise exception 'meta.document_pdf: at most 50 documents per transaction';
  end if;
  if octet_length(v_items::text) > 32000 then
    raise exception 'meta.document_pdf: the item values are too long (32,000 bytes at most)';
  end if;
  perform set_config('pgkiln.document_pdf', (v_reqs || jsonb_build_object(v_id, jsonb_build_object('app', v_app, 'template', v_name, 'items', v_items)))::text, true);
  return convert_to('pgkiln:document_pdf:' || v_id, 'UTF8');
end
$$;
grant execute on function meta.document_pdf(text, jsonb) to public;
comment on function meta.document_pdf(text, jsonb) is
  'A reference to the PDF of a document template (sprint 237): the server renders it when the process ends and puts it in place of the reference in mail attachments';

-- (server) The mail attachments of this transaction that are references of meta.document_pdf, for application p_app.
create function meta.document_pdf_pending(p_app int)
returns table (attachment_id bigint, template text, items jsonb)
language plpgsql stable security definer set search_path = meta, pg_catalog as $$
declare
  v_reqs jsonb := meta.document_pdf_requests();
  v_xact bigint := txid_current_if_assigned();
begin
  -- nothing registered, or no mail queued in this transaction (queuing one assigns a transaction id)
  if v_reqs = '{}' or v_xact is null then
    return;
  end if;
  if p_app is distinct from meta.document_pdf_caller() then
    return;
  end if;
  return query
    select a.id, r.value->>'template', r.value->'items'
      from meta.mail_queue m
      join meta.mail_attachment a on a.mail_id = m.id
      join jsonb_each(v_reqs) r on a.content = convert_to('pgkiln:document_pdf:' || r.key, 'UTF8')
     where m.app_id = p_app and m.created_xact = v_xact and m.status = 'queued'
       and octet_length(a.content) < 100 and (r.value->>'app')::int = p_app
     order by a.id;
end
$$;
grant execute on function meta.document_pdf_pending(int) to public;

-- (server) The rendered PDF in place of a reference: an attachment of a mail the current application queued in this
-- transaction whose content is a registered reference. The limits of meta.add_mail_attachment apply.
create function meta.document_pdf_fill(p_attachment bigint, p_content bytea) returns void
language plpgsql volatile security definer set search_path = meta, pg_catalog as $$
declare
  v_app  int := meta.document_pdf_caller();
  v_mail bigint;
  v_old  bytea;
  v_size bigint;
begin
  select a.mail_id, a.content into v_mail, v_old
    from meta.mail_attachment a join meta.mail_queue m on m.id = a.mail_id
   where a.id = p_attachment and m.app_id = v_app and m.status = 'queued' and m.created_xact = txid_current();
  if not found or octet_length(v_old) >= 100 or substring(v_old from 1 for 20) <> convert_to('pgkiln:document_pdf:', 'UTF8')
     or (meta.document_pdf_requests() -> encode(substring(v_old from 21), 'escape') ->> 'app') is distinct from v_app::text then
    raise exception 'meta.document_pdf_fill: attachment % is no document reference of this transaction', p_attachment;
  end if;
  if p_content is null or octet_length(p_content) > 10 * 1024 * 1024 then
    raise exception 'meta.document_pdf: the PDF is larger than 10 MB';
  end if;
  select coalesce(sum(octet_length(content)), 0) into v_size from meta.mail_attachment where mail_id = v_mail and id <> p_attachment;
  if v_size + octet_length(p_content) > 20 * 1024 * 1024 then
    raise exception 'meta.add_mail_attachment: at most 20 attachments and 20 MB per mail';
  end if;
  update meta.mail_attachment
     set content = p_content,
         mime = case when mime = 'application/octet-stream' then 'application/pdf' else mime end
   where id = p_attachment;
end
$$;
grant execute on function meta.document_pdf_fill(bigint, bytea) to public;
