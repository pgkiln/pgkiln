-- =====================================================================
-- 137: Create Page like APEX's (sprint 137, parity card AP-3)
--
-- 1. More page types in meta.generate_page (the Create Page grid's
--    Component tab; APEX: Create a Page → Component):
--    - on a table or view: report (an interactive report alone), smart_filters
--      (a report with smart filters above it), tree (id / parent / label, the
--      parent proposed from a self-referencing foreign key), timeline,
--      media_list, content_row, comments (the built-in template components
--      ut_timeline, ut_media_list, ut_content_row, ut_comments), data_load (a
--      data load definition and a page with a file item, a Load button and a
--      data_load process) and wizard (a page per step with a wizard progress
--      list, Previous / Next and an INSERT on Finish);
--    - without a table: search (a search region over chosen search
--      configurations, or a new configuration on a table), tasks (a unified
--      task list) and workflows (the workflow console).
--    The page types of 047–100 are unchanged: the new meta.generate_page hands
--    them to the former definition, renamed meta.generate_page_100;
--    meta.wizard_defaults likewise (meta.wizard_defaults_097). A dashboard is
--    made by the builder (it reads the data to choose its charts).
--
-- 2. Configuration options (the Configuration Options feature): build options
--    marked configurable (meta.build_option.configurable, exported with the
--    application) can be switched by the application's administrators at
--    run time: meta.configurable_options() and
--    meta.set_configurable_options(names), security definer, only as the
--    application's own role, for a user with the admin role, and only for
--    configurable options.
--
-- 3. E-mail reporting (the Email Reporting feature):
--    meta.send_activity_report(to, days) queues a summary of the current
--    application's activity with the rows as a CSV attachment; for the
--    application's automations and its administrators.
--
-- 4. Create page as copy: meta.page_shared_refs(page id, target app) lists the
--    shared components a page refers to by name; meta.copy_page(...) copies a
--    page (regions, items, buttons, dynamic actions, validations, processes,
--    computations, branches) into the same or another application under a new
--    number, renaming P<old>_ items to P<new>_, with the shared components
--    mapped to the target's or copied. Owner only (the builder checks the
--    developer's workspaces).
-- =====================================================================

-- ---------------------------------------------------------------- 1. page types
alter function meta.generate_page(text, text, regclass, int, jsonb) rename to generate_page_100;
alter function meta.wizard_defaults(text, regclass) rename to wizard_defaults_097;

-- the application's own data: not pgkiln's or the system's tables (as 047's generator checks)
create function meta.wizard_check_table(p_table regclass) returns void
language plpgsql stable as $$
begin
  if p_table is null then
    raise exception 'choose a table or view';
  end if;
  if (select n.nspname ~ '^pg_' or n.nspname in ('information_schema', 'meta')
        from pg_class rel join pg_namespace n on n.oid = rel.relnamespace where rel.oid = p_table) then
    raise exception 'pages can''t be generated on %', p_table;
  end if;
  if (select relkind from pg_class where oid = p_table) not in ('r', 'p', 'v', 'm') then
    raise exception '% is not a table or view', p_table;
  end if;
end
$$;

create function meta.wizard_defaults(p_kind text, p_table regclass) returns jsonb
language plpgsql stable as $$
declare
  v_pk      text;
  v_display text;
  v_skip    text[];
  v_fk      text;
  v_date    text;
  v_text    text;
  v_n       int;
  v_out     jsonb;
begin
  if p_kind in ('report_form', 'grid', 'form', 'cards', 'calendar', 'chart', 'map', 'facets', 'master_detail') then
    return meta.wizard_defaults_097(p_kind, p_table);
  end if;
  if p_kind in ('search', 'tasks', 'workflows', 'dashboard') then
    v_out := jsonb_build_object('nav', true,
      'label', case p_kind when 'search' then 'Search' when 'tasks' then 'My Tasks' when 'workflows' then 'Workflows' else 'Dashboard' end,
      'icon', case p_kind when 'search' then 'search' when 'tasks' then 'list-checks' when 'workflows' then 'workflow' else 'chart' end);
    return v_out || case p_kind
      when 'search' then jsonb_build_object('configs', '[]'::jsonb, 'form_page', null)
      when 'tasks' then jsonb_build_object('context', 'my', 'completed', false)
      when 'workflows' then jsonb_build_object('context', 'initiator')
      else '{}'::jsonb end;
  end if;
  if p_kind not in ('report', 'smart_filters', 'tree', 'timeline', 'media_list', 'content_row', 'comments', 'data_load', 'wizard') then
    raise exception 'unknown page type "%"', p_kind;
  end if;
  perform meta.wizard_check_table(p_table);
  v_pk := meta.wizard_pk(p_table);
  v_display := meta.wizard_display(p_table);
  v_skip := meta.wizard_sidecars(p_table);
  -- the first foreign key to another table
  select column_name into v_fk from meta.wizard_catalog(p_table)
   where fk_table is not null and not is_pk and fk_table <> p_table order by ordinal limit 1;
  -- a date: one named like a date or a time of an event first
  select column_name into v_date from meta.wizard_catalog(p_table)
   where kind in ('date', 'timestamp') and not (column_name = any (v_skip))
   order by (column_name ~ '(date|_at$|_on$|when|time|created|posted)') desc, ordinal limit 1;
  -- a longer text: a comment, body, note or description first
  select column_name into v_text from meta.wizard_catalog(p_table)
   where kind = 'text' and not is_pk and fk_table is null and column_name is distinct from v_display and not (column_name = any (v_skip))
   order by (column_name ~ '(comment|body|text|note|descr|summary|message|remark|detail)') desc, ordinal limit 1;

  v_out := jsonb_build_object('nav', p_kind <> 'wizard',
    'label', case p_kind
               when 'wizard' then 'Create ' || meta.wizard_table_label(p_table, false)
               when 'data_load' then 'Load ' || meta.wizard_table_label(p_table)
               else meta.wizard_table_label(p_table) end,
    'icon', case p_kind when 'smart_filters' then 'filter' when 'tree' then 'git-branch' when 'timeline' then 'clock'
                        when 'media_list' then 'image' when 'content_row' then 'layout-list' when 'comments' then 'message-square'
                        when 'data_load' then 'upload' when 'wizard' then 'file' else 'table' end);
  case p_kind
  when 'report' then
    v_out := v_out || jsonb_build_object('form_page', null);
  when 'smart_filters' then
    v_out := v_out || jsonb_build_object('form_page', null, 'facets', coalesce(meta.wizard_defaults_097('facets', p_table) -> 'facets', '[]'));
  when 'tree' then
    v_out := v_out || jsonb_build_object('form_page', null, 'expanded', 1,
      'id_column', v_pk,
      -- the parent: a column with a foreign key to the table itself (mgr → empno)
      'parent_column', (select column_name from meta.wizard_catalog(p_table) where fk_table = p_table and not is_pk order by ordinal limit 1),
      'label_column', coalesce(v_display, v_pk));
  when 'timeline' then
    v_out := v_out || jsonb_build_object('form_page', null, 'title', coalesce(v_display, v_pk), 'when', v_date,
      'who', coalesce((select column_name from meta.wizard_catalog(p_table)
                        where kind = 'text' and column_name ~ '(user|author|by$|owner|who|person)' and not (column_name = any (v_skip))
                        order by ordinal limit 1), v_fk),
      'body', v_text);
  when 'media_list' then
    v_out := v_out || jsonb_build_object('form_page', null, 'title', coalesce(v_display, v_pk), 'description', coalesce(v_fk, v_text), 'badge', null);
  when 'content_row' then
    v_out := v_out || jsonb_build_object('form_page', null, 'title', coalesce(v_display, v_pk), 'description', coalesce(v_text, v_fk),
      'misc', coalesce(v_date, case when v_text is not null then v_fk end), 'badge', null);
  when 'comments' then
    v_out := v_out || jsonb_build_object(
      'user', coalesce((select column_name from meta.wizard_catalog(p_table)
                         where (kind = 'text' or fk_table is not null) and column_name ~ '(user|author|by$|owner|who|person|name)'
                           and not is_pk and not (column_name = any (v_skip)) order by (fk_table is not null) desc, ordinal limit 1), v_fk, v_display),
      'date', v_date, 'comment', coalesce(v_text, v_display));
  when 'data_load' then
    v_out := v_out || jsonb_build_object('mode', case when v_pk is not null then 'merge' else 'append' end, 'skip_errors', false,
      'definition', left(upper(regexp_replace((select relname from pg_class where oid = p_table), '[^A-Za-z0-9_]', '_', 'g')), 55) || '_LOAD');
  when 'wizard' then
    select count(*) into v_n from meta.wizard_catalog(p_table)
     where not generated and not is_pk and kind not in ('binary', 'geometry') and not (column_name = any (v_skip));
    v_out := v_out || jsonb_build_object('return_page', null,
      'columns', (select coalesce(jsonb_agg(column_name order by ordinal), '[]') from meta.wizard_catalog(p_table)
                   where not generated and not is_pk and kind not in ('binary', 'geometry') and not (column_name = any (v_skip))),
      'steps', least(greatest(ceil(v_n / 4.0)::int, 2), 5));
  end case;
  return v_out;
