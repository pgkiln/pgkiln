-- =====================================================================
-- HR example, part 107: binary request bodies (sprint 243, MG-17;
-- migration 200; docs/guide/09-reference.md "Web requests from SQL",
-- 13-rest-api.md "Binary request bodies").
--
-- Page 71 "Send a file" (under page 35 "Parse and fetch"): choose a file
-- and send it to the sample CRM's web service with meta.web_request(...,
-- p_body_blob => ...), Content-Type from p_headers:
--   - "Send the file" PUTs the whole file in one request;
--   - "Send in ranges" PUTs it in ranges of 64 KiB (p_chunk_bytes), each
--     with a Content-Range header, as an upload session of Microsoft Graph
--     (OneDrive, SharePoint) expects: the CRM answers 202 with
--     nextExpectedRanges until the last range, then 201.
-- The server makes the request right after the process that queued it, so
-- the next process reads the answer. The receiving side is the REST module
-- "crm" of part 37: its handler PUT files/:name has "body": "blob", so it
-- reads the body as bytes (:BODY_BLOB, :CONTENT_TYPE) and stores it in
-- hr.crm_file (public, demonstration only, at most 5 MB a file).
-- As for page 35 the server must allow the host, e.g. in .env:
--     PGKILN_REST_ALLOWED_HOSTS=127.0.0.1
--     PGKILN_REST_PRIVATE_HOSTS=127.0.0.1
-- =====================================================================

create table hr.crm_file (
  name         text primary key,
  content_type text,
  content      bytea not null,
  received_at  timestamptz not null default now()
);
grant select, insert, update on hr.crm_file to hr_app;

-- the receiving web service: a handler of the sample CRM that reads a binary body (in ranges or whole)
update meta.rest_module m set handlers = m.handlers || $h$[
  {"method": "PUT", "path": "files/:name", "type": "plpgsql", "auth": "public", "body": "blob",
   "description": "Store a file (the body as bytes); a Content-Range header adds a range to it",
   "params": [{"name": "content_range", "in": "header", "type": "string", "description": "bytes first-last/total, for an upload in ranges"}],
   "source": "declare\n  v_body bytea := :BODY_BLOB::bytea;\n  v_range text[] := regexp_match(coalesce(:CONTENT_RANGE, ''), '^bytes (\\d+)-(\\d+)/(\\d+)$');\n  v_size bigint;\nbegin\n  if octet_length(v_body) is null or octet_length(v_body) = 0 then\n    perform meta.rest_reply(jsonb_build_object('error', 'The body is empty.'), 400);\n    return;\n  end if;\n  if v_range is null or v_range[1]::bigint = 0 then\n    insert into hr.crm_file (name, content_type, content) values (:NAME, :CONTENT_TYPE, v_body)\n    on conflict (name) do update set content_type = excluded.content_type, content = excluded.content, received_at = now();\n  else\n    update hr.crm_file set content = content || v_body, received_at = now()\n     where name = :NAME and octet_length(content) = v_range[1]::bigint;\n    if not found then\n      perform meta.rest_reply(jsonb_build_object('error', 'This range does not follow the last one.'), 416);\n      return;\n    end if;\n  end if;\n  select octet_length(content) into v_size from hr.crm_file where name = :NAME;\n  if v_size > 5242880 then\n    raise exception 'A file of the sample CRM is at most 5 MB.';\n  end if;\n  if v_range is not null and v_size < v_range[3]::bigint then\n    perform meta.rest_reply(jsonb_build_object('nextExpectedRanges', jsonb_build_array(v_size || '-')), 202);\n  else\n    perform meta.rest_reply(jsonb_build_object('name', :NAME, 'size', v_size), 201);\n  end if;\nend"}
]$h$::jsonb
  from meta.app a
 where a.id = m.app_id and a.alias = 'hr' and m.name = 'crm';

insert into meta.page (app_id, page_no, name, title, parent_page)
select id, 71, 'Send a file', 'Send a file', 35 from meta.app where alias = 'hr';

insert into meta.region (page_id, seq, title, type, columns, template, source, config)
select p.id, r.seq, r.title, r.type, 12, 'standard', r.source, r.config::jsonb
  from meta.page p join meta.app a on a.id = p.app_id, (values
  (10, 'Send a file to a web service', 'static',
   '<p>Choose a file and send it to the sample CRM''s web service. <b>Send the file</b> PUTs it in one request with <code>meta.web_request(…, p_body_blob =&gt; …)</code>; <b>Send in ranges</b> PUTs it in ranges of 64 KiB (<code>p_chunk_bytes</code>), as an upload session of OneDrive or SharePoint expects.</p>',
   '{}'),
  (20, 'Files the CRM received', 'report',
   'select name, content_type, octet_length(content) as size, received_at from hr.crm_file order by received_at desc',
   '{"page_size": 10, "headings": {"name": "File", "content_type": "Type", "size": "Bytes", "received_at": "Received"}, "empty": "No file sent yet."}')
  ) as r (seq, title, type, source, config)
 where a.alias = 'hr' and p.page_no = 71;

