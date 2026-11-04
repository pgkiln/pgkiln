-- Sprint 142 (AP-8): JSON sources and document views (APEX: Shared Components → JSON Sources, JSON Duality Views).
--
-- meta.app.json_sources       an application's JSON sources, a JSON list exported with the application (like
--                             vector_providers, migration 136). A source names a table, its key and a jsonb column
--                             (a column of a relational table, or the one document column of a table of documents)
--                             and a data profile: columns at paths in the document, and arrays of objects (or of
--                             values) with columns of their own. The builder (Shared Components → JSON sources)
--                             proposes the profile from sample rows and creates views from it in the application's
--                             schema; regions, REST and MCP use those views like tables.
--
-- The views are ordinary schema objects, made by the builder with the developer's connection and recorded in the
-- Change Log (like Table Properties › Add full-text search, migration 135). They are security_invoker (the
-- table's row level security and grants apply to whoever reads them) and get INSTEAD OF triggers that call the
-- functions below, with the source's description as the trigger argument:
--
-- meta.json_source_write()    a source's view: an UPDATE changes only the paths whose values changed, in one
--                             UPDATE of the table row (meta.jsonb_patch), so keys the profile doesn't know about
--                             stay; an INSERT or DELETE adds or removes the table row only when the source says
--                             so (a table of documents), else it is refused.
-- meta.json_array_write()     an array's view (one row per element, keyed by the element's contents): UPDATE
--                             patches one element, INSERT appends one, DELETE removes one, each in one UPDATE of
--                             the table row (meta.jsonb_array_change). An element that changed meanwhile is not
--                             found and the statement fails, so nothing is overwritten.
-- meta.json_document_write()  a document view (SQL Workshop › Table Properties › Document view: APEX's JSON
--                             Duality View): a table row and its child rows (foreign keys) as one jsonb document;
--                             writing the document updates the row, upserts the children it lists and deletes the
--                             children it leaves out.
--
-- All of them are SECURITY INVOKER with search_path pg_catalog: they write as the role that writes the view, so its
-- grants and the table's row level security apply; identifiers from the trigger argument are quoted (format %I).

alter table meta.app add column json_sources jsonb not null default '[]'
  check (jsonb_typeof(json_sources) = 'array');
comment on column meta.app.json_sources is 'JSON sources (142): a jsonb column described by a data profile, presented as updatable views; exported with the application';

-- an export made before 142 has no json_sources
create or replace function meta.app_ai_default() returns trigger
language plpgsql set search_path = pg_catalog as $$
begin
  new.ai_tools := coalesce(new.ai_tools, '[]');
  new.ai_agents := coalesce(new.ai_agents, '[]');
  new.vector_providers := coalesce(new.vector_providers, '[]');
  new.json_sources := coalesce(new.json_sources, '[]');
  return new;
end $$;

-- ---------------------------------------------------------------- reading values

-- Whether a text reads as a value of a type (integer, numeric, date …): a document with a wrong value shows NULL
-- in that column instead of failing the whole view. pg_input_is_valid on PostgreSQL 16 and later.
do $do$
begin
  if current_setting('server_version_num')::int >= 160000 then
    execute $f$
      create function meta.input_ok(p_value text, p_type text) returns boolean
      language sql stable parallel safe set search_path = pg_catalog as
      $$ select p_value is null or pg_input_is_valid(p_value, p_type) $$$f$;
  else
    execute $f$
      create function meta.input_ok(p_value text, p_type text) returns boolean
      language plpgsql stable parallel safe set search_path = pg_catalog as $$
      begin
        if p_value is null then
          return true;
        end if;
        execute format('select %L::%s', p_value, p_type::regtype);
        return true;
      exception when others then
        return false;
      end $$$f$;
  end if;
end
$do$;

-- ---------------------------------------------------------------- changing documents

-- Set a value at a path of keys, making the objects on the way (jsonb_set only makes the last key).
create function meta.jsonb_put(p_doc jsonb, p_path text[], p_value jsonb) returns jsonb
language plpgsql immutable parallel safe set search_path = pg_catalog as $$
declare
  d jsonb := p_doc;
  i int;