end
$$;

-- the steps of a wizard page type: a page per step with a wizard progress list, the step's fields,
-- Cancel / Previous / Next, and on the last one Finish with an INSERT of all steps' values
create function meta.wizard_steps(p_app meta.app, p_table regclass, p_page int, p_label text, o jsonb) returns int
language plpgsql as $$
declare
  v_skip   text[] := meta.wizard_sidecars(p_table);
  v_return int := coalesce(nullif(o ->> 'return_page', '')::int, p_app.home_page, p_page);
  v_cols   text[];
  v_steps  int;
  v_list   text := 'WIZARD_' || p_page;
  v_first  int;
  v_page   int;
  v_region int;
  v_seq    int;
  v_type   text;
  v_lov    text;
  v_names  text := '';
  v_values text := '';
  i        int;
  c        record;
begin
  -- the chosen columns, and every column a row can't be saved without
  select array_agg(w.column_name order by w.ordinal) into v_cols
    from meta.wizard_catalog(p_table) w
   where not w.generated and w.kind not in ('binary', 'geometry') and not (w.column_name = any (v_skip))
     and (w.column_name in (select meta.wizard_col(p_table, x, 'wizard column') from jsonb_array_elements_text(coalesce(o -> 'columns', '[]')) x)
          or (w.not_null and not w.has_default));
  if v_cols is null then
    raise exception 'choose the columns of the wizard';
  end if;
  v_steps := least(greatest(coalesce(nullif(o ->> 'steps', '')::int, 2), 1), 10, cardinality(v_cols));
  for i in 0 .. v_steps - 1 loop
    if exists (select 1 from meta.page where app_id = p_app.id and page_no = p_page + i) then
      raise exception 'page % already exists (the wizard needs pages % to %)', p_page + i, p_page, p_page + v_steps - 1;
    end if;
  end loop;
  if exists (select 1 from meta.list where app_id = p_app.id and name = v_list) then
    raise exception 'the list % exists already', v_list;
  end if;
  insert into meta.list (app_id, name, type, description) values (p_app.id, v_list, 'static', 'The steps of the wizard on pages ' || p_page || '–' || (p_page + v_steps - 1));
  for i in 0 .. v_steps - 1 loop
    insert into meta.list_entry (app_id, list_name, seq, label, target_page) values (p_app.id, v_list, (i + 1) * 10, 'Step ' || (i + 1), p_page + i);
  end loop;

  for i in 0 .. v_steps - 1 loop
    v_page := meta.wizard_new_page(p_app, p_page + i, p_label || case when v_steps > 1 then format(' (%s/%s)', i + 1, v_steps) else '' end, p_app.home_page);
    update meta.page set title = p_label where id = v_page;
    if i = 0 then
      v_first := v_page;
    end if;
    insert into meta.region (page_id, seq, title, type, template, config)
    values (v_page, 10, 'Steps', 'list', 'plain', jsonb_build_object('list', v_list, 'template', 'wizard_progress'));
    insert into meta.region (page_id, seq, title, type, template)
    values (v_page, 20, 'Step ' || (i + 1), 'form', 'wizard') returning id into v_region;
    v_seq := 10;
    -- this step's share of the columns, in order
    for c in
      select w.* from unnest(v_cols) with ordinality u(col, n) join meta.wizard_catalog(p_table) w on w.column_name = u.col
       where (u.n - 1) * v_steps / cardinality(v_cols) = i
       order by u.n
    loop
      v_lov := null;
      v_type := case
        when c.fk_table is not null then 'select'
        when c.kind = 'number' then 'number'
        when c.kind = 'date' then 'date'
        when c.kind = 'timestamp' then 'datetime'
        when c.kind = 'boolean' then 'switch'
        else 'text' end;
      if v_type = 'select' then
        v_lov := format('select %I as d, %I as r from %s order by 1', coalesce(c.fk_display, c.fk_column), c.fk_column, meta.wizard_qname(c.fk_table));
      end if;
      insert into meta.item (page_id, region_id, seq, name, label, type, lov, required)
      values (v_page, v_region, v_seq, meta.wizard_item(p_page + i, c.column_name), meta.wizard_column_label(p_table, c.column_name),
              v_type, v_lov, c.not_null and not c.has_default and v_type <> 'switch');
      v_seq := v_seq + 10;
      v_names := v_names || case when v_names = '' then '' else ', ' end || quote_ident(c.column_name);
      v_values := v_values || case when v_values = '' then '' else ', ' end || format(':%s::%s', meta.wizard_item(p_page + i, c.column_name), c.type_sql);
    end loop;
    insert into meta.button (page_id, region_id, seq, name, label, action, target_page, hot, slot)
    values (v_page, v_region, 10, 'CANCEL', 'Cancel', 'redirect', v_return, false, 'close');
    if i > 0 then
      insert into meta.button (page_id, region_id, seq, name, label, action, target_page, hot, slot)
      values (v_page, v_region, 20, 'PREVIOUS', 'Previous', 'redirect', p_page + i - 1, false, 'previous');
    end if;
    if i < v_steps - 1 then
      insert into meta.button (page_id, region_id, seq, name, label, action, target_page, hot, slot)
      values (v_page, v_region, 30, 'NEXT', 'Next', 'submit', p_page + i + 1, true, 'next');
    end if;
  end loop;
  -- the last step: Finish saves the row (as the application's role)
  insert into meta.button (page_id, region_id, seq, name, label, action, target_page, hot, slot)
  values (v_page, v_region, 30, 'FINISH', 'Finish', 'submit', v_return, true, 'next');
  insert into meta.process (page_id, seq, name, type, code, when_button, success_message)
  values (v_page, 10, 'Create ' || meta.wizard_table_label(p_table, false), 'sql',
          format('insert into %s (%s)%svalues (%s)', meta.wizard_qname(p_table), v_names, E'\n', v_values), 'FINISH',
          meta.wizard_table_label(p_table, false) || ' created.');
  return v_first;
end
$$;

create function meta.generate_page(
  p_app     text,
  p_kind    text,
  p_table   regclass,
  p_page    int,
  p_options jsonb default '{}'
) returns int
language plpgsql as $$
declare
  v_app    meta.app;
  o        jsonb;
  v_label  text;
  v_flabel text;
  v_icon   text;
  v_pk     text;
  v_page   int;
  v_region int;
  v_report int;
  v_fpage  int;
  v_link   jsonb;
  v_rep    jsonb;
  v_src    text;
  v_cfg    jsonb;
  v_a      text;
  v_b      text;
  v_c      text;
  v_d      text;
  v_name   text;
  v_facets jsonb := '[]';
  v_names  text[];
  v_n      int;
  c        record;
begin
  if p_kind in ('report_form', 'grid', 'form', 'cards', 'calendar', 'chart', 'map', 'facets', 'master_detail') then
    return meta.generate_page_100(p_app, p_kind, p_table, p_page, p_options);
  end if;
  select * into v_app from meta.app where alias = p_app;
  if v_app.id is null then
    raise exception 'application "%" does not exist', p_app;
  end if;
  if p_kind = 'dashboard' then
    raise exception 'a dashboard is made by the builder (Create page → Dashboard): it reads the data to choose its charts';
  end if;
  if p_kind not in ('report', 'smart_filters', 'tree', 'timeline', 'media_list', 'content_row', 'comments', 'data_load', 'wizard',
                    'search', 'tasks', 'workflows') then
    raise exception 'unknown page type "%"', p_kind;
  end if;
  if p_kind in ('tasks', 'workflows') then
    p_table := null;
  elsif p_kind <> 'search' or p_table is not null then
    perform meta.wizard_check_table(p_table);
  end if;
  if p_options is null or jsonb_typeof(p_options) <> 'object' then
    p_options := '{}';
  end if;
  -- an option given as JSON null or '' means "none"; a missing one takes the default
  o := meta.wizard_defaults(p_kind, case when p_kind = 'search' then null else p_table end) || p_options;
  v_pk := case when p_table is not null then meta.wizard_pk(p_table) end;
  v_label := coalesce(nullif(btrim(o ->> 'label'), ''),
                      case when p_table is not null then meta.wizard_table_label(p_table) else initcap(replace(p_kind, '_', ' ')) end);
  v_flabel := case when p_table is not null then meta.wizard_table_label(p_table, false) end;
  v_icon := nullif(o ->> 'icon', '');
  v_fpage := case when p_kind in ('report', 'smart_filters', 'tree', 'timeline', 'media_list', 'content_row', 'search')
                  then nullif(o ->> 'form_page', '')::int end;
  if v_fpage = p_page then
    raise exception 'the form page needs a page number of its own';
  end if;
  if v_fpage is not null and (p_table is null or v_pk is null) then
    raise exception 'a form page needs a table with a single-column primary key%', coalesce(format(' (%s has none)', p_table), '');
  end if;
  if v_fpage is not null then
    v_link := jsonb_build_object('page', v_fpage, 'items', jsonb_build_object(meta.wizard_item(v_fpage, v_pk), '#' || v_pk || '#'));
  end if;

  if p_kind = 'wizard' then
    v_page := meta.wizard_steps(v_app, p_table, p_page, v_label, o);

  elsif p_kind = 'data_load' then
    v_name := upper(btrim(coalesce(o ->> 'definition', '')));
    if v_name !~ '^[A-Z][A-Z0-9_]{0,59}$' then
      raise exception 'the data load definition''s name is upper case letters, digits and _ (at most 60), e.g. ORDERS_LOAD';
    end if;
    if coalesce(o ->> 'mode', 'append') not in ('append', 'merge', 'replace') then
      raise exception 'the mode is append, merge or replace';
    end if;
    if o ->> 'mode' = 'merge' and v_pk is null then
      raise exception 'merge needs a table with a single-column primary key (% has none)', p_table;
    end if;
    if meta.wizard_qname(p_table) !~ '^[A-Za-z_][A-Za-z0-9_$]*([.][A-Za-z_][A-Za-z0-9_$]*)?$' then
      raise exception 'a data load definition needs a table name without quotes (% has one)', p_table;
    end if;
    -- an existing definition of that name is used as it is
    if not exists (select 1 from meta.data_load_def where app_id = v_app.id and name = v_name) then
      insert into meta.data_load_def (app_id, name, description, table_name, mode, skip_errors)
      values (v_app.id, v_name, 'Made by Create page → Data loading', meta.wizard_qname(p_table),
              coalesce(o ->> 'mode', 'append'), coalesce((o ->> 'skip_errors')::boolean, false));
    end if;
    v_page := meta.wizard_new_page(v_app, p_page, v_label, v_app.home_page);
    insert into meta.region (page_id, seq, title, type)
    values (v_page, 10, v_label, 'form') returning id into v_region;
    insert into meta.item (page_id, region_id, seq, name, label, type, required, help)
    values (v_page, v_region, 10, format('P%s_FILE', p_page), 'File', 'file', true,
            'A CSV, Excel, JSON or XML file whose column names match the table''s columns.');
    insert into meta.button (page_id, region_id, seq, name, label, action, hot)
    values (v_page, v_region, 10, 'LOAD', 'Load', 'submit', true);
    insert into meta.process (page_id, seq, name, type, when_button, success_message, config)
    values (v_page, 10, 'Load ' || meta.wizard_table_label(p_table), 'data_load', 'LOAD', '{inserted} added, {updated} updated.',
            jsonb_build_object('file_item', format('P%s_FILE', p_page), 'definition', v_name));

  else
    v_page := meta.wizard_new_page(v_app, p_page, v_label, v_app.home_page);
    if p_kind in ('report', 'smart_filters') then
      v_rep := meta.wizard_report(p_table);
      insert into meta.region (page_id, seq, title, type, source, config)
      values (v_page, 20, v_label, 'report', v_rep ->> 'source',
              jsonb_build_object('headings', v_rep -> 'headings')
              || case when v_link is not null then jsonb_build_object('link', v_link || jsonb_build_object('column', v_pk, 'icon', true)) else '{}' end
              || case when jsonb_array_length(v_rep -> 'hidden') > 0 then jsonb_build_object('hidden', v_rep -> 'hidden') else '{}' end
              || case when v_rep -> 'formats' <> '{}' then jsonb_build_object('formats', v_rep -> 'formats') else '{}' end)
      returning id into v_region;
      if p_kind = 'smart_filters' then
        for c in
          select w.* from jsonb_array_elements_text(coalesce(o -> 'facets', '[]')) with ordinality x(col, n)
            join meta.wizard_catalog(p_table) w on w.column_name = meta.wizard_col(p_table, x.col, 'facet column')
           order by x.n
        loop
          continue when c.kind in ('binary', 'geometry', 'point', 'other');
          -- a foreign key filters by the parent's name, the column wizard_report shows instead of the key
          v_facets := v_facets || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
            'column', case when (v_rep -> 'hidden') ? c.column_name
                           then (select k from jsonb_object_keys(v_rep -> 'headings') k where k like c.column_name || '\_display%' order by length(k) limit 1)
                           else c.column_name end,
            'label', meta.wizard_column_label(p_table, c.column_name),
            'type', case when c.kind in ('number', 'date', 'timestamp') and c.fk_table is null then 'range' end)));
        end loop;
        insert into meta.region (page_id, seq, title, type, columns, template, config)
        values (v_page, 10, 'Filters', 'smart_filters', 12, 'plain',
                jsonb_build_object('report', v_region, 'facets', v_facets,
                                   'placeholder', 'Search or filter ' || lower(meta.wizard_table_label(p_table)) || '…'));
      end if;

    elsif p_kind = 'tree' then
      v_a := meta.wizard_col(p_table, o ->> 'id_column', 'id column');
      v_b := meta.wizard_col(p_table, o ->> 'parent_column', 'parent column');
      v_c := meta.wizard_col(p_table, o ->> 'label_column', 'label column');
      if v_a is null then
        raise exception 'choose the column that identifies a node (usually the primary key)';
      end if;
      if v_b is null then
        raise exception 'choose the parent column: % has no foreign key to itself', p_table;
      end if;
      v_c := coalesce(v_c, v_a);
      v_cfg := jsonb_build_object('expanded', least(greatest(coalesce(nullif(o ->> 'expanded', '')::int, 1), 0), 20));
      if v_link is not null then
        -- the tree's link takes #id#: the node's id column is the key here
        v_cfg := v_cfg || jsonb_build_object('link', jsonb_build_object('page', v_fpage,
          'items', jsonb_build_object(meta.wizard_item(v_fpage, v_pk), case when v_a = v_pk then '#id#' else '#' || v_pk || '#' end)));
      end if;
      insert into meta.region (page_id, seq, title, type, source, config)
      values (v_page, 10, v_label, 'tree',
              format(E'select t.%I as id,\n       t.%I as parent_id,\n       %s as label%s\n  from %s t\n order by 3',
                     v_a, v_b, meta.wizard_expr(p_table, v_c),
                     case when v_link is not null and v_a <> v_pk then format(E',\n       t.%I', v_pk) else '' end,
                     meta.wizard_qname(p_table)),
              v_cfg)
      returning id into v_region;

    elsif p_kind in ('timeline', 'media_list', 'content_row', 'comments') then
      -- a built-in template component, one row per instance, all rows in its wrapper ("multiple")
      if p_kind = 'timeline' then
        v_a := meta.wizard_col(p_table, o ->> 'title', 'title column');
        v_b := meta.wizard_col(p_table, o ->> 'when', 'date column');
        if v_a is null then
          raise exception 'choose the column for the titles';
        end if;
        v_src := concat_ws(E',\n       ',
          meta.wizard_expr(p_table, v_a) || ' as title',
          case when v_b is not null then format('t.%I as "when"', v_b) end,
          meta.wizard_expr(p_table, meta.wizard_col(p_table, o ->> 'who', 'who column')) || ' as who',
          meta.wizard_expr(p_table, meta.wizard_col(p_table, o ->> 'body', 'text column')) || ' as body',
          case when v_pk is not null then format('t.%I', v_pk) end);
        v_d := case when v_b is not null then format('t.%I desc nulls last', v_b) else '1' end;
      elsif p_kind in ('media_list', 'content_row') then
        v_a := meta.wizard_col(p_table, o ->> 'title', 'title column');
        if v_a is null then
          raise exception 'choose the column for the titles';
        end if;
        v_src := concat_ws(E',\n       ',
          meta.wizard_expr(p_table, v_a) || ' as title',
          format('upper(left(%s::text, 2)) as initials', meta.wizard_expr(p_table, v_a)),
          meta.wizard_expr(p_table, meta.wizard_col(p_table, o ->> 'description', 'description column')) || ' as description',
          case when p_kind = 'content_row' then meta.wizard_expr(p_table, meta.wizard_col(p_table, o ->> 'misc', 'secondary column')) || ' as misc' end,
          meta.wizard_expr(p_table, meta.wizard_col(p_table, o ->> 'badge', 'badge column')) || ' as badge',
          case when v_pk is not null then format('t.%I', v_pk) end);
        v_d := '1';
      else
        v_a := meta.wizard_col(p_table, o ->> 'comment', 'comment column');
        v_b := meta.wizard_col(p_table, o ->> 'date', 'date column');
        v_c := meta.wizard_col(p_table, o ->> 'user', 'user column');
        if v_a is null then
          raise exception 'choose the column with the comment';
        end if;
        v_src := concat_ws(E',\n       ',
          coalesce(meta.wizard_expr(p_table, v_c), quote_literal('')) || ' as "user"',
          case when v_c is not null then format('upper(left(%s::text, 2)) as initials', meta.wizard_expr(p_table, v_c)) end,
          case when v_b is not null then format('t.%I as date', v_b) end,
          meta.wizard_expr(p_table, v_a) || ' as comment',
          case when v_pk is not null then format('t.%I', v_pk) end);
        v_d := case when v_b is not null then format('t.%I desc nulls last', v_b) else '1' end;
      end if;
      insert into meta.region (page_id, seq, title, type, source, config)
      values (v_page, 10, v_label, 'template_component',
              format(E'select %s\n  from %s t\n order by %s', v_src, meta.wizard_qname(p_table), v_d),
              jsonb_strip_nulls(jsonb_build_object('component', 'ut_' || p_kind, 'display', 'multiple', 'max_rows', 100, 'link', v_link)))
      returning id into v_region;

    elsif p_kind = 'search' then
      select array_agg(upper(x)) into v_names from jsonb_array_elements_text(coalesce(o -> 'configs', '[]')) x where btrim(x) <> '';
      for v_name in select unnest(coalesce(v_names, '{}')) loop
        if not exists (select 1 from meta.search_config where app_id = v_app.id and name = v_name) then
          raise exception 'the application has no search configuration %', v_name;
        end if;
      end loop;
      if p_table is not null then
        -- a new configuration on the table: its text columns searched, its name or first text column as the title
        v_name := left(upper(regexp_replace((select relname from pg_class where oid = p_table), '[^A-Za-z0-9_]', '_', 'g')), 50);
        v_n := 1;
        while exists (select 1 from meta.search_config where app_id = v_app.id and name = v_name || case when v_n > 1 then '_' || v_n else '' end) loop
          v_n := v_n + 1;
        end loop;
        v_name := v_name || case when v_n > 1 then '_' || v_n else '' end;
        v_a := coalesce(meta.wizard_display(p_table), v_pk);
        if v_a is null then
          raise exception '% has no text column to show as the results'' titles', p_table;
        end if;
        insert into meta.search_config (app_id, name, label, seq, source_type, source, searchable_columns, title_column, description_column, link)
        values (v_app.id, v_name, meta.wizard_table_label(p_table), 10 * (1 + (select count(*) from meta.search_config where app_id = v_app.id)),
                'table', meta.wizard_qname(p_table),
                coalesce((select array_agg(column_name order by ordinal) from meta.wizard_catalog(p_table)
                           where kind = 'text' and not (column_name = any (meta.wizard_sidecars(p_table)))), '{}'),
                v_a,
                (select column_name from meta.wizard_catalog(p_table) where kind = 'text' and column_name <> v_a
                    and not (column_name = any (meta.wizard_sidecars(p_table))) order by ordinal limit 1),
                v_link);
        v_names := coalesce(v_names, '{}') || v_name;
      end if;
      if coalesce(cardinality(v_names), 0) = 0 then
        raise exception 'choose at least one search configuration, or a table to search';
      end if;
      insert into meta.region (page_id, seq, title, type, columns, config)
      values (v_page, 10, v_label, 'search', 12, jsonb_build_object('configs', to_jsonb(v_names)))
      returning id into v_region;
      -- the form page belongs to the new configuration's table
      if p_table is null then
        v_fpage := null;
      end if;

    elsif p_kind = 'tasks' then
      insert into meta.region (page_id, seq, title, type, columns, config)
      values (v_page, 10, v_label, 'tasks', 12,
              jsonb_build_object('context', case when o ->> 'context' in ('my', 'initiated', 'admin') then o ->> 'context' else 'my' end,
                                 'completed', coalesce((o ->> 'completed')::boolean, false)));
    elsif p_kind = 'workflows' then
      insert into meta.region (page_id, seq, title, type, columns, config)
      values (v_page, 10, v_label, 'workflows', 12,
              case when o ->> 'context' = 'admin' then '{"context": "admin"}'::jsonb else '{}'::jsonb end);
    end if;

    if v_fpage is not null then
      perform meta.wizard_form(v_app, p_table, v_fpage, v_flabel, p_page, true, null);
      if p_kind <> 'search' then
        insert into meta.button (page_id, region_id, seq, name, label, action, target_page, hot)
        values (v_page, v_region, 10, 'CREATE', 'Create', 'redirect', v_fpage, true);
      end if;
    end if;
  end if;

  if coalesce((o ->> 'nav')::boolean, false) then
    perform meta.wizard_nav(v_app, v_label, v_icon, p_page);
  end if;
  return v_page;
