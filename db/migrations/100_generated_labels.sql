-- =====================================================================
-- 100: generated reports and grids read the same (sprint 78; parity
-- handoff GEN-2, GEN-1, GEN-7)
--
-- - A faceted search page's report shows one column per foreign key: the
--   parent's display value (Manager → KING) under the key's label. The key
--   itself is hidden (config.hidden: not shown, not in Actions › Columns,
--   still in the query for filters and links). Before, both showed, so the
--   report had two "Manager" and two "Department" headings.
-- - Interactive grids (the grid page, both grids of a master-detail page)
--   get headings from meta.wizard_column_label (Deptno → Department Number)
--   and the number format masks of meta.wizard_mask, like the reports.
-- - The faceted search report and a map's list report get the format masks
--   too, so a salary reads 2,850.00 in the report, the grid and the form.
--
-- meta.generate_page is 097's with those changes. Pages generated before
-- keep their configuration.
-- =====================================================================

-- a grid's headings and number formats: {"headings": {...}, "formats": {...}}
create function meta.wizard_grid_labels(p_table regclass) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'headings', coalesce(jsonb_object_agg(column_name, meta.wizard_column_label(p_table, column_name)), '{}'),
    'formats', coalesce(jsonb_object_agg(column_name, meta.wizard_mask(type_sql, kind, is_pk or fk_table is not null))
                          filter (where meta.wizard_mask(type_sql, kind, is_pk or fk_table is not null) is not null), '{}'))
    from meta.wizard_catalog(p_table)
   where kind not in ('binary', 'geometry')
$$;