begin
  if coalesce(cardinality(p_path), 0) = 0 then
    return p_value;
  end if;
  if d is null or jsonb_typeof(d) <> 'object' then
    d := '{}';
  end if;
  for i in 1 .. cardinality(p_path) - 1 loop
    if jsonb_typeof(d #> p_path[1:i]) is distinct from 'object' then
      d := jsonb_set(d, p_path[1:i], '{}', true);
    end if;
  end loop;
  return jsonb_set(d, p_path, p_value, true);
end $$;

-- Apply changes [{"p": [keys], "v": value}] to a document: a value is set at its path, a null (or JSON null)
-- removes the key. Keys the changes don't name stay as they are.
create function meta.jsonb_patch(p_doc jsonb, p_changes jsonb) returns jsonb
language plpgsql immutable parallel safe set search_path = pg_catalog as $$
declare
  d jsonb := p_doc;
  c jsonb;
  p text[];
begin
  for c in select x from jsonb_array_elements(coalesce(p_changes, '[]')) x loop
    p := array(select jsonb_array_elements_text(c->'p'));
    if c->'v' is null or jsonb_typeof(c->'v') = 'null' then
      if cardinality(p) = 0 then
        d := null;
      elsif d is not null then
        d := d #- p;
      end if;
    else
      d := meta.jsonb_put(d, p, c->'v');
    end if;
  end loop;
  return d;
end $$;

-- The key of each element of an array as the array views show it: the md5 of the element's text and its
-- occurrence among equal elements (1, 2 …), so a key stays the same when other elements are added or removed.
create function meta.jsonb_element_keys(p_array jsonb)
returns table (idx int, key text)
language sql immutable parallel safe set search_path = pg_catalog as $$
  select (x.ord - 1)::int, md5(x.e::text) || '.' || row_number() over (partition by md5(x.e::text) order by x.ord)
    from jsonb_array_elements(case when jsonb_typeof(p_array) = 'array' then p_array else '[]' end) with ordinality x(e, ord)
$$;

-- Change one element of the array at p_path: 'update' patches the element with the given key, 'delete' removes
-- it, 'insert' appends a new element made of the changes. An element that is not there (changed or removed
-- meanwhile) raises an error.
create function meta.jsonb_array_change(p_doc jsonb, p_path text[], p_op text, p_key text, p_changes jsonb) returns jsonb
language plpgsql immutable set search_path = pg_catalog as $$
declare
  arr jsonb := p_doc #> p_path;
  i   int;
  e   jsonb;
begin
  if arr is null or jsonb_typeof(arr) <> 'array' then
    arr := '[]';
  end if;
  if p_op = 'insert' then
    arr := arr || jsonb_build_array(coalesce(meta.jsonb_patch('{}', p_changes), 'null'));
  else
    select k.idx into i from meta.jsonb_element_keys(arr) k where k.key = p_key;
    if i is null then
      raise exception 'The element % of % is no longer there: someone changed the document meanwhile. Reload and try again.',
        p_key, array_to_string(p_path, '.') using errcode = '40001';
    end if;
    if p_op = 'delete' then
      arr := arr - i;
    elsif p_op = 'update' then
      e := arr -> i;
      if jsonb_typeof(e) <> 'object' and exists (select from jsonb_array_elements(p_changes) c where jsonb_array_length(c->'p') > 0) then
        e := '{}';
      end if;
      arr := jsonb_set(arr, array[i::text], coalesce(meta.jsonb_patch(e, p_changes), 'null'));
    else
      raise exception 'meta.jsonb_array_change: unknown operation %', p_op;
    end if;
  end if;
  return meta.jsonb_put(p_doc, p_path, arr);
end $$;

-- The WHERE condition on a table's key columns, with the values from $1 (a jsonb row): typed by the table's row type.
create function meta.json_key_where(p_schema text, p_table text, p_key jsonb, p_alias text default 't', p_param int default 1) returns text
language sql immutable set search_path = pg_catalog as $$
  select string_agg(format('%I.%I = (jsonb_populate_record(null::%I.%I, $%s)).%I', p_alias, k, p_schema, p_table, p_param, k), ' and ')
    from jsonb_array_elements_text(p_key) k
$$;

-- The changes of the profile's columns between two rows of a view (to_jsonb(old), to_jsonb(new)).
create function meta.json_column_changes(p_columns jsonb, p_old jsonb, p_new jsonb) returns jsonb
language sql immutable parallel safe set search_path = pg_catalog as $$
  select coalesce(jsonb_agg(jsonb_build_object('p', c->'path', 'v', p_new -> (c->>'name'))), '[]')
    from jsonb_array_elements(p_columns) c
   where coalesce(c->>'readonly', 'false') <> 'true'
     and (p_old is null or (p_new -> (c->>'name')) is distinct from (p_old -> (c->>'name')))
     and (p_old is not null or jsonb_typeof(p_new -> (c->>'name')) is distinct from 'null')
$$;

-- INSTEAD OF trigger of a JSON source's view. Argument: {"schema", "table", "key": [columns], "column",
-- "columns": [{"name", "path"}], "rows": true|false, "name"}.
create function meta.json_source_write() returns trigger
language plpgsql security invoker set search_path = pg_catalog as $$
declare
  s    jsonb := tg_argv[0]::jsonb;
  o    jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  n    jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  k    text;
  ch   jsonb;
  cnt  int;
  cols text := '';
  vals text := '';
  r    jsonb;