end
$$;

revoke all on function meta.generate_page_100(text, text, regclass, int, jsonb), meta.wizard_defaults_097(text, regclass),
  meta.generate_page(text, text, regclass, int, jsonb), meta.wizard_defaults(text, regclass),
  meta.wizard_check_table(regclass), meta.wizard_steps(meta.app, regclass, int, text, jsonb)
  from public;

-- ---------------------------------------------------------------- 2. configuration options
alter table meta.build_option add column configurable boolean not null default false;
comment on column meta.build_option.configurable is 'The application''s administrators may switch it at run time (the Configuration Options feature; meta.set_configurable_options)';

-- an export made before 137 leaves the flag out
create function meta.build_option_defaults() returns trigger
language plpgsql set search_path = pg_catalog as $$
begin
  new.configurable := coalesce(new.configurable, false);
  return new;
end $$;
create trigger build_option_defaults before insert on meta.build_option
  for each row execute function meta.build_option_defaults();

-- the configurable build options of the current application, for its administrators
create function meta.configurable_options()
returns table (name text, description text, enabled boolean)
language plpgsql stable security definer set search_path = meta, pg_catalog as $$
declare
  v_app int := meta.caller_app('meta.configurable_options');
begin
  if not meta.has_role('admin') then
    raise exception 'meta.configurable_options: for the application''s administrators' using errcode = '42501';
  end if;
  return query
    select o.name, coalesce(nullif(btrim(o.description), ''), initcap(replace(o.name, '_', ' '))), o.status = 'include'
      from meta.build_option o
     where o.app_id = v_app and o.configurable
     order by o.name;
