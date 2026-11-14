-- =====================================================================
-- 170: page aliases and who changed each page (sprint 193, NX-F3)
--
-- APEX: a page's Alias (Identification) gives it a readable URL, and the
-- Pages report shows Alias, Updated and Updated By.
--
-- meta.page.alias      lower case a-z, 0-9 and single hyphens, at most 64
--                      characters, not only digits (a number is a page
--                      number), unique per application and never one of the
--                      runtime's own path segments of /a/<app>/… (login,
--                      account, rest, static, …: meta.page_alias_reserved,
--                      the same list as src/page-alias.ts). /a/<app>/<alias>
--                      opens the page as /a/<app>/<number> does, with the
--                      same authorization, protection and checksums (they
--                      are made with the page number, so either URL takes the
--                      same signed values).
--                      A page without one (a new page, a page of an export
--                      made before 170, a generated page) gets one from its
--                      name: "Leave requests" → leave-requests, "Login" →
--                      login-page, "従業員" → page-12, a second "Employees"
--                      → employees-2. On insert a taken alias (a copied page)
--                      gets the next free variant. Exports carry it.
--
-- meta.page_change     the developer who changed a page last, and when: one
--                      row per page number. Written by src/history.ts
--                      recordHistory() for every page whose components a
--                      recorded change touched (Page Designer saves, any
--                      component edit, import --replace, restores,
--                      upgrades) and for every page of an application a
--                      Create or an Import made. Builder state like
--                      meta.app_change (migration 125): not exported, kept
--                      by pgkiln import --replace (keyed by the page number,
--                      not the page's id, which a replace renews).
--                      Filled here from the change history (138).
--
-- meta.developer.page_columns  the Pages report's columns each developer
--                      chose (null: the default set).
-- =====================================================================

-- ---------------------------------------------------------------- alias
create function meta.page_alias_reserved(p text) returns boolean
language sql immutable parallel safe set search_path = pg_catalog as $$
  select p = any (array['account', 'autorest', 'login', 'logout', 'notifications', 'offline', 'password', 'push',
                        'reports', 'rest', 'session', 'sso', 'static', 'tasks', 'telemetry', 'tz', 'workflows',
                        'workspace-files'])
$$;
comment on function meta.page_alias_reserved(text) is 'Path segments of /a/<app>/… the runtime uses itself: never a page alias (170)';

/** The alias a name suggests (not yet checked for uniqueness). */
create function meta.page_alias_slug(p_name text) returns text
language sql immutable parallel safe set search_path = pg_catalog as $$
  select left(btrim(regexp_replace(
           regexp_replace(lower(normalize(coalesce(p_name, ''), NFKD)), '[̀-ͯ]', '', 'g'),
           '[^a-z0-9]+', '-', 'g'), '-'), 60)
$$;

/** A free alias in an application from a wished one (or the name), never page p_id's own neighbour's. */
create function meta.page_alias_free(p_app int, p_page_id int, p_page_no int, p_wish text) returns text
language plpgsql stable set search_path = pg_catalog as $$
declare
  v_base text := btrim(meta.page_alias_slug(p_wish), '-');
  v      text;
  n      int := 2;
begin
  v_base := btrim(left(v_base, 58), '-');
  if v_base = '' or v_base ~ '^[0-9-]+$' then v_base := 'page-' || coalesce(p_page_no, 0); end if;
  if meta.page_alias_reserved(v_base) then v_base := v_base || '-page'; end if;
  v := v_base;
  while exists (select 1 from meta.page p where p.app_id = p_app and p.alias = v and p.id is distinct from p_page_id) loop
    v := v_base || '-' || n;
    n := n + 1;
  end loop;
  return v;
end $$;

alter table meta.page add column alias text;

-- existing pages: from their names, in page order
do $$
declare r record;
begin
  for r in select id, app_id, page_no, name from meta.page order by app_id, page_no loop
    update meta.page set alias = meta.page_alias_free(r.app_id, r.id, r.page_no, r.name) where id = r.id;
  end loop;
end $$;

create function meta.page_alias_default() returns trigger
language plpgsql set search_path = pg_catalog as $$
begin
  if new.alias is not null then new.alias := nullif(btrim(new.alias), ''); end if;
  if new.alias is null then
    new.alias := meta.page_alias_free(new.app_id, new.id, new.page_no, new.name);
  elsif tg_op = 'INSERT' and exists (select 1 from meta.page p where p.app_id = new.app_id and p.alias = new.alias and p.id <> new.id) then
    -- a copied page, or a document with the same alias twice: the next free one
    new.alias := meta.page_alias_free(new.app_id, new.id, new.page_no, new.alias);
  end if;
  return new;
end $$;
create trigger page_alias_default before insert or update on meta.page
  for each row execute function meta.page_alias_default();

alter table meta.page
  alter column alias set not null,
  add constraint page_alias_check check (
    length(alias) <= 64 and alias ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and alias !~ '^[0-9]+$' and not meta.page_alias_reserved(alias));
create unique index page_app_alias_key on meta.page (app_id, alias);
comment on column meta.page.alias is 'Page alias (170): /a/<app>/<alias> opens the page; a-z, 0-9 and hyphens, unique per application, from the name when empty';

-- the change history's snapshots (138) get the aliases too: else the first change after this migration
-- would record every page as changed (its new alias)
update meta.app_snapshot s
   set doc = jsonb_set(s.doc, '{pages}', (
         select coalesce(jsonb_agg(e || jsonb_build_object('alias', coalesce(
                  (select p.alias from meta.page p where p.app_id = s.app_id and p.page_no = (e ->> 'page_no')::int),
                  meta.page_alias_slug(e ->> 'name'))) order by o), '[]')
           from jsonb_array_elements(s.doc -> 'pages') with ordinality x(e, o)))
 where jsonb_typeof(s.doc -> 'pages') = 'array';

-- ---------------------------------------------------------------- who changed a page last
create table meta.page_change (
  app_id     int not null references meta.app on delete cascade,
  page_no    int not null check (page_no > 0),
  updated_by text check (length(updated_by) between 1 and 200),
  updated_at timestamptz not null default now(),
  source     text not null default 'builder' check (source in ('builder', 'import', 'upgrade')),
  primary key (app_id, page_no)
);
comment on table meta.page_change is 'builder: the developer who changed a page last, and when (Pages report: Updated, Updated by; 170)';

insert into meta.page_change (app_id, page_no, updated_by, updated_at, source)
select distinct on (c.app_id, c.page_no) c.app_id, c.page_no, left(c.changed_by, 200), c.changed_at, c.source
  from meta.component_change c
 where c.page_no > 0 and exists (select 1 from meta.page p where p.app_id = c.app_id and p.page_no = c.page_no)
 order by c.app_id, c.page_no, c.changed_at desc, c.id desc;

-- ---------------------------------------------------------------- the Pages report's columns per developer
alter table meta.developer add column page_columns text[]
  check (page_columns is null or (cardinality(page_columns) <= 30 and array_to_string(page_columns, ',') ~ '^[a-z_,]*$'));
comment on column meta.developer.page_columns is 'The Pages report''s columns this developer chose (170); null: the default set';
