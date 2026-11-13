-- =====================================================================
-- 163: the Change Log records DDL run outside the SQL Workshop
--      (sprint 180, DA-17 leftover)
--
-- The Change Log (118) records the DDL a developer runs from the SQL
-- Worksheet, Table Properties and Schema Comparison. DDL run elsewhere
-- (psql, a migration tool, another IDE) was not in it. Two event trigger
-- functions record it as change sets with the source 'external':
--
--   meta.change_log_ddl()   ddl_command_end: CREATE, ALTER, COMMENT, ...
--   meta.change_log_drop()  sql_drop: DROP
--
-- Only a superuser can create an event trigger, so this migration
-- creates the functions and not the triggers: recording is opt-in.
-- SQL Workshop > Change Log shows whether it is on and the statements
-- that turn it on (or a button, when pgkiln's own connection is a
-- superuser):
--
--   create event trigger pgkiln_change_log_ddl on ddl_command_end
--     execute function meta.change_log_ddl();
--   create event trigger pgkiln_change_log_drop on sql_drop
--     execute function meta.change_log_drop();
--
-- What is recorded: the statement (current_query()) once per schema it
-- changes and per transaction, in that schema's change log; the author is
-- the session user. Not recorded: pgkiln's own sessions (application_name
-- pgkiln...: the builder records its DDL itself, migrations are pgkiln's),
-- a session that sets pgkiln.change_log = 'off', system schemas, meta, and
-- objects of an extension. The change set belongs to the isolated
-- workspace whose role owns the schema, else to the default workspace.
-- It is part of the DDL's transaction: a rollback removes it too.
--
-- The functions are SECURITY DEFINER (they run as pgkiln's owner, never
-- as the superuser who runs the DDL) with a fixed search_path, and a
-- failure only raises a warning: recording never stops a DDL statement.
-- =====================================================================

alter table meta.change_set drop constraint change_set_source_check;
alter table meta.change_set add constraint change_set_source_check
  check (source in ('worksheet', 'table', 'compare', 'external'));

-- one change set per schema for the statement being run (called by both event trigger functions)
create function meta.change_log_record(p_tag text, p_targets text[][]) returns void
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_query text;
  v_seen  text := coalesce(current_setting('pgkiln.change_log_seen', true), '');
  v_key   text;
  v_ws    int;
  v_name  text;
  i       int;
begin
  if coalesce(current_setting('application_name', true), '') like 'pgkiln%'
     or coalesce(current_setting('pgkiln.change_log', true), '') = 'off' then
    return;
  end if;
  v_query := btrim(coalesce(current_query(), ''));
  if v_query = '' or p_targets is null then return; end if;
  for i in 1 .. coalesce(array_length(p_targets, 1), 0) loop
    -- a statement once per schema and transaction (a script sent as one query fires the trigger per statement;
    -- ALTER TABLE ... DROP COLUMN fires both triggers)
    v_key := md5(v_query) || '/' || p_targets[i][1];
    continue when position(v_key in v_seen) > 0;
    v_seen := v_seen || ' ' || v_key;
    perform set_config('pgkiln.change_log_seen', v_seen, true);
    select coalesce(
      (select w.id from meta.workspace w, pg_namespace n
        where n.nspname = p_targets[i][1] and w.isolated and pg_get_userbyid(n.nspowner) in (w.dev_role, w.run_role)
        order by w.id limit 1),
      (select min(id) from meta.workspace)) into v_ws;
    continue when v_ws is null;
    v_name := left(btrim(regexp_replace(lower(p_tag || ' ' || coalesce(p_targets[i][2], '')), '[^a-z0-9]+', '_', 'g'), '_'), 60);
    if v_name !~ '^[a-z0-9]' then v_name := 'external_ddl'; end if;
    insert into meta.change_set (workspace_id, schema_name, name, author, source, sql, object_name)
    values (v_ws, p_targets[i][1], v_name, left(session_user::text, 200), 'external', left(v_query, 1000000), left(p_targets[i][2], 63));
  end loop;
exception when others then
  raise warning 'pgkiln change log: the statement was not recorded: %', sqlerrm;
end $$;

-- the schemas a change is not recorded for
create function meta.change_log_skips(p_schema text) returns boolean
language sql immutable set search_path = pg_catalog as $$
  select p_schema is null or p_schema in ('meta', 'information_schema', 'pg_catalog', 'pg_toast', 'cron', 'pgkiln')
      or p_schema like 'pg\_temp%' or p_schema like 'pg\_toast\_temp%'
$$;

-- an object's name without its schema: the identity after "schema." (a quoted name may hold dots)
create function meta.change_log_object(p_schema text, p_identity text) returns text
language sql immutable set search_path = pg_catalog as $$
  select case when starts_with(p_identity, quote_ident(p_schema) || '.') then substr(p_identity, length(quote_ident(p_schema)) + 2) else p_identity end
$$;

create function meta.change_log_ddl() returns event_trigger
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_targets text[][];
begin
  select array_agg(array[schema_name, object_name] order by first)
    into v_targets
    from (select c.schema_name, min(meta.change_log_object(c.schema_name, c.object_identity)) as object_name, min(c.ordinality) as first
            from pg_event_trigger_ddl_commands() with ordinality c
           where not c.in_extension and not meta.change_log_skips(c.schema_name)
           group by c.schema_name) t;
  perform meta.change_log_record(tg_tag, v_targets);
exception when others then
  raise warning 'pgkiln change log: the statement was not recorded: %', sqlerrm;
end $$;

create function meta.change_log_drop() returns event_trigger
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_targets text[][];
begin
  select array_agg(array[schema_name, object_name] order by first)
    into v_targets
    from (select d.schema_name, min(coalesce(d.object_name, meta.change_log_object(d.schema_name, d.object_identity))) as object_name, min(d.ordinality) as first
            from pg_event_trigger_dropped_objects() with ordinality d
           where d.original and not d.is_temporary and not meta.change_log_skips(d.schema_name)
             and d.object_type not in ('schema', 'extension')
           group by d.schema_name) t;
  perform meta.change_log_record(tg_tag, v_targets);
exception when others then
  raise warning 'pgkiln change log: the statement was not recorded: %', sqlerrm;
end $$;

revoke all on function meta.change_log_record(text, text[][]) from public;
revoke all on function meta.change_log_skips(text) from public;
revoke all on function meta.change_log_object(text, text) from public;
revoke all on function meta.change_log_ddl() from public;
revoke all on function meta.change_log_drop() from public;
comment on function meta.change_log_ddl() is
  'The Change Log (163): records DDL of other sessions as change sets (source external) once a superuser creates the event trigger pgkiln_change_log_ddl on ddl_command_end';
comment on function meta.change_log_drop() is
  'The Change Log (163): records DROP statements of other sessions once a superuser creates the event trigger pgkiln_change_log_drop on sql_drop';