end
$$;
grant execute on function meta.configurable_options() to public;

-- switch the configurable build options: those named in p_enabled (colon-separated, as a checkbox group
-- posts them) are included, the other configurable ones excluded. Returns how many changed.
create function meta.set_configurable_options(p_enabled text) returns int
language plpgsql volatile security definer set search_path = meta, pg_catalog as $$
declare
  v_app  int := meta.caller_app('meta.set_configurable_options');
  v_on   text[] := coalesce(string_to_array(nullif(p_enabled, ''), ':'), '{}');
  v_n    int;
begin
  if not meta.has_role('admin') then
    raise exception 'meta.set_configurable_options: for the application''s administrators' using errcode = '42501';
  end if;
  if exists (select 1 from unnest(v_on) x
              where not exists (select 1 from meta.build_option o where o.app_id = v_app and o.configurable and o.name = upper(x))) then
    raise exception 'meta.set_configurable_options: only configurable build options can be switched' using errcode = '42501';
  end if;
  update meta.build_option o
     set status = case when o.name = any (select upper(x) from unnest(v_on) x) then 'include' else 'exclude' end
   where o.app_id = v_app and o.configurable
     and o.status <> case when o.name = any (select upper(x) from unnest(v_on) x) then 'include' else 'exclude' end;
  get diagnostics v_n = row_count;
  return v_n;
