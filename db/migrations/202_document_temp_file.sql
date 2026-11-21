-- (sprint 245, MG-18) A document template's PDF as a temporary file of the session, from SQL.
--
-- meta.document_pdf (192) gives a reference that only becomes a PDF in a mail attachment. A signed form often has to be
-- kept as well: meta.document_temp_file(template, items, filename) returns the id (a uuid) of a temporary file of the
-- session (meta.temp_files, 009) that the server draws right after the process that called it ends, in the same
-- transaction, as the application's role, with the data as the process left it (src/runtime/document-pdf.ts). From
-- the next process of the same submit (or Ajax callback, dynamic action) on it is a PDF like an uploaded file:
--   insert into sales.order_document (order_id, filename, mime_type, content)
--   select :P3_ID::int, filename, mime_type, content from meta.temp_files where id = :P3_PDF::uuid;
-- and a web request, a mail attachment or a file item's object storage can take it from there.
--
-- How:
--   * the temporary file is a row of meta.temp_file at once (the uuid is valid in the calling statement), holding the
--     reference of meta.document_pdf and size -1 until the server puts the PDF in it (meta.document_temp_file_fill).
--     size -1 never comes from an upload (meta.save_temp_file stores octet_length), so nothing else looks undrawn.
--   * a deferred constraint trigger refuses to commit a transaction that still has an undrawn one: SQL outside a process
--     the server runs (a job, psql) fails with a clear message instead of leaving a file that isn't a PDF.
--   * the request is registered in the transaction-local setting of meta.document_pdf, with "temp_file": true.
--
-- Safety: as meta.document_pdf (the caller runs as the application's role; only the application's own templates; the
-- server draws with the application and user of the request, the template's authorization scheme applies). The file
-- belongs to the session that asked for it: meta.temp_files shows only the current session's files, and
-- meta.document_temp_file_fill only fills an undrawn file of the current session registered in this transaction.
-- No new table and nothing exported: temporary files are session data, deleted with the session.

-- APEX_PRINT.GENERATE_DOCUMENT into APEX_APPLICATION_TEMP_FILES: the id of a temporary file that becomes the PDF of the
-- template, filled with p_items over the session state, when the process ends. p_filename (".pdf" is added) or the
-- template's file name.
create function meta.document_temp_file(p_template text, p_items jsonb default '{}', p_filename text default null) returns uuid
language plpgsql volatile security definer set search_path = meta, pg_catalog as $$
declare
  v_session uuid := nullif(current_setting('pgkiln.session_id', true), '')::uuid;
  v_ref     bytea;
  v_key     text;
  v_reqs    jsonb;
begin
  if v_session is null then
    raise exception 'meta.document_temp_file: no session (call it in a process, Ajax callback or dynamic action of a page)';
  end if;
  if p_filename is not null and length(p_filename) > 255 then
    raise exception 'meta.document_temp_file: the file name is longer than 255 characters';
  end if;
  -- the template, the items and the limits are checked there; the request is registered under the reference's uuid
  v_ref := meta.document_pdf(p_template, p_items);
  v_key := convert_from(substring(v_ref from 21), 'UTF8');
  v_reqs := meta.document_pdf_requests();
  perform set_config('pgkiln.document_pdf',
    (v_reqs || jsonb_build_object(v_key, (v_reqs -> v_key) || jsonb_build_object('temp_file', true, 'filename', nullif(trim(p_filename), ''))))::text, true);
  insert into temp_file (id, session_id, item_name, filename, mime_type, size, content)
  values (v_key::uuid, v_session, 'DOCUMENT', 'document.pdf', 'application/pdf', -1, v_ref);
  -- a session keeps its 20 newest temporary files (as meta.save_temp_file), and the ones still to be drawn
  delete from temp_file
   where session_id = v_session and size >= 0
     and id not in (select id from temp_file where session_id = v_session order by created_at desc limit 20);
  return v_key::uuid;
end
$$;
grant execute on function meta.document_temp_file(text, jsonb, text) to public;
comment on function meta.document_temp_file(text, jsonb, text) is
  'The id of a temporary file (meta.temp_files) that the server draws as the PDF of a document template when the process ends (sprint 245)';

-- (server) Everything of this transaction the server has to draw for application p_app, after a process: the mail
-- attachments of meta.document_pdf (kind "mail", ref = the attachment id) and the temporary files of
-- meta.document_temp_file of the current session (kind "temp_file", ref = the file id). One query when there are none.
create function meta.document_pending(p_app int)
returns table (kind text, ref text, template text, items jsonb, filename text)
language plpgsql stable security definer set search_path = meta, pg_catalog as $$
declare
  v_reqs    jsonb := meta.document_pdf_requests();
  v_session uuid := nullif(current_setting('pgkiln.session_id', true), '')::uuid;
begin
  if v_reqs = '{}' then
    return;
  end if;
  if p_app is distinct from meta.document_pdf_caller() then
    return;
  end if;
  return query
    select 'mail'::text, d.attachment_id::text, d.template, d.items, null::text from meta.document_pdf_pending(p_app) d;
  if v_session is not null then
    return query
      select 'temp_file'::text, t.id::text, r.value->>'template', r.value->'items', r.value->>'filename'
        from meta.temp_file t
        join jsonb_each(v_reqs) r on t.id::text = r.key
       where t.session_id = v_session and t.size = -1
         and r.value->>'temp_file' = 'true' and (r.value->>'app')::int = p_app
       order by t.created_at, t.id;
  end if;
end
$$;
grant execute on function meta.document_pending(int) to public;

-- (server) The drawn PDF into an undrawn temporary file of meta.document_temp_file: the current session's, registered
-- in this transaction for the current application.
create function meta.document_temp_file_fill(p_id uuid, p_content bytea, p_filename text) returns void
language plpgsql volatile security definer set search_path = meta, pg_catalog as $$
declare
  v_app     int := meta.document_pdf_caller();
  v_session uuid := nullif(current_setting('pgkiln.session_id', true), '')::uuid;
  v_req     jsonb := meta.document_pdf_requests() -> p_id::text;
begin
  if v_session is null or v_req is null or v_req->>'temp_file' is distinct from 'true' or (v_req->>'app') is distinct from v_app::text then
    raise exception 'meta.document_temp_file_fill: % is no document of this transaction', p_id;
  end if;
  if p_content is null or octet_length(p_content) > 10 * 1024 * 1024 then
    raise exception 'meta.document_temp_file: the PDF is larger than 10 MB';
  end if;
  update temp_file
     set content = p_content, size = octet_length(p_content), mime_type = 'application/pdf',
         filename = left(coalesce(nullif(trim(p_filename), ''), 'document.pdf'), 255)
   where id = p_id and session_id = v_session and size = -1;
  if not found then
    raise exception 'meta.document_temp_file_fill: % is no document of this transaction', p_id;
  end if;
end
$$;
grant execute on function meta.document_temp_file_fill(uuid, bytea, text) to public;

-- A transaction never commits a temporary file that is still a reference (SQL outside a process the server runs).
create function meta.temp_file_drawn() returns trigger
language plpgsql security definer set search_path = meta, pg_catalog as $$
begin
  if exists (select 1 from temp_file where id = new.id and size = -1) then
    raise exception 'meta.document_temp_file: the document was not drawn: call meta.document_temp_file in a process, Ajax callback or dynamic action of a page, where the server draws the PDF when the process ends';
  end if;
  return null;
end
$$;
create constraint trigger temp_file_drawn after insert on meta.temp_file
  deferrable initially deferred for each row when (new.size = -1) execute function meta.temp_file_drawn();
