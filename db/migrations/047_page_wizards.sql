-- =====================================================================
-- 047: create page wizards for more page types (APEX: Create Page →
-- Cards, Calendar, Chart, Map, Faceted Search, Form, Master Detail)
--
-- - meta.wizard_catalog(table): the columns of a table or view as the
--   wizards see them (kind, key, unique, foreign key and the parent's
--   display column, statistics).
-- - meta.wizard_defaults(kind, table): the options a wizard proposes for a
--   table, from the catalog (columns, primary key, date, number and
--   position columns, foreign keys for facets and master-detail).
-- - meta.generate_page(app, kind, table, page, options): creates the page
--   (and its navigation entry, and an optional modal form page), with the
--   defaults for every option that isn't given:
--
--     select meta.generate_page('myapp', 'calendar', 'app.meeting', 12);
--     select meta.generate_page('myapp', 'facets', 'app.product', 13,
--                               '{"facets": ["category", "price"], "form_page": 14}');
--
--   Kinds: form, cards, calendar, chart, map, facets, master_detail (and
--   report_form, grid: meta.generate_crud / meta.generate_grid).
--
-- Column names in the options must be columns of the table; they go into
-- the generated SQL as quoted identifiers. Every value is checked against
-- a fixed list. The functions are security invoker (the builder calls
-- them as the owner) and are not granted to anyone.
-- No changes to export/import: the pages are ordinary metadata.
-- =====================================================================

-- ---------------------------------------------------------------- catalog
create function meta.wizard_catalog(p_table regclass)
returns table (
  column_name text, ordinal int, kind text, type_sql text, not_null boolean, has_default boolean,
  generated boolean, is_pk boolean, is_unique boolean, fk_table regclass, fk_column text,
  fk_display text, distinct_values real
)
language sql stable as $$
  with pk as (
    select i.indkey[0] as attnum
      from pg_index i
     where i.indrelid = p_table and i.indisprimary and i.indnatts = 1
  ), cols as (
    select a.attnum, a.attname::text as attname, a.attnotnull, a.atthasdef or a.attidentity <> '' as hasdef,
           a.attgenerated <> '' or a.attidentity = 'a' as generated,
           format_type(a.atttypid, a.atttypmod) as type_sql,
           t.typname::text as typname,
           coalesce(bt.typcategory, t.typcategory) as cat,
           coalesce(bt.typname, t.typname)::text as basename
      from pg_attribute a
      join pg_type t on t.oid = a.atttypid
      left join pg_type bt on t.typtype = 'd' and bt.oid = t.typbasetype
     where a.attrelid = p_table and a.attnum > 0 and not a.attisdropped
  )
  select c.attname, c.attnum::int,
         case
           when c.typname in ('geometry', 'geography') or c.basename in ('geometry', 'geography') then 'geometry'
           when c.basename = 'point' then 'point'
           when c.cat = 'B' then 'boolean'
           when c.cat = 'N' then 'number'
           when c.basename = 'date' then 'date'
           when c.basename in ('timestamp', 'timestamptz') then 'timestamp'
           when c.cat = 'S' then 'text'
           when c.basename = 'bytea' then 'binary'
           else 'other'
         end,
         c.type_sql, c.attnotnull, c.hasdef, c.generated,
         exists (select 1 from pk where pk.attnum = c.attnum),
         exists (select 1 from pg_index i where i.indrelid = p_table and i.indisunique and i.indnatts = 1 and i.indkey[0] = c.attnum),
         fk.confrelid::regclass, fk.refcol, fk.display,
         (select case when s.n_distinct >= 0 then s.n_distinct
                      else -s.n_distinct * greatest((select reltuples from pg_class where oid = p_table), 0) end
            from pg_stats s join pg_class r on r.relname = s.tablename join pg_namespace n on n.oid = r.relnamespace and n.nspname = s.schemaname
           where r.oid = p_table and s.attname = c.attname limit 1)::real
    from cols c
    left join lateral (
      select con.confrelid,
             pa.attname::text as refcol,
             (select x.attname::text
                from pg_attribute x join pg_type xt on xt.oid = x.atttypid
               where x.attrelid = con.confrelid and x.attnum > 0 and not x.attisdropped and xt.typcategory = 'S'
               order by (x.attname in ('name', 'title', 'label') or x.attname like '%name%') desc, x.attnum
               limit 1) as display
        from pg_constraint con
        join pg_attribute pa on pa.attrelid = con.confrelid and pa.attnum = con.confkey[1]
       where con.conrelid = p_table and con.contype = 'f'
         and array_length(con.conkey, 1) = 1 and con.conkey[1] = c.attnum
       limit 1
    ) fk on true
   order by c.attnum
$$;

-- a table's name with its schema, for generated SQL (whatever the search path at run time)
create function meta.wizard_qname(p_table regclass) returns text
language sql stable as $$
  select format('%I.%I', n.nspname, c.relname) from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.oid = p_table