end
$$;
grant execute on function meta.set_configurable_options(text) to public;

-- ---------------------------------------------------------------- 3. e-mail reporting
create function meta.send_activity_report(p_to text, p_days int default 7) returns bigint
language plpgsql volatile security definer set search_path = meta, pg_catalog as $$
declare
  v_app     int := meta.caller_app('meta.send_activity_report');
  v_auto    int := nullif(current_setting('pgkiln.automation_id', true), '')::int;
  v_session uuid := nullif(current_setting('pgkiln.session_id', true), '')::uuid;
  v_days    int := least(greatest(coalesce(p_days, 7), 1), 366);
  v_name    text;
  v_body    text;
  v_mail    bigint;
  r         record;
begin
  -- the application's own automations (the scheduler sets the automation), or a signed-in administrator
  if not ((v_auto is not null and exists (select 1 from meta.automation a where a.id = v_auto and a.app_id = v_app))
          or (v_session is not null and exists (select 1 from meta.session s where s.id = v_session and s.app_id = v_app)
              and meta.has_role('admin'))) then
    raise exception 'meta.send_activity_report: for the application''s automations and administrators' using errcode = '42501';
  end if;
  if coalesce(btrim(p_to), '') = '' then
    return null;
  end if;
  select a.name into v_name from meta.app a where a.id = v_app;
  select count(*) filter (where l.event = 'page_view') as views,
         count(distinct l.username) filter (where l.event = 'page_view') as users,
         count(*) filter (where l.event = 'login') as logins,
         count(*) filter (where l.event = 'login_failed') as failed,
         count(*) filter (where l.event ~ 'error') as errors
    into r
    from meta.activity_log l
   where l.app_id = v_app and l.at > now() - make_interval(days => v_days);
  v_body := format(E'%s: the last %s days\n\nPage views: %s\nUsers: %s\nSign-ins: %s (failed: %s)\nErrors: %s\n',
                   v_name, v_days, r.views, r.users, r.logins, r.failed, r.errors);
  v_body := v_body || E'\nMost viewed pages:\n' || coalesce((
    select string_agg(format('  page %s: %s', x.page_no, x.n), E'\n' order by x.n desc, x.page_no)
      from (select l.page_no, count(*) as n from meta.activity_log l
             where l.app_id = v_app and l.event = 'page_view' and l.at > now() - make_interval(days => v_days)
             group by 1 order by 2 desc, 1 limit 5) x), '  (none)')
    || E'\n\nThe activity is attached as a CSV file.\n';
  v_mail := meta.send_mail(p_to, format('%s: activity of the last %s days', v_name, v_days), v_body);
  perform meta.add_mail_attachment(v_mail,
    meta.data_export(format('select at, username, event, page_no, elapsed_ms from meta.activity_log where app_id = %s and at > now() - make_interval(days => %s) order by at desc limit 10000', v_app, v_days), 'csv'),
    'activity.csv', 'text/csv');
  return v_mail;