begin
  if tg_op = 'UPDATE' then
    for k in select jsonb_array_elements_text(s->'key') loop
      if (n->k) is distinct from (o->k) then
        raise exception 'JSON source %: the key column % is not changed through the view', s->>'name', k;
      end if;
    end loop;
    ch := meta.json_column_changes(s->'columns', o, n);
    if jsonb_array_length(ch) > 0 then
      execute format('update %I.%I t set %I = meta.jsonb_patch(t.%I, $2) where %s',
                     s->>'schema', s->>'table', s->>'column', s->>'column', meta.json_key_where(s->>'schema', s->>'table', s->'key'))
        using o, ch;
      get diagnostics cnt = row_count;
      if cnt = 0 then
        return null;
      end if;
    end if;
    return new;
  end if;
  if coalesce(s->>'rows', 'false') <> 'true' then
    raise exception 'JSON source % changes the documents of existing rows of %.%: % through its view is not allowed',
      s->>'name', s->>'schema', s->>'table', lower(tg_op) using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    execute format('delete from %I.%I t where %s', s->>'schema', s->>'table', meta.json_key_where(s->>'schema', s->>'table', s->'key')) using o;
    get diagnostics cnt = row_count;
    return case when cnt = 0 then null else old end;
  end if;
  -- INSERT: the key columns given (others take their defaults) and the document made of the given values
  for k in select jsonb_array_elements_text(s->'key') loop
    if jsonb_typeof(n->k) is distinct from 'null' and (n->k) is not null then
      cols := cols || format('%I, ', k);
      vals := vals || format('(jsonb_populate_record(null::%I.%I, $1)).%I, ', s->>'schema', s->>'table', k);
    end if;
  end loop;
  execute format('insert into %I.%I as t (%s%I) values (%s$2) returning to_jsonb(t)',
                 s->>'schema', s->>'table', cols, s->>'column', vals)
    into r using n, coalesce(meta.jsonb_patch('{}', meta.json_column_changes(s->'columns', null, n)), '{}');
  new := jsonb_populate_record(new, r);
  return new;
end $$;

-- INSTEAD OF trigger of an array's view. Argument: {"schema", "table", "key": [the table's key columns, also
-- columns of the view], "column", "array": [path], "columns": [{"name", "path"}], "row_key", "position", "name"}.
create function meta.json_array_write() returns trigger
language plpgsql security invoker set search_path = pg_catalog as $$
declare
  s   jsonb := tg_argv[0]::jsonb;
  o   jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  n   jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  rk  text := coalesce(s->>'row_key', 'row_key');
  k   text;
  ch  jsonb;
  e   jsonb;
  doc jsonb;
  cnt int;
  arr text[] := array(select jsonb_array_elements_text(s->'array'));