$$;

-- the single-column primary key of a table (null for views and composite keys)
create function meta.wizard_pk(p_table regclass) returns text
language sql stable as $$
  select column_name from meta.wizard_catalog(p_table) where is_pk
$$;

-- a column of the table named in an option (null when empty); anything else is refused
create function meta.wizard_col(p_table regclass, p_col text, p_what text) returns text
language plpgsql stable as $$
begin
  if p_col is null or p_col = '' then
    return null;
  end if;
  if not exists (select 1 from meta.wizard_catalog(p_table) where column_name = p_col) then
    raise exception '% "%" is not a column of %', p_what, p_col, p_table;
  end if;
  return p_col;
end
$$;

-- a column as SQL over "t": a foreign key shows the parent's display column
create function meta.wizard_expr(p_table regclass, p_col text) returns text
language sql stable as $$
  select case
           when c.fk_display is not null and c.fk_display <> c.fk_column
             then format('(select p.%I from %s p where p.%I = t.%I)', c.fk_display, meta.wizard_qname(c.fk_table), c.fk_column, c.column_name)
           else format('t.%I', c.column_name)
         end
    from meta.wizard_catalog(p_table) c where c.column_name = p_col
$$;

-- a label from a name: order_date → Order Date
create function meta.wizard_label(p_name text) returns text
language sql immutable as $$ select initcap(replace(p_name, '_', ' ')) $$;

-- an item name from a page and a column: P12_ORDER_DATE
create function meta.wizard_item(p_page int, p_col text) returns text
language sql immutable as $$ select format('P%s_%s', p_page, upper(regexp_replace(p_col, '[^A-Za-z0-9_]', '_', 'g'))) $$;

-- the column a row is best known by: a name, title or label, else the first text column
create function meta.wizard_display(p_table regclass) returns text
language sql stable as $$
  select column_name from meta.wizard_catalog(p_table)
   where kind = 'text' and not is_pk
   order by (column_name in ('name', 'title', 'label', 'subject') or column_name like '%name%' or column_name like '%title%') desc, ordinal
   limit 1
$$;

-- ---------------------------------------------------------------- defaults
create function meta.wizard_defaults(p_kind text, p_table regclass) returns jsonb
language plpgsql stable as $$
declare
  v_rel     text := (select relname from pg_class where oid = p_table);
  v_pk      text := meta.wizard_pk(p_table);
  v_display text := meta.wizard_display(p_table);
  v_fk      text;
  v_first   text;
  v_out     jsonb;
  v_start   text;
  v_detail  record;
