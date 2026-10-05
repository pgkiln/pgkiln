-- =====================================================================
-- 055: working copies (APEX 24.1+: working copies and merge)
--
-- A working copy is a second application made from the main application's
-- export: developers change it in isolation, compare it with the main
-- application and merge it back component by component. This table links
-- the copy to its main application and keeps the *base*: the main
-- application's export (format pgapex/2) when the copy was made, last
-- refreshed or last merged. Comparing base, main and copy per component
-- (src/workingcopy.ts) tells which side changed what, and where both did
-- (a conflict the developer resolves).
--
-- A copy runs against the main application's schema and role (it is the
-- same application, changed). Copies are builder state of this
-- installation: never exported. Deleting the main application deletes
-- this link; the copy then stays as an ordinary application.
-- =====================================================================

create table meta.working_copy (
  app_id       int primary key references meta.app on delete cascade,
  main_app_id  int not null references meta.app on delete cascade,
  name         text not null check (name ~ '^[A-Za-z0-9][A-Za-z0-9 _-]{0,39}$'),
  base         jsonb not null check (base->>'format' = 'pgapex/2'),
  created_by   text not null,
  created_at   timestamptz not null default now(),
  refreshed_at timestamptz,
  merged_at    timestamptz,
  merged_by    text,
  check (app_id <> main_app_id),
  unique (main_app_id, name)
);
create index working_copy_main_idx on meta.working_copy (main_app_id);

comment on table meta.working_copy is 'Working copies: app_id is a copy of main_app_id; base is the main application''s export when copied, refreshed or merged';

-- no copies of copies, and a main application is not itself a copy
create function meta.working_copy_check() returns trigger
language plpgsql set search_path = pg_catalog as $$
begin
  if exists (select 1 from meta.working_copy where app_id = new.main_app_id) then
    raise exception 'application % is a working copy: make copies of its main application', new.main_app_id;
  end if;
  if exists (select 1 from meta.working_copy where main_app_id = new.app_id) then
    raise exception 'application % has working copies of its own', new.app_id;
  end if;
  return new;
end $$;
create trigger working_copy_check before insert or update on meta.working_copy
  for each row execute function meta.working_copy_check();