end
$$;
revoke all on function meta.send_activity_report(text, int) from public;
grant execute on function meta.send_activity_report(text, int) to public;
comment on function meta.send_activity_report(text, int) is 'Mail a summary of the current application''s activity with a CSV (137; the Email Reporting feature). For its automations and administrators.';

-- ---------------------------------------------------------------- 4. copy page
-- does the application have a shared component of this kind and name?
create function meta.shared_component_exists(p_kind text, p_app int, p_name text) returns boolean
language sql stable as $$
  select case p_kind
    when 'authz_scheme' then exists (select 1 from meta.authz_scheme s where s.app_id = p_app and s.name = p_name)
    when 'build_option' then exists (select 1 from meta.build_option s where s.app_id = p_app and s.name = p_name)
    when 'lov' then exists (select 1 from meta.lov s where s.app_id = p_app and s.name = p_name)
    when 'list' then exists (select 1 from meta.list s where s.app_id = p_app and s.name = p_name)
    when 'template_component' then exists (select 1 from meta.template_component s where s.app_id = p_app and s.static_id = p_name)
    when 'search_config' then exists (select 1 from meta.search_config s where s.app_id = p_app and s.name = p_name)
    when 'data_load_def' then exists (select 1 from meta.data_load_def s where s.app_id = p_app and s.name = p_name)
    else false end
$$;