begin
  -- the first foreign key column (not the key itself)
  select column_name into v_fk from meta.wizard_catalog(p_table)
   where fk_table is not null and not is_pk order by (fk_table = p_table), ordinal limit 1;
  v_out := jsonb_build_object('label', meta.wizard_label(v_rel), 'nav', p_kind <> 'form',
    'icon', case p_kind when 'form' then 'file' when 'cards' then 'layers' when 'calendar' then 'calendar'
                        when 'chart' then 'chart' when 'map' then 'map' when 'facets' then 'filter'
                        when 'grid' then 'grid' when 'master_detail' then 'grid' else 'table' end);
  case p_kind
  when 'report_form', 'grid' then
    null;
  when 'form' then
    v_out := v_out || jsonb_build_object('mode', 'normal', 'return_page', null,
      'columns', (select jsonb_agg(column_name order by ordinal) from meta.wizard_catalog(p_table) where not generated and kind <> 'binary'));
  when 'cards' then
    v_first := coalesce(v_display, v_pk);
    v_out := v_out || jsonb_build_object('title', v_first,
      'subtitle', coalesce(v_fk, (select column_name from meta.wizard_catalog(p_table)
                                   where kind = 'text' and not is_pk and column_name is distinct from v_first order by ordinal limit 1)),
      'body', (select column_name from meta.wizard_catalog(p_table)
                where kind = 'text' and not is_pk and fk_table is null and column_name is distinct from v_first
                  and column_name is distinct from v_fk
                  and column_name is distinct from (select column_name from meta.wizard_catalog(p_table)
                                                     where kind = 'text' and not is_pk and column_name is distinct from v_first order by ordinal limit 1)
                order by ordinal limit 1),
      'badge', null, 'form_page', null);
  when 'calendar' then
    select column_name into v_start from meta.wizard_catalog(p_table)
     where kind in ('date', 'timestamp')
     order by (column_name ~ '(start|begin|from|^date|_date$|_at$|_on$)') desc,
              (column_name ~ '(created|updated|modified|changed)') asc, ordinal
     limit 1;
    v_out := v_out || jsonb_build_object('start', v_start,
      'end', (select column_name from meta.wizard_catalog(p_table)
               where kind in ('date', 'timestamp') and column_name is distinct from v_start
                 and column_name ~ '(end|until|finish|stop|^to_|_to$)'
               order by ordinal limit 1),
      'title', coalesce((select column_name from meta.wizard_catalog(p_table)
                          where kind = 'text' and not is_pk and column_name ~ '(name|title|label|subject|summary)'
                          order by ordinal limit 1), v_fk, v_display, v_pk),
      'drag', false, 'form_page', null);
  when 'chart' then
    v_out := v_out || jsonb_build_object('chart', 'bar',
      'label_column', coalesce(v_fk,
        (select column_name from meta.wizard_catalog(p_table) where kind = 'text' and not is_pk and not is_unique order by ordinal limit 1),
        (select column_name from meta.wizard_catalog(p_table) where kind in ('text', 'boolean', 'date') and not is_pk order by ordinal limit 1),
        v_pk),
      'function', 'count', 'value_column', null);
  when 'map' then
    v_out := v_out || jsonb_build_object(
      'location', (select column_name from meta.wizard_catalog(p_table)
                    where kind in ('geometry', 'point') or (kind = 'text' and column_name like '%location%')
                    order by (kind = 'geometry') desc, (kind = 'point') desc, ordinal limit 1),
      'lat', (select column_name from meta.wizard_catalog(p_table)
               where kind = 'number' and column_name ~ '^(lat|latitude)$|_lat$|_latitude$|^lat_' order by ordinal limit 1),
      'lng', (select column_name from meta.wizard_catalog(p_table)
               where kind = 'number' and column_name ~ '^(lng|lon|long|longitude)$|_(lng|lon|long|longitude)$|^(lng|lon)_' order by ordinal limit 1),
      'title', coalesce(v_display, v_pk),
      'body', (select column_name from meta.wizard_catalog(p_table)
                where kind = 'text' and not is_pk and column_name is distinct from v_display
                  and column_name not like '%location%' order by ordinal limit 1),
      'report', true, 'form_page', null);
    -- a pair of coordinates wins over a text location
    if v_out ->> 'lat' is not null and v_out ->> 'lng' is not null
       and not exists (select 1 from meta.wizard_catalog(p_table) where column_name = v_out ->> 'location' and kind in ('geometry', 'point')) then
      v_out := v_out || '{"location": null}';
    end if;
  when 'facets' then
    v_out := v_out || jsonb_build_object('search', true, 'form_page', null,
      'columns', (select jsonb_agg(column_name order by ordinal) from meta.wizard_catalog(p_table) where kind not in ('binary', 'geometry')),
      'facets', coalesce((select jsonb_agg(column_name order by rank, ordinal) from (
          select column_name, ordinal,
                 case when fk_table is not null then 1 when kind = 'boolean' then 2 when kind = 'text' then 3
                      when kind in ('date', 'timestamp') then 4 else 5 end as rank
            from meta.wizard_catalog(p_table)
           where not is_pk and not is_unique and column_name is distinct from v_display
             and (fk_table is not null
                  or kind = 'boolean'
                  -- text with few values (statistics), or, without statistics, not a free text by its name
                  or (kind = 'text' and (distinct_values between 1 and 50
                                         or (distinct_values is null and column_name !~ '(note|descr|comment|remark|body|text|address|mail|url|phone|summary|password|hash|token)')))
                  or kind in ('date', 'timestamp')
                  or (kind = 'number' and column_name !~ '(^|_)(id|no|lat|lng|lon|latitude|longitude)$'))
           order by rank, ordinal limit 6) f), '[]'));
  when 'master_detail' then
    -- the first table with a foreign key to this table's key
    select con.conrelid::regclass as detail, a.attname::text as col into v_detail
      from pg_constraint con
      join pg_attribute a on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
     where con.confrelid = p_table and con.contype = 'f' and con.conrelid <> p_table
       and array_length(con.conkey, 1) = 1
       and con.confkey[1] = (select ordinal from meta.wizard_catalog(p_table) where is_pk)
     order by con.conrelid::regclass::text, con.conname
     limit 1;
    v_out := v_out || jsonb_build_object('detail', meta.wizard_qname(v_detail.detail), 'detail_column', v_detail.col,
      'label', meta.wizard_label(v_rel) || coalesce(' and ' || meta.wizard_label((select relname from pg_class where oid = v_detail.detail)), ''));
  else
    raise exception 'unknown page type "%"', p_kind;
  end case;
  return v_out;
end
$$;

-- ---------------------------------------------------------------- helpers
create function meta.wizard_new_page(p_app meta.app, p_page int, p_name text, p_parent int, p_mode text default 'normal')
returns int
language plpgsql as $$
declare
  v_id int;
begin
  if p_page is null or p_page < 1 then
    raise exception 'a page number must be a positive whole number';
  end if;
  if exists (select 1 from meta.page where app_id = p_app.id and page_no = p_page) then
    raise exception 'page % already exists', p_page;
  end if;
  insert into meta.page (app_id, page_no, name, title, parent_page, mode)
  values (p_app.id, p_page, p_name, p_name, nullif(p_parent, p_page), p_mode)
  returning id into v_id;
  return v_id;