begin
  if tg_op = 'UPDATE' then
    for k in select jsonb_array_elements_text(s->'key') loop
      if (n->k) is distinct from (o->k) then
        raise exception 'JSON source %: an element does not move to another row (column %)', s->>'name', k;
      end if;
    end loop;
    ch := meta.json_column_changes(s->'columns', o, n);
    if jsonb_array_length(ch) = 0 then
      return new;
    end if;
  elsif tg_op = 'INSERT' then
    for k in select jsonb_array_elements_text(s->'key') loop
      if n->k is null or jsonb_typeof(n->k) = 'null' then
        raise exception 'JSON source %: a new element needs the row it belongs to (column %)', s->>'name', k using errcode = '23502';
      end if;
    end loop;
    ch := meta.json_column_changes(s->'columns', null, n);
  end if;
  execute format('update %I.%I t set %I = meta.jsonb_array_change(t.%I, $2, $3, $4, $5) where %s returning t.%I',
                 s->>'schema', s->>'table', s->>'column', s->>'column', meta.json_key_where(s->>'schema', s->>'table', s->'key'), s->>'column')
    into doc using coalesce(o, n), arr, lower(tg_op), o->>rk, ch;
  get diagnostics cnt = row_count;
  if cnt = 0 then
    return null;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  -- a new element: its key and position as the view now shows them (the last one)
  if tg_op = 'INSERT' then
    select jsonb_build_object(rk, k3.key, coalesce(s->>'position', 'position'), k3.idx + 1) into e
      from meta.jsonb_element_keys(doc #> arr) k3
     order by k3.idx desc limit 1;
    new := jsonb_populate_record(new, e);
  end if;
  return new;
end $$;

-- INSTEAD OF trigger of a document view. Argument: {"schema", "table", "key": [columns], "document": "doc",
-- "children": [{"name", "schema", "table", "key": [columns], "fk": [[child column, parent column], …]}]}.
create function meta.json_document_write() returns trigger
language plpgsql security invoker set search_path = pg_catalog as $$
declare
  s     jsonb := tg_argv[0]::jsonb;
  dcol  text := coalesce(s->>'document', 'doc');
  o     jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  d     jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) -> dcol end;
  pk    jsonb;           -- the parent row's key columns and values
  ch    jsonb;
  c     jsonb;
  e     jsonb;
  row_  jsonb;
  kept  jsonb[];
  cols  text[];
  sets  text;
  ins   text;
  fkw   text;
  k     text;
  cnt   int;
  childnames text[] := array(select x->>'name' from jsonb_array_elements(coalesce(s->'children', '[]')) x);