-- the shared components a page refers to by name, that the source application has:
-- (kind, name, whether the target application has one of that name)
create function meta.page_shared_refs(p_page_id int, p_target_app int)
returns table (kind text, name text, in_target boolean)
language sql stable as $$
  with pg as (select * from meta.page where id = p_page_id),
  refs (kind, name) as (
    select 'authz_scheme', x.authz from (
      select authz from pg union all select authz from meta.region where page_id = p_page_id
      union all select authz from meta.item where page_id = p_page_id union all select authz from meta.button where page_id = p_page_id
      union all select authz from meta.process where page_id = p_page_id union all select authz from meta.dynamic_action where page_id = p_page_id
      union all select authz from meta.branch where page_id = p_page_id union all select authz from meta.computation where page_id = p_page_id) x
    union
    select 'build_option', ltrim(x.build_option, '!') from (
      select build_option from pg union all select build_option from meta.region where page_id = p_page_id
      union all select build_option from meta.item where page_id = p_page_id union all select build_option from meta.button where page_id = p_page_id
      union all select build_option from meta.process where page_id = p_page_id union all select build_option from meta.dynamic_action where page_id = p_page_id
      union all select build_option from meta.validation where page_id = p_page_id union all select build_option from meta.branch where page_id = p_page_id
      union all select build_option from meta.computation where page_id = p_page_id) x
    union
    select 'lov', substr(i.lov, 5) from meta.item i where i.page_id = p_page_id and i.lov ~ '^LOV:'
    union
    select 'list', r.config ->> 'list' from meta.region r where r.page_id = p_page_id and r.type = 'list'
    union
    select 'template_component', r.config ->> 'component' from meta.region r where r.page_id = p_page_id and r.type = 'template_component'
    union
    select 'search_config', upper(x) from meta.region r, jsonb_array_elements_text(case when jsonb_typeof(r.config -> 'configs') = 'array' then r.config -> 'configs' else '[]' end) x
     where r.page_id = p_page_id and r.type = 'search'
    union
    select 'data_load_def', p.config ->> 'definition' from meta.process p where p.page_id = p_page_id and p.type = 'data_load'
  )
  select r.kind, r.name,
         meta.shared_component_exists(r.kind, p_target_app, r.name)
    from refs r, pg
   -- a built-in template component (ut_…) or a name the application doesn't have is left as it is
   where coalesce(r.name, '') <> '' and meta.shared_component_exists(r.kind, pg.app_id, r.name)
   order by 1, 2
$$;

