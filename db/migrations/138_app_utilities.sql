-- =====================================================================
-- 138: an application's Utilities (sprint 138, AP-5; APEX: Application
--      Utilities: Change History, Attribute Dictionary / UI defaults)
--
-- meta.app_snapshot: the application's export (meta.export_app) after the
--   last recorded change. The builder compares it with a new export after
--   each change (src/history.ts, the working copies' component split) and
--   keeps what changed per component in meta.component_change.
-- meta.component_change: one row per component that a change added,
--   changed or deleted: its id in the one-file-per-component layout
--   (src/appfiles.ts, e.g. pages/0003/items/p3_sal), a label, the page,
--   the component's files before and after ({"path": "text"}), who (a
--   developer, or null for the command line / MCP server) and when.
--   Installation data: not exported, kept by import --replace.
-- meta.ui_default: UI defaults per table column (APEX: Attribute
--   Dictionary / Table UI Defaults): label, format mask, help, alignment
--   and list of values. The page wizards and the Create Application wizard
--   take the label from meta.wizard_column_label (redefined below: a UI
--   default wins); a form item made by a wizard also gets the column's
--   format mask, help and list of values (meta.ui_default_item, a trigger
--   on meta.item that only acts right after meta.wizard_column_label named
--   a column with a UI default in the same transaction).
--   Installation data, keyed by schema, table and column names (not oids:
--   they survive a dump and restore). Not exported with an application.
-- =====================================================================

create table meta.app_snapshot (
  app_id   int primary key references meta.app (id) on delete cascade,
  doc      jsonb not null,
  taken_at timestamptz not null default now()
);
comment on table meta.app_snapshot is
  'The application''s export after its last recorded change: what the next change is compared with (change history, 138)';

create table meta.component_change (
  id          bigint generated always as identity primary key,
  app_id      int not null references meta.app (id) on delete cascade,
  component   text not null check (length(component) <= 500),
  label       text not null,
  page_no     int,
  op          text not null check (op in ('added', 'changed', 'deleted')),
  before      jsonb,
  after       jsonb,
  changed_by  text,
  source      text not null default 'builder' check (source in ('builder', 'import', 'upgrade')),
  changed_at  timestamptz not null default now()
);
create index component_change_app_idx on meta.component_change (app_id, changed_at desc);
create index component_change_component_idx on meta.component_change (app_id, component, changed_at desc);
comment on table meta.component_change is
  'Change history per component (138): the component''s files before and after a change, who and when';

create table meta.ui_default (
  id           int generated always as identity primary key,
  schema_name  text not null check (schema_name ~ '^[^\s]{1,63}$'),
  table_name   text not null check (table_name ~ '^[^\s]{1,63}$'),
  column_name  text not null check (length(column_name) between 1 and 63),
  label        text check (length(label) <= 200),
  format_mask  text check (format_mask ~ '^[A-Za-z0-9GDLSCFM.,:/ \-]{1,60}$'),
  help         text check (length(help) <= 4000),
  alignment    text check (alignment in ('start', 'center', 'end')),
  lov          text check (length(lov) <= 4000),
  updated_by   text,
  updated_at   timestamptz not null default now(),
  unique (schema_name, table_name, column_name)
);
comment on table meta.ui_default is
  'UI defaults per table column (APEX: Attribute Dictionary, 138): label, format mask, help, alignment, list of values; used by the page wizards';

-- the UI default of a table's column, or null
create function meta.ui_default_of(p_table regclass, p_col text) returns meta.ui_default
language sql stable as $$
  select d.* from meta.ui_default d
    join pg_class c on c.oid = p_table join pg_namespace n on n.oid = c.relnamespace
   where d.schema_name = n.nspname and d.table_name = c.relname and d.column_name = p_col
$$;

-- (097) a column's label for the generators: (138) its UI default's label wins; a UI default also
-- tells meta.ui_default_item which column the next wizard item is for (a transaction-local setting)
create or replace function meta.wizard_column_label(p_table regclass, p_col text) returns text
language plpgsql stable as $$
declare
  v_ui      meta.ui_default := meta.ui_default_of(p_table, p_col);
  v_comment text;
  v_rel     text := lower((select relname from pg_class where oid = p_table));
  v_fk      boolean;
  v_pk      boolean;
  v_base    text := p_col;
  v_rest    text;
  l         text := lower(p_col);
begin
  if v_ui.id is not null then
    perform set_config('pgkiln.ui_default_col', p_table::oid::text || '.' || p_col, true);
    if nullif(btrim(v_ui.label), '') is not null then
      return btrim(v_ui.label);
    end if;
  end if;
  select meta.wizard_short(col_description(p_table, a.attnum), 60) into v_comment
    from pg_attribute a where a.attrelid = p_table and a.attname = p_col and not a.attisdropped;
  if v_comment is not null then
    return v_comment;
  end if;
  select c.fk_table is not null, c.is_pk into v_fk, v_pk from meta.wizard_catalog(p_table) c where c.column_name = p_col;
  if v_fk and not v_pk then
    v_rest := regexp_replace(p_col, '_?(id|no|num|nr|code|key|fk)$', '', 'i');
    if length(v_rest) >= 2 then
      v_base := v_rest;
    end if;
  elsif length(l) >= 4 and left(l, 1) = left(v_rel, 1) and not (meta.wizard_abbreviations() ? l) and not meta.wizard_is_word(l)
        and meta.wizard_is_word(substr(l, 2)) then
    -- a column named after the table's first letter: ename, dname
    v_base := substr(p_col, 2);
  end if;
  return meta.wizard_label(v_base);
end
$$;

-- a form item a wizard is inserting: the column's format mask, help text and list of values
create function meta.ui_default_item() returns trigger
language plpgsql as $$
declare
  v_mark  text := current_setting('pgkiln.ui_default_col', true);
  v_table regclass;
  v_ui    meta.ui_default;
begin
  if coalesce(v_mark, '') = '' or new.source_column is null or new.region_id is null then
    return new;
  end if;
  select to_regclass(r.table_name) into v_table from meta.region r where r.id = new.region_id and r.type = 'form';
  if v_table is null or v_mark <> v_table::oid::text || '.' || new.source_column then
    return new;
  end if;
  perform set_config('pgkiln.ui_default_col', '', true);
  v_ui := meta.ui_default_of(v_table, new.source_column);
  if v_ui.id is null or new.type in ('hidden', 'file') then
    return new;
  end if;
  if v_ui.format_mask is not null and new.type in ('number', 'date', 'datetime', 'display', 'text') then
    new.config := coalesce(new.config, '{}') || jsonb_build_object('format_mask', v_ui.format_mask);
  end if;
  if nullif(btrim(v_ui.help), '') is not null then
    new.help := btrim(v_ui.help);
  end if;
  if nullif(btrim(v_ui.lov), '') is not null and new.type in ('text', 'number', 'select') then
    new.type := 'select';
    new.lov := btrim(v_ui.lov);
  end if;
  return new;
end
$$;
create trigger item_ui_default before insert on meta.item for each row execute function meta.ui_default_item();

revoke all on function meta.ui_default_of(regclass, text), meta.ui_default_item() from public;
