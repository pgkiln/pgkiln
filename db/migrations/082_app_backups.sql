-- =====================================================================
-- 082: automatic application backups (APEX: Application Backups)
--
-- meta.app_backup keeps exports of an application: one before every
-- import that replaces it (pgkiln import --replace, the MCP import, a
-- working copy's merge, a restore), one a day when it changed since the
-- last backup (the scheduler), and the ones a developer makes. The newest
-- meta.app.backups_keep (default 25, 0 = none) are kept per application.
-- The builder lists, downloads, restores and deletes them (Application →
-- Backups); a restore is an import --replace of the backup, so the version
-- it replaces is backed up too. Installation data: not exported, kept by
-- an import over the application.
-- =====================================================================

create table meta.app_backup (
  id         bigint generated always as identity primary key,
  app_id     int not null references meta.app on delete cascade,
  created_at timestamptz not null default now(),
  created_by text,
  reason     text not null check (reason in ('import', 'merge', 'restore', 'daily', 'manual')),
  note       text check (length(note) <= 500),
  doc        jsonb not null,
  -- md5 of the export, so a daily backup of an unchanged application is skipped
  doc_hash   text not null,
  size       int not null
);
create index app_backup_app on meta.app_backup (app_id, created_at desc);
revoke all on meta.app_backup from public;
comment on table meta.app_backup is 'Application backups (082): exports kept by this installation, never exported';

alter table meta.app add column backups_keep int not null default 25 check (backups_keep between 0 and 500);

-- an export made before 082 has no backups_keep: NULL becomes 25
create function meta.app_backups_keep_default() returns trigger
language plpgsql set search_path = pg_catalog as $$
begin
  new.backups_keep := coalesce(new.backups_keep, 25);
  return new;
end $$;
create trigger app_backups_keep before insert or update on meta.app
  for each row execute function meta.app_backups_keep_default();

-- Back an application up (the server and the command line call it as the owner). A daily
-- backup of an application that didn't change since its newest backup is skipped (NULL).
create function meta.backup_app(p_app_id int, p_reason text, p_user text default null, p_note text default null)
returns bigint
language plpgsql volatile set search_path = meta, pg_catalog as $$
declare
  v_alias text;
  v_keep  int;
  v_doc   jsonb;
  v_hash  text;
  v_id    bigint;
begin
  select alias, backups_keep into v_alias, v_keep from meta.app where id = p_app_id;
  if v_alias is null or v_keep = 0 then
    return null;
  end if;
  v_doc := meta.export_app(v_alias);
  v_hash := md5(v_doc::text);
  if p_reason = 'daily' and v_hash = (select doc_hash from meta.app_backup where app_id = p_app_id order by created_at desc, id desc limit 1) then
    return null;
  end if;
  insert into meta.app_backup (app_id, created_by, reason, note, doc, doc_hash, size)
  values (p_app_id, p_user, p_reason, left(p_note, 500), v_doc, v_hash, octet_length(v_doc::text))
  returning id into v_id;
  delete from meta.app_backup
   where app_id = p_app_id
     and id not in (select id from meta.app_backup where app_id = p_app_id order by created_at desc, id desc limit v_keep);
  return v_id;
end
$$;
revoke all on function meta.backup_app(int, text, text, text) from public;
