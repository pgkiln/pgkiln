-- ---------------------------------------------------------------------
-- File upload items (APEX "File Browse")
--
-- An uploaded file is first stored as a temporary file of the session.
-- The item's value is then the temporary file's id (a uuid):
--   * a form region with the item's source column (bytea) saves it into
--     the row, with the file name and MIME type in the columns named by
--     config.filename_column / config.mime_column;
--   * otherwise processes read it from meta.temp_files, like
--     APEX_APPLICATION_TEMP_FILES:
--       insert into document (name, mime_type, content)
--       select filename, mime_type, content from meta.temp_files where id = :P5_FILE::uuid;
--
-- meta.temp_files only shows the current session's files. They are
-- deleted with the session (sign-out or expiry).
-- ---------------------------------------------------------------------
alter table meta.item drop constraint item_type_check;
alter table meta.item add constraint item_type_check check (type in
  ('text', 'textarea', 'number', 'date', 'datetime', 'select', 'radio', 'checkbox', 'switch',
   'hidden', 'display', 'password', 'checkbox_group', 'multiselect', 'popup_lov',
   'email', 'tel', 'url', 'color', 'file'));

create table meta.temp_file (
  id          uuid primary key default gen_random_uuid(),
  session_id  uuid not null references meta.session on delete cascade,
  item_name   text not null,
  filename    text not null,
  mime_type   text not null,
  size        int  not null,
  content     bytea not null,
  created_at  timestamptz not null default now()
);
create index on meta.temp_file (session_id, created_at);

-- Store an upload for the current session (called by the runtime inside
-- the request transaction, as the application's database role). A session
-- keeps at most 20 temporary files; older ones are removed.
create function meta.save_temp_file(p_item text, p_filename text, p_mime text, p_content bytea)
returns uuid
language plpgsql security definer set search_path = meta, pg_catalog as $$
declare
  v_session uuid := nullif(current_setting('pgapex.session_id', true), '')::uuid;
  v_id uuid;
begin
  if v_session is null then
    raise exception 'no session';
  end if;
  insert into temp_file (session_id, item_name, filename, mime_type, size, content)
  values (v_session, upper(p_item), left(p_filename, 255), left(p_mime, 255), octet_length(p_content), p_content)
  returning id into v_id;
  delete from temp_file
   where session_id = v_session
     and id not in (select id from temp_file where session_id = v_session order by created_at desc limit 20);
  return v_id;
end
$$;

-- The current session's files. The view runs with its owner's rights, so
-- application roles need no access to meta.temp_file itself.
create view meta.temp_files with (security_barrier) as
  select id, item_name, filename, mime_type, size, content, created_at
    from meta.temp_file
   where session_id = nullif(current_setting('pgapex.session_id', true), '')::uuid;

revoke all on meta.temp_file from public;
grant execute on function meta.save_temp_file(text, text, text, bytea) to public;
grant select on meta.temp_files to public;

-- Temporary files can be removed by the session itself.
create function meta.delete_temp_file(p_id uuid) returns void
language sql security definer set search_path = meta, pg_catalog as $$
  delete from temp_file
   where id = p_id and session_id = nullif(current_setting('pgapex.session_id', true), '')::uuid
$$;
grant execute on function meta.delete_temp_file(uuid) to public;