-- {"page": <old>} → {"page": <new>} anywhere in a configuration (a page's links to itself)
create function meta.copy_page_json(p jsonb, p_old int, p_new int) returns jsonb
language plpgsql immutable as $$
declare
  v jsonb;
  k text;
  e jsonb;
begin
  if p is null or p_old = p_new then
    return p;
  end if;
  case jsonb_typeof(p)
  when 'object' then
    v := '{}';
    for k, e in select * from jsonb_each(p) loop
      if k = 'page' and jsonb_typeof(e) = 'number' and (e #>> '{}')::numeric = p_old then
        v := v || jsonb_build_object(k, p_new);
      else
        v := v || jsonb_build_object(k, meta.copy_page_json(e, p_old, p_new));
      end if;
    end loop;
    return v;
  when 'array' then
    return coalesce((select jsonb_agg(meta.copy_page_json(x, p_old, p_new) order by n) from jsonb_array_elements(p) with ordinality a(x, n)), '[]');
  else
    return p;
  end case;
end
$$;

/*
 * Copy page p_page of application p_from into application p_to (the same or another) as page p_new.
 * p_map: {"<kind>:<NAME>": "<target name>"} maps a shared component to one of the target's (by name);
 * without an entry, a component the target has by the same name is used, else it is copied.
 * Returns the new page's id.
 */
create function meta.copy_page(p_from int, p_page int, p_to int, p_new int, p_name text default null, p_map jsonb default '{}')
returns int
language plpgsql as $$
declare
  v_src     meta.page;
  v_page_id int;
  v_old     text;
  v_new     text;
  v_rmap    jsonb := '{}';
  v_map     jsonb := '{}';
  v_target  text;
  v_id      int;
  v_newid   int;
  v_e       jsonb;
  v_lmap    jsonb;
  t         text;
  r         record;
  x         record;
begin
  select * into v_src from meta.page where app_id = p_from and page_no = p_page;
  if v_src.id is null then
    raise exception 'page % does not exist', p_page;
  end if;
  if not exists (select 1 from meta.app where id = p_to) then
    raise exception 'the target application does not exist';
  end if;
  if p_new is null or p_new < 1 then
    raise exception 'a page number must be a positive whole number';
  end if;
  if exists (select 1 from meta.page where app_id = p_to and page_no = p_new) then
    raise exception 'page % already exists', p_new;
  end if;
  if p_map is null or jsonb_typeof(p_map) <> 'object' then
    p_map := '{}';
  end if;

  -- the shared components: mapped, the same name, or copied
  for r in select * from meta.page_shared_refs(v_src.id, p_to) loop
    v_target := nullif(p_map ->> (r.kind || ':' || r.name), '');
    if v_target is null and (p_from = p_to or r.in_target) then
      v_target := r.name;
    end if;
    if v_target is not null then
      if not meta.shared_component_exists(r.kind, p_to, v_target) then
        raise exception 'the target application has no % %', replace(r.kind, '_', ' '), v_target;
      end if;
      v_map := v_map || jsonb_build_object(r.kind || ':' || r.name, v_target);
      continue;
    end if;
    -- copy the component into the target application, under its own name
    t := case r.kind when 'authz_scheme' then 'authz_scheme' when 'build_option' then 'build_option' when 'lov' then 'lov'
                     when 'list' then 'list' when 'template_component' then 'template_component'
                     when 'search_config' then 'search_config' when 'data_load_def' then 'data_load_def' end;
    execute format(
      'insert into meta.%1$I select (jsonb_populate_record(null::meta.%1$I, to_jsonb(x) || jsonb_build_object(''id'', nextval(''meta.%1$s_id_seq''), ''app_id'', $2))).* from meta.%1$I x where x.app_id = $1 and x.%2$I = $3',
      t, case when t = 'template_component' then 'static_id' else 'name' end)
      using p_from, p_to, r.name;
    if r.kind = 'list' then
      -- and its entries, with their parents
      v_lmap := '{}';
      for x in select * from meta.list_entry where app_id = p_from and list_name = r.name order by parent_id nulls first, id loop
        v_e := to_jsonb(x) || jsonb_build_object('id', nextval('meta.list_entry_id_seq'), 'app_id', p_to,
                                                'parent_id', v_lmap ->> x.parent_id::text);
        insert into meta.list_entry select (jsonb_populate_record(null::meta.list_entry, v_e)).* returning id into v_id;
        v_lmap := v_lmap || jsonb_build_object(x.id::text, v_id);
      end loop;
    end if;
    v_map := v_map || jsonb_build_object(r.kind || ':' || r.name, r.name);
  end loop;

  -- the page
  insert into meta.page
  select (jsonb_populate_record(null::meta.page, to_jsonb(v_src) || jsonb_build_object(
            'id', nextval('meta.page_id_seq'), 'app_id', p_to, 'page_no', p_new,
            'name', coalesce(nullif(btrim(p_name), ''), v_src.name),
            'parent_page', case when v_src.parent_page = p_page then null
                                when exists (select 1 from meta.page where app_id = p_to and page_no = v_src.parent_page) then v_src.parent_page
                                else (select home_page from meta.app where id = p_to) end,
            'authz', v_map ->> ('authz_scheme:' || v_src.authz),
            'build_option', case when v_src.build_option is not null
                                 then case when left(v_src.build_option, 1) = '!' then '!' else '' end
                                      || (v_map ->> ('build_option:' || ltrim(v_src.build_option, '!'))) end))).*
  returning id into v_page_id;
  -- an authorization or build option that is not a shared component (e.g. a built-in) stays as it was
  update meta.page p set authz = coalesce(p.authz, v_src.authz), build_option = coalesce(p.build_option, v_src.build_option) where p.id = v_page_id;

  v_old := 'P' || p_page || '_';
  v_new := 'P' || p_new || '_';
  -- every component: items renamed P<old>_ → P<new>_ (also where code refers to them), links to the page itself
  -- to the copy, shared components mapped
  for t in select unnest(array['region', 'item', 'button', 'dynamic_action', 'validation', 'process', 'computation', 'branch']) loop
    for v_e in execute format('select to_jsonb(x) from meta.%I x where x.page_id = $1 order by x.id', t) using v_src.id loop
      v_id := (v_e ->> 'id')::int;
      if p_page <> p_new then
        v_e := regexp_replace(v_e::text, '\m' || v_old, v_new, 'g')::jsonb;
      end if;
      if v_e ? 'config' then
        v_e := jsonb_set(v_e, '{config}', coalesce(meta.copy_page_json(v_e -> 'config', p_page, p_new), 'null'));
      end if;
      if v_e ? 'target_page' and (v_e ->> 'target_page')::int = p_page and coalesce(v_e ->> 'target_type', 'page') = 'page' then
        v_e := v_e || jsonb_build_object('target_page', p_new);
      end if;
      if v_e ->> 'authz' is not null and v_map ? ('authz_scheme:' || (v_e ->> 'authz')) then
        v_e := v_e || jsonb_build_object('authz', v_map ->> ('authz_scheme:' || (v_e ->> 'authz')));
      end if;
      if v_e ->> 'build_option' is not null and v_map ? ('build_option:' || ltrim(v_e ->> 'build_option', '!')) then
        v_e := v_e || jsonb_build_object('build_option', case when left(v_e ->> 'build_option', 1) = '!' then '!' else '' end
                                                         || (v_map ->> ('build_option:' || ltrim(v_e ->> 'build_option', '!'))));
      end if;
      if t = 'item' and v_e ->> 'lov' ~ '^LOV:' and v_map ? ('lov:' || substr(v_e ->> 'lov', 5)) then
        v_e := v_e || jsonb_build_object('lov', 'LOV:' || (v_map ->> ('lov:' || substr(v_e ->> 'lov', 5))));
      end if;
      if t = 'region' and v_e ->> 'type' = 'list' and v_map ? ('list:' || (v_e #>> '{config,list}')) then
        v_e := jsonb_set(v_e, '{config,list}', to_jsonb(v_map ->> ('list:' || (v_e #>> '{config,list}'))));
      end if;
      if t = 'region' and v_e ->> 'type' = 'template_component' and v_map ? ('template_component:' || (v_e #>> '{config,component}')) then
        v_e := jsonb_set(v_e, '{config,component}', to_jsonb(v_map ->> ('template_component:' || (v_e #>> '{config,component}'))));
      end if;
      if t = 'region' and v_e ->> 'type' = 'search' and jsonb_typeof(v_e #> '{config,configs}') = 'array' then
        v_e := jsonb_set(v_e, '{config,configs}', (select coalesce(jsonb_agg(coalesce(v_map ->> ('search_config:' || upper(c)), c) order by n), '[]')
                                                     from jsonb_array_elements_text(v_e #> '{config,configs}') with ordinality a(c, n)));
      end if;
      if t = 'process' and v_e ->> 'type' = 'data_load' and v_map ? ('data_load_def:' || (v_e #>> '{config,definition}')) then
        v_e := jsonb_set(v_e, '{config,definition}', to_jsonb(v_map ->> ('data_load_def:' || (v_e #>> '{config,definition}'))));
      end if;
      v_e := v_e || jsonb_build_object('id', null, 'page_id', v_page_id);
      if v_e ? 'region_id' then
        v_e := v_e || jsonb_build_object('region_id', v_rmap -> (v_e ->> 'region_id'));
      end if;
      if v_e ? 'affected_region_id' then
        v_e := v_e || jsonb_build_object('affected_region_id', v_rmap -> (v_e ->> 'affected_region_id'));
      end if;
      execute format('insert into meta.%1$I select (jsonb_populate_record(null::meta.%1$I, $1 || jsonb_build_object(''id'', nextval(''meta.%1$s_id_seq'')))).* returning id', t)
        using v_e into v_newid;
      if t = 'region' then
        v_rmap := v_rmap || jsonb_build_object(v_id::text, v_newid);
      end if;
    end loop;
    if t = 'region' then
      -- facets, smart filters and maps point at their report region by id
      update meta.region r
         set config = jsonb_set(r.config, '{report}', v_rmap -> (r.config ->> 'report'))
       where r.page_id = v_page_id and r.config ? 'report' and v_rmap ? (r.config ->> 'report');
    end if;
  end loop;
  return v_page_id;
end
$$;
revoke all on function meta.shared_component_exists(text, int, text), meta.page_shared_refs(int, int), meta.copy_page_json(jsonb, int, int),
  meta.copy_page(int, int, int, int, text, jsonb) from public;