begin
  if tg_op <> 'DELETE' and (d is null or jsonb_typeof(d) <> 'object') then
    raise exception 'The document of %.% is a JSON object', s->>'schema', s->>'table' using errcode = '22023';
  end if;
  -- the parent row
  if tg_op = 'DELETE' then
    pk := (select jsonb_object_agg(k2, o->k2) from jsonb_array_elements_text(s->'key') k2);
  elsif tg_op = 'UPDATE' then
    pk := (select jsonb_object_agg(k2, o->k2) from jsonb_array_elements_text(s->'key') k2);
    for k in select jsonb_array_elements_text(s->'key') loop
      if d ? k and (d->k) is distinct from (o->k) and (d->>k) is distinct from (o->>k) then
        raise exception 'The key column % of %.% is not changed through its document', k, s->>'schema', s->>'table';
      end if;
    end loop;
    cols := array(
      select a.attname::text from pg_attribute a
       where a.attrelid = format('%I.%I', s->>'schema', s->>'table')::regclass and a.attnum > 0 and not a.attisdropped
         and a.attgenerated = '' and a.attidentity <> 'a' and d ? a.attname
         and a.attname <> all (array(select jsonb_array_elements_text(s->'key'))) and a.attname <> all (childnames));
    if cardinality(cols) > 0 then
      select string_agg(format('%I = r.%I', x, x), ', ') into sets from unnest(cols) x;
      execute format('update %I.%I t set %s from jsonb_populate_record(null::%I.%I, $2) r where %s',
                     s->>'schema', s->>'table', sets, s->>'schema', s->>'table', meta.json_key_where(s->>'schema', s->>'table', s->'key'))
        using pk, d;
      get diagnostics cnt = row_count;
      if cnt = 0 then
        return null;
      end if;
    end if;
  else
    cols := array(
      select a.attname::text from pg_attribute a
       where a.attrelid = format('%I.%I', s->>'schema', s->>'table')::regclass and a.attnum > 0 and not a.attisdropped
         and a.attgenerated = '' and a.attidentity <> 'a' and d ? a.attname and jsonb_typeof(d->a.attname) <> 'null'
         and a.attname <> all (childnames));
    select string_agg(format('%I', x), ', '), string_agg(format('r.%I', x), ', ') into sets, ins from unnest(cols) x;
    if sets is null then
      execute format('insert into %I.%I as t default values returning to_jsonb(t)', s->>'schema', s->>'table') into row_;
    else
      execute format('insert into %I.%I as t (%s) select %s from jsonb_populate_record(null::%I.%I, $1) r returning to_jsonb(t)',
                     s->>'schema', s->>'table', sets, ins, s->>'schema', s->>'table')
        into row_ using d;
    end if;
    pk := (select jsonb_object_agg(k2, row_->k2) from jsonb_array_elements_text(s->'key') k2);
  end if;

  -- the children
  for c in select x from jsonb_array_elements(coalesce(s->'children', '[]')) x loop
    select string_agg(format('x.%I = (jsonb_populate_record(null::%I.%I, $1)).%I', f->>0, s->>'schema', s->>'table', f->>1), ' and ')
      into fkw from jsonb_array_elements(c->'fk') f;
    if tg_op = 'DELETE' then
      execute format('delete from %I.%I x where %s', c->>'schema', c->>'table', fkw) using pk;
      continue;
    end if;
    if not (d ? (c->>'name')) then
      continue;
    end if;
    if jsonb_typeof(d->(c->>'name')) <> 'array' then
      raise exception 'In the document of %.%, % is an array', s->>'schema', s->>'table', c->>'name' using errcode = '22023';
    end if;
    kept := '{}';
    for e in select x from jsonb_array_elements(d->(c->>'name')) x loop
      if jsonb_typeof(e) <> 'object' then
        raise exception 'In the document of %.%, the elements of % are objects', s->>'schema', s->>'table', c->>'name' using errcode = '22023';
      end if;
      -- the foreign key columns come from the parent
      e := e || (select jsonb_object_agg(f->>0, pk->(f->>1)) from jsonb_array_elements(c->'fk') f);
      row_ := null;
      if not exists (select from jsonb_array_elements_text(c->'key') k2 where e->k2 is null or jsonb_typeof(e->k2) = 'null') then
        cols := array(
          select a.attname::text from pg_attribute a
           where a.attrelid = format('%I.%I', c->>'schema', c->>'table')::regclass and a.attnum > 0 and not a.attisdropped
             and a.attgenerated = '' and a.attidentity <> 'a' and e ? a.attname
             and a.attname <> all (array(select jsonb_array_elements_text(c->'key'))));
        select string_agg(format('%I = r.%I', x, x), ', ') into sets from unnest(cols) x;
        execute format('update %I.%I x set %s from jsonb_populate_record(null::%I.%I, $2) r where %s and %s returning to_jsonb(x)',
                       c->>'schema', c->>'table', coalesce(sets, format('%I = x.%I', c->'key'->>0, c->'key'->>0)), c->>'schema', c->>'table',
                       fkw, meta.json_key_where(c->>'schema', c->>'table', c->'key', 'x', 2))
          into row_ using pk, e;
      end if;
      if row_ is null then
        cols := array(
          select a.attname::text from pg_attribute a
           where a.attrelid = format('%I.%I', c->>'schema', c->>'table')::regclass and a.attnum > 0 and not a.attisdropped
             and a.attgenerated = '' and a.attidentity <> 'a' and e ? a.attname and jsonb_typeof(e->a.attname) <> 'null');
        select string_agg(format('%I', x), ', '), string_agg(format('r.%I', x), ', ') into sets, ins from unnest(cols) x;
        execute format('insert into %I.%I as x (%s) select %s from jsonb_populate_record(null::%I.%I, $1) r returning to_jsonb(x)',
                       c->>'schema', c->>'table', sets, ins, c->>'schema', c->>'table')
          into row_ using e;
      end if;
      kept := kept || (select jsonb_object_agg(k2, row_->k2) from jsonb_array_elements_text(c->'key') k2);
    end loop;
    -- the children the document leaves out
    execute format('delete from %I.%I x where %s and not ((select jsonb_object_agg(k, to_jsonb(x)->k) from jsonb_array_elements_text($3) k) = any ($2))',
                   c->>'schema', c->>'table', fkw)
      using pk, kept, c->'key';
  end loop;

  if tg_op = 'DELETE' then
    execute format('delete from %I.%I t where %s', s->>'schema', s->>'table', meta.json_key_where(s->>'schema', s->>'table', s->'key')) using pk;
    get diagnostics cnt = row_count;
    return case when cnt = 0 then null else old end;
  end if;
  new := jsonb_populate_record(new, pk);
  return new;
end $$;

grant execute on function meta.input_ok(text, text), meta.jsonb_put(jsonb, text[], jsonb), meta.jsonb_patch(jsonb, jsonb),
  meta.jsonb_element_keys(jsonb), meta.jsonb_array_change(jsonb, text[], text, text, jsonb),
  meta.json_key_where(text, text, jsonb, text, int), meta.json_column_changes(jsonb, jsonb, jsonb),
  meta.json_source_write(), meta.json_array_write(), meta.json_document_write() to public;