end
$$;

create function meta.wizard_nav(p_app meta.app, p_label text, p_icon text, p_page int) returns void
language sql as $$
  insert into meta.nav_entry (app_id, seq, label, icon, target_page)
  values (p_app.id, (select coalesce(max(seq), 0) + 10 from meta.nav_entry where app_id = p_app.id and parent_id is null),
          p_label, nullif(p_icon, ''), p_page)
$$;

-- grid column settings: foreign keys as select lists, required columns
create function meta.wizard_grid_columns(p_table regclass, p_skip text default null) returns jsonb
language sql stable as $$
  select coalesce(jsonb_object_agg(column_name, cfg), '{}')
    from (
      select column_name,
             case when fk_table is not null and column_name is distinct from p_skip
                  then jsonb_build_object('lov', format('select %I, %I from %s order by 1', coalesce(fk_display, fk_column), fk_column, meta.wizard_qname(fk_table)))
                  else '{}'::jsonb end
             || case when not_null and not has_default and not is_pk and column_name is distinct from p_skip
                     then '{"required": true}'::jsonb else '{}'::jsonb end as cfg
        from meta.wizard_catalog(p_table)
       where not is_pk and not generated and kind <> 'binary'
    ) x
   where cfg <> '{}'::jsonb
$$;

-- a form page for one row of a table (the form of "report and form", or the form only page)
create function meta.wizard_form(
  p_app meta.app, p_table regclass, p_page int, p_label text, p_return int, p_modal boolean, p_columns text[] default null
) returns int
language plpgsql as $$
declare
  v_pk      text := meta.wizard_pk(p_table);
  v_pk_item text;
  v_page    int;
  v_region  int;
  v_seq     int := 10;
  v_type    text;
  v_lov     text;
  c         record;
begin
  if v_pk is null then
    raise exception 'a form needs a table with a single-column primary key (% has none)', p_table;
  end if;
  v_pk_item := meta.wizard_item(p_page, v_pk);
  v_page := meta.wizard_new_page(p_app, p_page, case when p_modal then p_label || ' Form' else p_label end,
                                 coalesce(p_return, p_app.home_page), case when p_modal then 'modal' else 'normal' end);
  insert into meta.region (page_id, seq, title, type, table_name, pk_column, pk_item, template)
  values (v_page, 10, p_label, 'form', meta.wizard_qname(p_table), v_pk, v_pk_item, case when p_modal then 'plain' else 'standard' end)
  returning id into v_region;

  for c in select * from meta.wizard_catalog(p_table) order by ordinal loop
    continue when c.generated and not c.is_pk;
    -- left out by the developer, unless the row can't be saved without it
    continue when p_columns is not null and not c.is_pk and not (c.column_name = any (p_columns))
              and not (c.not_null and not c.has_default);
    continue when c.kind = 'binary';
    v_lov := null;
    v_type := case
      when c.is_pk                   then 'hidden'
      when c.fk_table is not null    then 'select'
      when c.kind = 'number'         then 'number'
      when c.kind = 'date'           then 'date'
      when c.kind = 'timestamp'      then 'datetime'
      when c.kind = 'boolean'        then 'switch'
      when c.kind = 'point'          then 'text'
      else 'text'
    end;
    if v_type = 'select' then
      v_lov := format('select %I as d, %I as r from %s order by 1', coalesce(c.fk_display, c.fk_column), c.fk_column, meta.wizard_qname(c.fk_table));
    end if;
    insert into meta.item (page_id, region_id, seq, name, label, type, lov, source_column, required)
    values (v_page, v_region, v_seq, meta.wizard_item(p_page, c.column_name), meta.wizard_label(c.column_name),
            v_type, v_lov, c.column_name, c.not_null and not c.has_default and not c.is_pk and v_type <> 'switch');
    v_seq := v_seq + 10;
  end loop;

  insert into meta.button (page_id, region_id, seq, name, label, action, target_page, condition, hot, confirm) values
    (v_page, v_region, 10, 'CANCEL', 'Cancel', 'redirect', coalesce(p_return, p_app.home_page, p_page), null, false, null),
    (v_page, v_region, 20, 'DELETE', 'Delete', 'submit', coalesce(p_return, p_app.home_page, p_page),
       format(':%s is not null', v_pk_item), false, 'Delete this record?'),
    (v_page, v_region, 30, 'SAVE', 'Apply Changes', 'submit', coalesce(p_return, p_app.home_page, p_page),
       format(':%s is not null', v_pk_item), true, null),
    (v_page, v_region, 40, 'CREATE', 'Create', 'submit', coalesce(p_return, p_app.home_page, p_page),
       format(':%s is null', v_pk_item), true, null);
  insert into meta.process (page_id, seq, name, type, region_id)
  values (v_page, 10, 'Process form ' || p_label, 'form_dml', v_region);
  return v_page;