create or replace function meta.generate_page(
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
  v_flabel  text;
  v_icon    text;
  v_pk      text := meta.wizard_pk(p_table);
  v_page    int;
  v_region  int;
  v_report  int;
  v_form    int;
  v_fpage   int;
  v_link    jsonb;
  v_cols    text;
  v_heads   jsonb := '{}';
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
  v_hidden  jsonb := '[]';
  v_fmts    jsonb := '{}';
  v_mask    text;
  v_geo     text;
  v_key     text;
  v_skip    text[] := meta.wizard_sidecars(p_table);
  c         record;
begin
  select * into v_app from meta.app where alias = p_app;
  if v_app.id is null then
    raise exception 'application "%" does not exist', p_app;
  end if;
  if p_kind not in ('report_form', 'grid', 'form', 'cards', 'calendar', 'chart', 'map', 'facets', 'master_detail') then
    raise exception 'unknown page type "%"', p_kind;
  end if;
  -- the application's own data: not pgkiln's or the system's tables
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
  v_label := coalesce(nullif(btrim(o ->> 'label'), ''), meta.wizard_table_label(p_table, p_kind <> 'form'));
  -- (097) a form page of a listing is titled with the singular: Employees → Employee
  v_flabel := coalesce(nullif(btrim(o ->> 'form_label'), ''), meta.wizard_table_label(p_table, false));
  v_icon := nullif(o ->> 'icon', '');
  v_fpage := nullif(o ->> 'form_page', '')::int;
  if v_fpage = p_page then
    raise exception 'the form page needs a page number of its own';
  end if;

  if p_kind = 'report_form' then
    v_page := meta.wizard_report_form(v_app, p_table, p_page, v_fpage, v_label, v_flabel);
  elsif p_kind = 'grid' then
    perform meta.generate_grid(p_app, p_table, p_page, v_label, coalesce(v_icon, 'grid'));
    v_page := (select id from meta.page where app_id = v_app.id and page_no = p_page);
    -- (100) the grid's headings and number formats, like the report's
    update meta.region set config = config || meta.wizard_grid_labels(p_table) where page_id = v_page and type = 'grid';
    return v_page;
  elsif p_kind = 'form' then
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
    values (v_page, 10, meta.wizard_table_label(p_table), 'grid', 12,
            format(E'select %s\n  from %s', (select string_agg(quote_ident(column_name), ', ' order by ordinal)
                                              from meta.wizard_catalog(p_table) where kind <> 'binary' and not (column_name = any (v_skip))),
                   meta.wizard_qname(p_table)),
            meta.wizard_qname(p_table), v_pk,
            jsonb_build_object('page_size', 10, 'columns', meta.wizard_grid_columns(p_table),
                               'select_row', jsonb_build_object('column', v_pk, 'item', v_item))
            || meta.wizard_grid_labels(p_table))
    returning id into v_region;
    insert into meta.item (page_id, region_id, seq, name, label, type)
    values (v_page, v_region, 10, v_item, meta.wizard_column_label(p_table, v_pk), 'hidden');
    insert into meta.region (page_id, seq, title, type, columns, source, table_name, pk_column, config)
    values (v_page, 20, meta.wizard_table_label(v_detail), 'grid', 12,
            format(E'select %s\n  from %s\n where %I = :%s::%s',
                   (select string_agg(quote_ident(column_name), ', ' order by ordinal)
                      from meta.wizard_catalog(v_detail) where kind <> 'binary' and column_name <> v_a
                       and not (column_name = any (meta.wizard_sidecars(v_detail)))),
                   meta.wizard_qname(v_detail), v_a, v_item, (select type_sql from meta.wizard_catalog(p_table) where column_name = v_pk)),
            meta.wizard_qname(v_detail), v_dpk,
            jsonb_build_object('page_size', 10, 'columns', meta.wizard_grid_columns(v_detail, v_a),
                               'master', jsonb_build_object('item', v_item, 'column', v_a))
            || meta.wizard_grid_labels(v_detail))
    returning id into v_report;
    insert into meta.process (page_id, seq, name, type, region_id) values
      (v_page, 10, 'Save ' || meta.wizard_table_label(p_table), 'grid_dml', v_region),
      (v_page, 20, 'Save ' || meta.wizard_table_label(v_detail), 'grid_dml', v_report);
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
                       || ' of ' || meta.wizard_column_label(p_table, v_b) end;
      -- the label as a derived column, so a foreign key's display value can be grouped;
      -- (097) rows without a value are labelled "(none)" instead of an empty bar
      v_src := meta.wizard_expr(p_table, v_a);
      if exists (select 1 from meta.wizard_catalog(p_table) where column_name = v_a and (kind = 'text' or fk_table is not null) and not (not_null and fk_table is null)) then
        v_src := format('coalesce((%s)::text, %L)', v_src, '(none)');
      end if;
      insert into meta.region (page_id, seq, title, type, source, config)
      values (v_page, 10, v_label, 'chart',
              format(E'select t.%I,\n       %s as %I\n  from (select %s as %I%s from %s t) t\n group by 1\n order by %s',
                     meta.wizard_column_label(p_table, v_a),
                     case when v_b is null then 'count(*)' else format('%s(t.%I)', v_c, v_b) end, v_d,
                     v_src, meta.wizard_column_label(p_table, v_a),
                     case when v_b is null then '' else format(', t.%I', v_b) end,
                     meta.wizard_qname(p_table), case when v_kind in ('bar', 'donut', 'pie', 'funnel') then '2 desc' else '1' end),
              jsonb_build_object('kind', v_kind) || case when v_kind in ('bar', 'donut', 'pie', 'funnel') then '{"top": 10}'::jsonb else '{}' end)
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
                         where kind not in ('binary', 'geometry', 'point') and column_name not in ('lat', 'lng', 'location')
                           and not (column_name = any (v_skip))),
                       v_src, meta.wizard_qname(p_table)),
                jsonb_strip_nulls(jsonb_build_object('link', v_link || jsonb_build_object('column', v_pk),
                  'headings', (select jsonb_object_agg(column_name, meta.wizard_column_label(p_table, column_name)) from meta.wizard_catalog(p_table)),
                  'formats', nullif(meta.wizard_grid_labels(p_table) -> 'formats', '{}'))))
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
        if c.fk_display is not null and c.fk_display <> c.fk_column and not c.is_pk then
          -- (100) one column per foreign key: the parent's display value; the key itself is hidden (still filterable)
          v_cols := concat_ws(E',\n       ', v_cols, meta.wizard_expr(p_table, c.column_name) || ' as ' || quote_ident(c.column_name || '_' || c.fk_display));
          v_heads := v_heads || jsonb_build_object(c.column_name || '_' || c.fk_display, meta.wizard_column_label(p_table, c.column_name));
          v_hidden := v_hidden || to_jsonb(c.column_name);
        else
          v_heads := v_heads || jsonb_build_object(c.column_name, meta.wizard_column_label(p_table, c.column_name));
          v_mask := meta.wizard_mask(c.type_sql, c.kind, c.is_pk or c.fk_table is not null);
          if v_mask is not null then
            v_fmts := v_fmts || jsonb_build_object(c.column_name, v_mask);
          end if;
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
          'label', meta.wizard_column_label(p_table, c.column_name),
          'type', case when c.kind in ('number', 'date', 'timestamp') and c.fk_table is null then 'range' end,
          'custom', case when c.kind in ('number', 'date', 'timestamp') and c.fk_table is null then true end)));
      end loop;
      insert into meta.region (page_id, seq, title, type, columns, source, config)
      values (v_page, 20, v_label, 'report', 9, format(E'select %s\n  from %s t', v_cols, meta.wizard_qname(p_table)),
              jsonb_strip_nulls(jsonb_build_object('link', v_link || jsonb_build_object('column', v_pk), 'headings', v_heads,
                'hidden', nullif(v_hidden, '[]'), 'formats', nullif(v_fmts, '{}'))))
      returning id into v_region;
      insert into meta.region (page_id, seq, title, type, columns, template, config)
      values (v_page, 10, 'Filters', 'facets', 3, 'collapsible',
              jsonb_build_object('report', v_region, 'search', coalesce((o ->> 'search')::boolean, true), 'facets', v_facets));
    end if;

    if v_fpage is not null then
      perform meta.wizard_form(v_app, p_table, v_fpage, v_flabel, p_page, true, null);
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

revoke all on function meta.wizard_grid_labels(regclass) from public;