insert into meta.item (page_id, region_id, seq, name, label, type, config, help)
select p.id, r.id, i.seq, i.name, i.label, i.type, i.config::jsonb, i.help
  from (values
  (10, 'P71_FILE', 'File', 'file', '{"max_mb": 5}', 'Any file of at most 5 MB, e.g. a photo or a PDF.'),
  (20, 'P71_REQUEST', 'Request', 'hidden', '{}', null),
  (30, 'P71_STATUS', 'Result', 'display', '{}', 'The answer of the CRM: its HTTP status code and what it stored, or why the request could not be made.')
  ) as i (seq, name, label, type, config, help)
  join meta.page p on p.page_no = 71 join meta.app a on a.id = p.app_id and a.alias = 'hr'
  join meta.region r on r.page_id = p.id and r.title = 'Send a file to a web service';

insert into meta.button (page_id, region_id, seq, name, label, action, hot)
select p.id, r.id, b.seq, b.name, b.label, 'submit', b.hot
  from (values
  (10, 'SEND', 'Send the file', true),
  (20, 'SEND_RANGES', 'Send in ranges', false)
  ) as b (seq, name, label, hot)
  join meta.page p on p.page_no = 71 join meta.app a on a.id = p.app_id and a.alias = 'hr'
  join meta.region r on r.page_id = p.id and r.title = 'Send a file to a web service';

insert into meta.validation (page_id, seq, name, item_name, type, message)
select p.id, 10, 'A file to send', 'P71_FILE', 'not_null', 'Choose a file first.'
  from meta.page p join meta.app a on a.id = p.app_id
 where a.alias = 'hr' and p.page_no = 71;

insert into meta.process (page_id, seq, name, type, point, code)
select p.id, x.seq, x.name, 'sql', 'submit', x.code
  from (values
  -- the server makes the request right after this process (same transaction)
  (10, 'Send the file',
   $c$select meta.web_request(current_setting('pgkiln.public_url') || '/a/hr/rest/crm/files/' || meta.url_encode(f.filename),
                        'PUT',
                        p_body_blob   => f.content,
                        p_headers     => jsonb_build_object('Content-Type', coalesce(f.mime_type, 'application/octet-stream')),
                        p_chunk_bytes => case when :REQUEST = 'SEND_RANGES' and f.size > 65536 then 65536 end,
                        p_timeout_s   => 20) as p71_request
  from meta.temp_files f
 where f.id = :P71_FILE::uuid$c$),
  (20, 'Read the answer',
   $c$select meta.delete_temp_file(:P71_FILE::uuid);
select case when r ->> 'status' <> 'ok' then (r ->> 'status') || ': ' || coalesce(r ->> 'message', '')
            else 'HTTP ' || (r ->> 'status_code') || ': ' || coalesce(r -> 'json' ->> 'size', '?') || ' of ' || (r ->> 'body_blob_bytes') || ' bytes stored'
                 || case when r ->> 'chunk_bytes' is not null then ' (sent in ranges of ' || (r ->> 'chunk_bytes') || ' bytes)' else '' end end as p71_status
  from meta.web_response(:P71_REQUEST::bigint) r$c$)
  ) as x (seq, name, code)
  join meta.page p on p.page_no = 71 join meta.app a on a.id = p.app_id and a.alias = 'hr';

-- page 35 links to it
insert into meta.button (page_id, region_id, seq, name, label, action, target_page)
select p.id, r.id, 50, 'SEND_FILE', 'Send a file', 'redirect', 71
  from meta.page p join meta.app a on a.id = p.app_id and a.alias = 'hr'
  join meta.region r on r.page_id = p.id and r.title = 'Call a web service'
 where p.page_no = 35;

insert into meta.translation (app_id, language, source, target)
select a.id, 'nl', t.source, t.target
  from meta.app a, (values
  ('Send a file', 'Een bestand versturen'),
  ('Send a file to a web service', 'Een bestand naar een webservice versturen'),
  ('Files the CRM received', 'Bestanden die het CRM ontving'),
  ('File', 'Bestand'),
  ('Send the file', 'Bestand versturen'),
  ('Send in ranges', 'In delen versturen'),
  ('Choose a file first.', 'Kies eerst een bestand.')
  ) as t (source, target)
 where a.alias = 'hr'
on conflict do nothing;