end
$$;

-- ---------------------------------------------------------------- generator
create function meta.generate_page(
  p_app     text,
  p_kind    text,
  p_table   regclass,
  p_page    int,
  p_options jsonb default '{}'
) returns int
language plpgsql as $$
declare
  v_app     meta.app;
  o         jsonb;
  v_label   text;
  v_icon    text;
  v_pk      text := meta.wizard_pk(p_table);
  v_page    int;
  v_region  int;
  v_report  int;
  v_form    int;
  v_fpage   int;
  v_link    jsonb;
  v_cols    text;
  v_src     text;
  v_cfg     jsonb;
  v_a       text;
  v_b       text;
  v_c       text;
  v_d       text;
  v_kind    text;
  v_detail  regclass;
  v_dpk     text;
  v_item    text;
  v_facets  jsonb := '[]';
  v_geo     text;
  v_key     text;
  c         record;
begin
  select * into v_app from meta.app where alias = p_app;
  if v_app.id is null then
    raise exception 'application "%" does not exist', p_app;
  end if;
  if p_kind not in ('report_form', 'grid', 'form', 'cards', 'calendar', 'chart', 'map', 'facets', 'master_detail') then
    raise exception 'unknown page type "%"', p_kind;
  end if;
  -- the application's own data: not pgapex's or the system's tables
  if (select n.nspname ~ '^pg_' or n.nspname in ('information_schema', 'meta')
        from pg_class rel join pg_namespace n on n.oid = rel.relnamespace where rel.oid = p_table) then
    raise exception 'pages can''t be generated on %', p_table;
  end if;
  if (select relkind from pg_class where oid = p_table) not in ('r', 'p', 'v', 'm') then
    raise exception '% is not a table or view', p_table;
  end if;
  if p_options is null or jsonb_typeof(p_options) <> 'object' then
    p_options := '{}';
  end if;
  -- an option given as JSON null or '' means "none"; a missing one takes the default
  o := meta.wizard_defaults(p_kind, p_table) || p_options;
  v_label := coalesce(nullif(btrim(o ->> 'label'), ''), meta.wizard_label((select relname from pg_class where oid = p_table)));
  v_icon := nullif(o ->> 'icon', '');
  v_fpage := nullif(o ->> 'form_page', '')::int;
  if v_fpage = p_page then
    raise exception 'the form page needs a page number of its own';
  end if;

  if p_kind = 'report_form' then
    perform meta.generate_crud(p_app, p_table, p_page, v_fpage, v_label, coalesce(v_icon, 'table'));
    return (select id from meta.page where app_id = v_app.id and page_no = p_page);
  elsif p_kind = 'grid' then
    perform meta.generate_grid(p_app, p_table, p_page, v_label, coalesce(v_icon, 'grid'));
    return (select id from meta.page where app_id = v_app.id and page_no = p_page);
  end if;

  if p_kind = 'form' then
    v_page := meta.wizard_form(v_app, p_table, p_page, v_label, nullif(o ->> 'return_page', '')::int, o ->> 'mode' = 'modal',
      case when jsonb_typeof(o -> 'columns') = 'array'
           then (select array_agg(meta.wizard_col(p_table, x, 'form column')) from jsonb_array_elements_text(o -> 'columns') x) end);
  elsif p_kind = 'master_detail' then
    if v_pk is null then
      raise exception 'the master table % needs a single-column primary key', p_table;
    end if;
    if nullif(o ->> 'detail', '') is null then
      raise exception 'no detail table: % has no table with a foreign key to it', p_table;
    end if;
    v_detail := (o ->> 'detail')::regclass;
    v_dpk := meta.wizard_pk(v_detail);
    if v_dpk is null then
      raise exception 'the detail table % needs a single-column primary key', v_detail;
    end if;
    v_a := meta.wizard_col(v_detail, o ->> 'detail_column', 'detail column');
    if v_a is null then
      raise exception 'choose the detail column that refers to the master row';
    end if;
    v_item := meta.wizard_item(p_page, v_pk);
    v_page := meta.wizard_new_page(v_app, p_page, v_label, v_app.home_page);
    insert into meta.region (page_id, seq, title, type, columns, source, table_name, pk_column, config)
    values (v_page, 10, meta.wizard_label((select relname from pg_class where oid = p_table)), 'grid', 12,
            format(E'select %s\n  from %s', (select string_agg(quote_ident(column_name), ', ' order by ordinal)
                                              from meta.wizard_catalog(p_table) where kind <> 'binary'), meta.wizard_qname(p_table)),
            meta.wizard_qname(p_table), v_pk,
            jsonb_build_object('page_size', 10, 'columns', meta.wizard_grid_columns(p_table),
                               'select_row', jsonb_build_object('column', v_pk, 'item', v_item)))
    returning id into v_region;
    insert into meta.item (page_id, region_id, seq, name, label, type)
    values (v_page, v_region, 10, v_item, meta.wizard_label(v_pk), 'hidden');
    insert into meta.region (page_id, seq, title, type, columns, source, table_name, pk_column, config)
    values (v_page, 20, meta.wizard_label((select relname from pg_class where oid = v_detail)), 'grid', 12,
            format(E'select %s\n  from %s\n where %I = :%s::%s',
                   (select string_agg(quote_ident(column_name), ', ' order by ordinal)
                      from meta.wizard_catalog(v_detail) where kind <> 'binary' and column_name <> v_a),
                   meta.wizard_qname(v_detail), v_a, v_item, (select type_sql from meta.wizard_catalog(p_table) where column_name = v_pk)),
            meta.wizard_qname(v_detail), v_dpk,
            jsonb_build_object('page_size', 10, 'columns', meta.wizard_grid_columns(v_detail, v_a),
                               'master', jsonb_build_object('item', v_item, 'column', v_a)))
    returning id into v_report;
    insert into meta.process (page_id, seq, name, type, region_id) values
      (v_page, 10, 'Save ' || meta.wizard_label((select relname from pg_class where oid = p_table)), 'grid_dml', v_region),
      (v_page, 20, 'Save ' || meta.wizard_label((select relname from pg_class where oid = v_detail)), 'grid_dml', v_report);
  else
    -- the listing kinds, with an optional modal form page for a row
    if v_fpage is not null and v_pk is null then
      raise exception 'a form page needs a table with a single-column primary key (% has none)', p_table;
    end if;
    v_page := meta.wizard_new_page(v_app, p_page, v_label, v_app.home_page);
    v_key := case when v_pk is not null then format('t.%I', v_pk) end;
    if v_fpage is not null then
      v_link := jsonb_build_object('page', v_fpage, 'items', jsonb_build_object(meta.wizard_item(v_fpage, v_pk), '#' || v_pk || '#'));
    end if;

    if p_kind = 'cards' then
      v_a := meta.wizard_col(p_table, o ->> 'title', 'title column');
      v_b := meta.wizard_col(p_table, o ->> 'subtitle', 'subtitle column');
      v_c := meta.wizard_col(p_table, o ->> 'body', 'body column');
      v_d := meta.wizard_col(p_table, o ->> 'badge', 'badge column');
      if v_a is null then
        raise exception 'choose the column for the card titles';
      end if;
      v_src := concat_ws(E',\n       ',
        meta.wizard_expr(p_table, v_a) || ' as title',
        meta.wizard_expr(p_table, v_b) || ' as subtitle',
        meta.wizard_expr(p_table, v_c) || ' as body',
        meta.wizard_expr(p_table, v_d) || ' as badge',
        v_key);
      insert into meta.region (page_id, seq, title, type, source, config)
      values (v_page, 10, v_label, 'cards', format(E'select %s\n  from %s t\n order by 1', v_src, meta.wizard_qname(p_table)),
              jsonb_strip_nulls(jsonb_build_object('link', v_link)))
      returning id into v_region;

    elsif p_kind = 'calendar' then
      v_a := meta.wizard_col(p_table, o ->> 'start', 'start column');
      v_b := meta.wizard_col(p_table, o ->> 'end', 'end column');
      v_c := meta.wizard_col(p_table, o ->> 'title', 'title column');
      if v_a is null or (select kind from meta.wizard_catalog(p_table) where column_name = v_a) not in ('date', 'timestamp') then
        raise exception 'a calendar needs a date or timestamp start column';
      end if;
      if v_b is not null and (select kind from meta.wizard_catalog(p_table) where column_name = v_b) not in ('date', 'timestamp') then
        raise exception 'the end column must be a date or timestamp';
      end if;
      v_src := concat_ws(E',\n       ',
        format('t.%I as start_date', v_a),
        case when v_b is not null then format('t.%I as end_date', v_b) end,
        coalesce(meta.wizard_expr(p_table, v_c), quote_literal(v_label)) || ' as title',
        v_key);
      v_cfg := jsonb_strip_nulls(jsonb_build_object('link', v_link, 'key', v_pk));
      if v_fpage is not null then
        v_cfg := v_cfg || jsonb_build_object('create', jsonb_build_object('page', v_fpage, 'items',
          jsonb_strip_nulls(jsonb_build_object(meta.wizard_item(v_fpage, v_a), '#start#')
            || case when v_b is not null then jsonb_build_object(meta.wizard_item(v_fpage, v_b), '#end#') else '{}' end)));
      end if;
      if coalesce((o ->> 'drag')::boolean, false) then
        if v_pk is null then
          raise exception 'drag and drop needs a table with a single-column primary key (% has none)', p_table;
        end if;
        v_cfg := v_cfg || jsonb_build_object('move', format('update %s set %I = :NEW_START::%s%s where %I = :EVENT_ID::%s',
          meta.wizard_qname(p_table), v_a, (select type_sql from meta.wizard_catalog(p_table) where column_name = v_a),
          case when v_b is not null then format(', %I = :NEW_END::%s', v_b, (select type_sql from meta.wizard_catalog(p_table) where column_name = v_b)) else '' end,
          v_pk, (select type_sql from meta.wizard_catalog(p_table) where column_name = v_pk)));
      end if;
      insert into meta.region (page_id, seq, title, type, source, config)
      values (v_page, 10, v_label, 'calendar', format(E'select %s\n  from %s t', v_src, meta.wizard_qname(p_table)), v_cfg)
      returning id into v_region;

    elsif p_kind = 'chart' then
      v_a := meta.wizard_col(p_table, o ->> 'label_column', 'label column');
      v_b := meta.wizard_col(p_table, o ->> 'value_column', 'value column');
      v_kind := coalesce(nullif(o ->> 'chart', ''), 'bar');
      v_c := lower(coalesce(nullif(o ->> 'function', ''), 'count'));
      if v_a is null then
        raise exception 'choose the label column of the chart';
      end if;
      if v_kind not in ('bar', 'column', 'line', 'area', 'donut', 'pie', 'funnel') then
        raise exception 'unknown chart type "%"', v_kind;
      end if;
      if v_c not in ('count', 'sum', 'avg', 'min', 'max') then
        raise exception 'unknown function "%"', v_c;
      end if;
      if v_c <> 'count' and (v_b is null or (select kind from meta.wizard_catalog(p_table) where column_name = v_b) <> 'number') then
        raise exception 'the function % needs a number column', v_c;
      end if;
      v_d := case when v_c = 'count' and v_b is null then 'Count'
                  else initcap(case v_c when 'avg' then 'average' when 'min' then 'minimum' when 'max' then 'maximum' else v_c end)
                       || ' of ' || meta.wizard_label(v_b) end;
      -- the label as a derived column, so a foreign key's display value can be grouped
      insert into meta.region (page_id, seq, title, type, source, config)
      values (v_page, 10, v_label, 'chart',
              format(E'select t.%I,\n       %s as %I\n  from (select %s as %I%s from %s t) t\n group by 1\n order by %s',
                     meta.wizard_label(v_a),
                     case when v_b is null then 'count(*)' else format('%s(t.%I)', v_c, v_b) end, v_d,
                     meta.wizard_expr(p_table, v_a), meta.wizard_label(v_a),
                     case when v_b is null then '' else format(', t.%I', v_b) end,
                     meta.wizard_qname(p_table), case when v_kind in ('bar', 'donut', 'pie', 'funnel') then '2 desc' else '1' end),
              jsonb_build_object('kind', v_kind))
      returning id into v_region;

    elsif p_kind = 'map' then
      v_a := meta.wizard_col(p_table, o ->> 'lat', 'latitude column');
      v_b := meta.wizard_col(p_table, o ->> 'lng', 'longitude column');
      v_c := meta.wizard_col(p_table, o ->> 'location', 'location column');
      if v_c is not null then
        v_kind := (select kind from meta.wizard_catalog(p_table) where column_name = v_c);
        v_src := case v_kind
          when 'geometry' then format('st_y(st_pointonsurface(t.%1$I::geometry)) as lat, st_x(st_pointonsurface(t.%1$I::geometry)) as lng', v_c)
          when 'point' then format('t.%1$I[1] as lat, t.%1$I[0] as lng', v_c)
          when 'text' then format('t.%I as location', v_c)
          else null end;
        -- lines and areas are drawn as shapes too
        if v_kind = 'geometry' then
          v_geo := format('case when geometrytype(t.%1$I::geometry) <> ''POINT'' then st_asgeojson(t.%1$I::geometry) end as geojson', v_c);
        end if;
        if v_src is null then
          raise exception 'the location column must hold "latitude,longitude" text, a point or a PostGIS geometry';
        end if;
        v_d := format('t.%I is not null', v_c);
      elsif v_a is not null and v_b is not null then
        if (select count(*) from meta.wizard_catalog(p_table) where column_name in (v_a, v_b) and kind = 'number') <> 2 then
          raise exception 'latitude and longitude must be number columns';
        end if;
        v_src := format('t.%I as lat, t.%I as lng', v_a, v_b);
        v_d := format('t.%I is not null and t.%I is not null', v_a, v_b);
      else
        raise exception 'a map needs latitude and longitude columns, or a location, point or geometry column';
      end if;
      v_cols := concat_ws(E',\n       ', v_src, v_geo,
        meta.wizard_expr(p_table, meta.wizard_col(p_table, o ->> 'title', 'title column')) || ' as title',
        meta.wizard_expr(p_table, meta.wizard_col(p_table, o ->> 'body', 'body column')) || ' as body',
        v_key);
      insert into meta.region (page_id, seq, title, type, source, config)
      values (v_page, 10, v_label, 'map', format(E'select %s\n  from %s t\n where %s', v_cols, meta.wizard_qname(p_table), v_d),
              jsonb_strip_nulls(jsonb_build_object('link', v_link)))
      returning id into v_region;
      if coalesce((o ->> 'report')::boolean, true) then
        -- a report of the same rows, filtered by the map area ("Show this area in the list")
        insert into meta.region (page_id, seq, title, type, source, config)
        values (v_page, 20, v_label || ' list', 'report',
                format(E'select %s,\n       %s\n  from %s t',
                       (select string_agg(meta.wizard_expr(p_table, column_name) || ' as ' || quote_ident(column_name), ', ' order by ordinal)
                          from meta.wizard_catalog(p_table)
                         where kind not in ('binary', 'geometry', 'point') and column_name not in ('lat', 'lng', 'location')),
                       v_src, meta.wizard_qname(p_table)),
                jsonb_strip_nulls(jsonb_build_object('link', v_link || jsonb_build_object('column', v_pk))))
        returning id into v_report;
        update meta.region set config = config || jsonb_build_object('report', v_report) where id = v_region;
      end if;

    elsif p_kind = 'facets' then
      perform meta.wizard_col(p_table, x, 'report column') from jsonb_array_elements_text(coalesce(o -> 'columns', '[]')) x;
      perform meta.wizard_col(p_table, x, 'facet column') from jsonb_array_elements_text(coalesce(o -> 'facets', '[]')) x;
      -- the report: the chosen columns, and the parent's display column next to each foreign key
      v_cols := null;
      for c in
        select w.* from meta.wizard_catalog(p_table) w
         where w.column_name in (select x from jsonb_array_elements_text(coalesce(o -> 'columns', '[]')) x)
            or w.is_pk
            or w.column_name in (select x from jsonb_array_elements_text(coalesce(o -> 'facets', '[]')) x)
         order by w.ordinal
      loop
        continue when c.kind in ('binary', 'geometry');
        v_cols := concat_ws(E',\n       ', v_cols, format('t.%I', c.column_name));
        if c.fk_display is not null and c.fk_display <> c.fk_column then
          v_cols := concat_ws(E',\n       ', v_cols, meta.wizard_expr(p_table, c.column_name) || ' as ' || quote_ident(c.column_name || '_' || c.fk_display));
        end if;
      end loop;
      if v_cols is null then
        raise exception 'choose at least one report column';
      end if;
      for c in
        select w.* from jsonb_array_elements_text(coalesce(o -> 'facets', '[]')) with ordinality x(col, n)
          join meta.wizard_catalog(p_table) w on w.column_name = x.col
         order by x.n
      loop
        continue when c.kind in ('binary', 'geometry', 'point', 'other');
        v_facets := v_facets || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
          'column', case when c.fk_display is not null and c.fk_display <> c.fk_column then c.column_name || '_' || c.fk_display else c.column_name end,
          'label', meta.wizard_label(regexp_replace(c.column_name, '_(id|no)$', '')),
          'type', case when c.kind in ('number', 'date', 'timestamp') and c.fk_table is null then 'range' end,
          'custom', case when c.kind in ('number', 'date', 'timestamp') and c.fk_table is null then true end)));
      end loop;
      insert into meta.region (page_id, seq, title, type, columns, source, config)
      values (v_page, 20, v_label, 'report', 9, format(E'select %s\n  from %s t', v_cols, meta.wizard_qname(p_table)),
              jsonb_strip_nulls(jsonb_build_object('link', v_link || jsonb_build_object('column', v_pk))))
      returning id into v_region;
      insert into meta.region (page_id, seq, title, type, columns, template, config)
      values (v_page, 10, 'Filters', 'facets', 3, 'collapsible',
              jsonb_build_object('report', v_region, 'search', coalesce((o ->> 'search')::boolean, true), 'facets', v_facets));
    end if;

    if v_fpage is not null then
      perform meta.wizard_form(v_app, p_table, v_fpage, v_label, p_page, true, null);
      insert into meta.button (page_id, region_id, seq, name, label, action, target_page, hot)
      values (v_page, v_region, 10, 'CREATE', 'Create', 'redirect', v_fpage, true);
    end if;
  end if;

  if coalesce((o ->> 'nav')::boolean, false) then
    perform meta.wizard_nav(v_app, v_label, v_icon, p_page);
  end if;
  return v_page;
end
$$;

revoke all on function meta.wizard_catalog(regclass), meta.wizard_qname(regclass), meta.wizard_pk(regclass), meta.wizard_col(regclass, text, text),
  meta.wizard_expr(regclass, text), meta.wizard_display(regclass), meta.wizard_defaults(text, regclass),
  meta.wizard_new_page(meta.app, int, text, int, text), meta.wizard_nav(meta.app, text, text, int),
  meta.wizard_grid_columns(regclass, text), meta.wizard_form(meta.app, regclass, int, text, int, boolean, text[]),
  meta.generate_page(text, text, regclass, int, jsonb)
  from public;
