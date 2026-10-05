-- =====================================================================
-- 044: automations with several actions, error handling per row and
-- on-demand runs from SQL (APEX: Automations → Actions, "Actions Error
-- Handling", APEX_AUTOMATION.EXECUTE)
--
-- - meta.automation_action: the ordered actions of an automation, each
--   with a name, code (SQL or PL/pgSQL) and an optional condition (a
--   boolean SQL expression, with the row's columns as binds when the
--   automation runs per row). Existing automations get one action named
--   "Action" with their code, so they behave as before.
-- - meta.automation.code stays as a write-only shortcut for scripts and
--   older export files: writing it creates (or replaces) the automation's
--   single action and the column is set back to null.
-- - meta.automation.error_handling: 'stop' (an error rolls the whole run
--   back: the behaviour so far), 'skip' (per row: a failing row is rolled
--   back and recorded, the other rows go on) or 'disable' (like stop, and
--   the automation is switched off).
-- - meta.automation_log: failed rows, the first 50 row errors, who ran it.
-- - One executor for every run (meta.automation_execute, in PL/pgSQL, as
--   the caller's role): the scheduler and Run now call it as the
--   application's role, meta.run_automation() calls it in the caller's
--   transaction.
--
-- meta.export_app / meta.import_app are redefined from 043 (new section
-- "automation_actions"; older files with automations' code still import).
-- =====================================================================

-- ---------------------------------------------------------------- actions
create table meta.automation_action (
  id               serial primary key,
  app_id           int  not null references meta.app on delete cascade,
  automation_name  text not null,
  seq              int  not null default 10,
  name             text not null check (length(btrim(name)) between 1 and 100),
  code             text not null check (length(code) <= 100000),
  condition        text check (length(condition) <= 10000),
  unique (app_id, automation_name, name),
  foreign key (app_id, automation_name) references meta.automation (app_id, name) on update cascade on delete cascade
);
create index on meta.automation_action (app_id, automation_name, seq);
revoke all on meta.automation_action from public;
comment on table meta.automation_action is 'shared component: the ordered actions of an automation (code with an optional condition)';
comment on column meta.automation_action.condition is 'a boolean SQL expression; the action runs only when it is true (binds: the row''s columns)';

alter table meta.automation add column error_handling text not null default 'stop' check (error_handling in ('stop', 'skip', 'disable'));
comment on column meta.automation.error_handling is 'stop: an error rolls the run back · skip: a failing row is rolled back and recorded, the others go on · disable: like stop, and the automation is switched off';

-- existing automations: their code becomes their first action
insert into meta.automation_action (app_id, automation_name, seq, name, code)
select app_id, name, 10, 'Action', code from meta.automation where code is not null and btrim(code) <> '';
alter table meta.automation alter column code drop not null;
update meta.automation set code = null;
comment on column meta.automation.code is 'write-only shortcut (scripts, older export files): writing it creates or replaces the single action; always null when read';

-- writing code: the automation's single action
create function meta.automation_code_to_action() returns trigger
language plpgsql set search_path = meta, pg_catalog as $$
declare
  v_n int;
begin
  if new.code is null then
    return null;
  end if;
  select count(*) into v_n from meta.automation_action where app_id = new.app_id and automation_name = new.name;
  if v_n > 1 then
    raise exception 'automation "%" has several actions: change them in meta.automation_action', new.name;
  elsif v_n = 1 then
    update meta.automation_action set code = new.code where app_id = new.app_id and automation_name = new.name;
  elsif btrim(new.code) <> '' then
    insert into meta.automation_action (app_id, automation_name, seq, name, code) values (new.app_id, new.name, 10, 'Action', new.code);
  end if;
  update meta.automation set code = null where id = new.id;
  return null;
end
$$;
create trigger automation_code_to_action after insert or update of code on meta.automation
  for each row when (new.code is not null) execute function meta.automation_code_to_action();

-- ---------------------------------------------------------------- run log
alter table meta.automation_log drop constraint automation_log_trigger_check;
alter table meta.automation_log add constraint automation_log_trigger_check check (trigger in ('schedule', 'manual', 'sql'));
alter table meta.automation_log drop constraint automation_log_status_check;
alter table meta.automation_log add constraint automation_log_status_check check (status in ('running', 'ok', 'warning', 'error'));
alter table meta.automation drop constraint automation_last_status_check;
alter table meta.automation add constraint automation_last_status_check check (last_status in ('ok', 'warning', 'error'));
alter table meta.automation_log add column rows_failed int;
alter table meta.automation_log add column errors jsonb;
alter table meta.automation_log add column run_by text;
comment on column meta.automation_log.rows is 'rows of the query processed (0 without a query)';
comment on column meta.automation_log.errors is 'error handling "skip": the first 50 failed rows [{row, action, message, values}]';
comment on column meta.automation_log.run_by is 'meta.run_automation(): the application user who called it';

-- ---------------------------------------------------------------- binds
-- The SQL split at its bind references (:NAME), like src/binds.ts: the
-- scanner skips string literals, dollar quotes, quoted identifiers,
-- comments and :: casts. Returns text, NAME, text, NAME, …, text.
create function meta.automation_bind_parts(p_sql text) returns text[]
language plpgsql immutable set search_path = meta, pg_catalog as $$
declare
  ch    text[] := coalesce(string_to_array(p_sql, null), '{}');
  n     int := coalesce(array_length(string_to_array(p_sql, null), 1), 0);
  i     int := 1;
  j     int;
  seg   int := 1;
  depth int;
  bs    boolean;
  q     text;
  tag   text;
  tlen  int;
  k     int;
  ok    boolean;
  out   text[] := '{}';
begin
  while i <= n loop
    q := ch[i];
    -- -- line comment (up to the newline)
    if q = '-' and ch[i + 1] = '-' then
      while i <= n and ch[i] <> E'\n' loop i := i + 1; end loop;
      continue;
    end if;
    -- /* block comment */ (nested)
    if q = '/' and ch[i + 1] = '*' then
      depth := 0;
      j := i;
      while j <= n loop
        if ch[j] = '/' and ch[j + 1] = '*' then
          depth := depth + 1; j := j + 2;
        elsif ch[j] = '*' and ch[j + 1] = '/' then
          depth := depth - 1; j := j + 2;
          exit when depth = 0;
        else
          j := j + 1;
        end if;
      end loop;
      i := j;
      continue;
    end if;
    -- 'string' (E'' with backslash escapes) and "identifier"
    if q = '''' or q = '"' then
      bs := q = '''' and i > 1 and ch[i - 1] in ('E', 'e');
      j := i + 1;
      while j <= n loop
        if bs and ch[j] = '\' then
          j := j + 2;
          continue;
        end if;
        if ch[j] = q then
          if ch[j + 1] = q then
            j := j + 2;
            continue;
          end if;
          exit;
        end if;
        j := j + 1;
      end loop;
      i := least(n + 1, j + 1);
      continue;
    end if;
    -- $tag$ dollar quoting $tag$
    if q = '$' then
      tag := (regexp_match(substr(p_sql, i, 66), '^(\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$)'))[1];
      if tag is not null then
        tlen := length(tag);
        j := i + tlen;
        -- find the closing tag
        loop
          exit when j > n;
          if ch[j] = '$' then
            ok := true;
            for k in 0 .. tlen - 1 loop
              if ch[j + k] is distinct from substr(tag, k + 1, 1) then ok := false; exit; end if;
            end loop;
            exit when ok;
          end if;
          j := j + 1;
        end loop;
        i := case when j > n then n + 1 else j + tlen end;
        continue;
      end if;
    end if;
    -- :: cast
    if q = ':' and ch[i + 1] = ':' then
      i := i + 2;
      continue;
    end if;
    -- :NAME bind (not :=, nor slices like arr[1:2])
    if q = ':' and ch[i + 1] ~ '^[A-Za-z_]$' then
      j := i + 1;
      while j <= n and ch[j] ~ '^[A-Za-z0-9_]$' loop j := j + 1; end loop;
      out := out || substr(p_sql, seg, i - seg) || upper(substr(p_sql, i + 1, j - i - 1));
      seg := j;
      i := j;
      continue;
    end if;
    i := i + 1;
  end loop;
  return out || coalesce(substr(p_sql, seg), '');
end
$$;

-- The SQL with every bind replaced by an untyped literal (NULL when unset
-- or empty), as src/binds.ts applyBinds() does.
create function meta.automation_apply_binds(p_parts text[], p_binds jsonb) returns text
language plpgsql immutable set search_path = meta, pg_catalog as $$
declare
  v_out text := '';
  v_val text;
  i     int;
begin
  for i in 1 .. coalesce(array_length(p_parts, 1), 0) loop
    if i % 2 = 1 then
      v_out := v_out || p_parts[i];
    else
      v_val := p_binds ->> p_parts[i];
      v_out := v_out || case when v_val is null or v_val = '' then 'NULL' else quote_literal(v_val) end;
    end if;
  end loop;
  return v_out;
end
$$;

-- ---------------------------------------------------------------- executor
-- Runs an automation's actions as the *caller* (security invoker: grants
-- and RLS of the role that calls it apply; the scheduler calls it as the
-- application's role). p_def is meta.automation_definition(). Returns
-- {"rows": n, "failed": n, "errors": [...]}; with error handling stop or
-- disable an error is raised (the caller rolls back). The search path is
-- the caller's, so the actions resolve names as they always did.
create function meta.automation_execute(p_def jsonb) returns jsonb
language plpgsql as $$
declare
  v_base    jsonb := coalesce(p_def -> 'binds', '{}');
  v_query   text := nullif(btrim(regexp_replace(coalesce(p_def ->> 'query', ''), '[;[:space:]]+$', '')), '');
  v_skip    boolean;
  v_prep    jsonb := '[]';
  v_act     jsonb;
  v_row     jsonb;
  v_binds   jsonb;
  v_ok      boolean;
  v_rows    int := 0;
  v_failed  int := 0;
  v_errors  jsonb := '[]';
  v_where   text := 'query';
  v_action  text;
  v_msg     text;
  v_state   text;
  v_detail  text;
  v_hint    text;
begin
  v_skip := p_def ->> 'error_handling' = 'skip' and v_query is not null;
  for v_act in select * from jsonb_array_elements(coalesce(p_def -> 'actions', '[]')) loop
    v_prep := v_prep || jsonb_build_array(jsonb_build_object(
      'name', v_act ->> 'name',
      'code', to_jsonb(meta.automation_bind_parts(v_act ->> 'code')),
      'condition', case when nullif(btrim(coalesce(v_act ->> 'condition', '')), '') is null then null
                        else to_jsonb(meta.automation_bind_parts(v_act ->> 'condition')) end));
  end loop;

  begin
    if v_query is null then
      -- once
      for v_act in select * from jsonb_array_elements(v_prep) loop
        v_action := v_act ->> 'name';
        v_where := format('action "%s"', v_action);
        if v_act -> 'condition' <> 'null' then
          execute 'select (' || meta.automation_apply_binds(array(select jsonb_array_elements_text(v_act -> 'condition')), v_base) || E'\n)::boolean' into v_ok;
          continue when v_ok is not true;
        end if;
        execute meta.automation_apply_binds(array(select jsonb_array_elements_text(v_act -> 'code')), v_base);
      end loop;
    else
      -- once per row of the query, with its columns as binds
      for v_row in execute 'select to_jsonb(q) from (' || meta.automation_apply_binds(meta.automation_bind_parts(v_query), v_base) || E'\n) q' loop
        v_rows := v_rows + 1;
        select v_base || coalesce(jsonb_object_agg(upper(e.key), e.value), '{}') into v_binds from jsonb_each(v_row) e;
        if v_skip then
          -- skip: each row in its own subtransaction; a failing row is rolled back and recorded
          begin
            for v_act in select * from jsonb_array_elements(v_prep) loop
              v_action := v_act ->> 'name';
              v_where := format('row %s, action "%s"', v_rows, v_action);
              if v_act -> 'condition' <> 'null' then
                execute 'select (' || meta.automation_apply_binds(array(select jsonb_array_elements_text(v_act -> 'condition')), v_binds) || E'\n)::boolean' into v_ok;
                continue when v_ok is not true;
              end if;
              execute meta.automation_apply_binds(array(select jsonb_array_elements_text(v_act -> 'code')), v_binds);
            end loop;
          exception when others then
            get stacked diagnostics v_msg = message_text;
            v_failed := v_failed + 1;
            if jsonb_array_length(v_errors) < 50 then
              v_errors := v_errors || jsonb_build_array(jsonb_build_object(
                'row', v_rows, 'action', v_action, 'message', left(v_msg, 1000), 'values', left(v_row::text, 300)));
            end if;
          end;
        else
          -- stop / disable: no subtransaction per row (the first error ends the run)
          for v_act in select * from jsonb_array_elements(v_prep) loop
            v_action := v_act ->> 'name';
            v_where := format('row %s, action "%s"', v_rows, v_action);
            if v_act -> 'condition' <> 'null' then
              execute 'select (' || meta.automation_apply_binds(array(select jsonb_array_elements_text(v_act -> 'condition')), v_binds) || E'\n)::boolean' into v_ok;
              continue when v_ok is not true;
            end if;
            execute meta.automation_apply_binds(array(select jsonb_array_elements_text(v_act -> 'code')), v_binds);
          end loop;
        end if;
        v_where := 'query';
      end loop;
    end if;
  exception when others then
    get stacked diagnostics v_msg = message_text, v_state = returned_sqlstate, v_detail = pg_exception_detail, v_hint = pg_exception_hint;
    raise exception using message = v_where || ': ' || v_msg, errcode = v_state, detail = coalesce(v_detail, ''), hint = coalesce(v_hint, '');
  end;
  return jsonb_build_object('rows', v_rows, 'failed', v_failed, 'errors', v_errors);
end
$$;
grant execute on function meta.automation_execute(jsonb) to public;

-- An automation with its actions and binds, as meta.automation_execute()
-- takes it. Owner only (the scheduler; meta.run_automation through
-- meta.automation_begin).
create function meta.automation_definition(p_id int) returns jsonb
language sql stable security definer set search_path = meta, pg_catalog as $$
  select jsonb_build_object(
    'id', x.id, 'app_id', x.app_id, 'name', x.name, 'query', x.query, 'error_handling', x.error_handling,
    'timeout_s', x.timeout_s, 'db_role', a.db_role,
    'binds', jsonb_build_object('APP_ID', x.app_id::text, 'APP_ALIAS', a.alias, 'APP_USER', 'automation:' || x.name, 'AUTOMATION_NAME', x.name),
    'actions', coalesce((select jsonb_agg(jsonb_build_object('name', c.name, 'code', c.code, 'condition', c.condition) order by c.seq, c.name)
                           from meta.automation_action c where c.app_id = x.app_id and c.automation_name = x.name), '[]'))
    from meta.automation x join meta.app a on a.id = x.app_id
   where x.id = p_id
$$;
revoke all on function meta.automation_definition(int) from public;

-- ---------------------------------------------------------------- on demand from SQL
-- meta.automation_begin / _end: the definition and the run log for
-- meta.run_automation(), limited to the automations of the current
-- application (meta.app_id()), like meta.start_workflow().
create function meta.automation_begin(p_name text) returns jsonb
language plpgsql security definer set search_path = meta, pg_catalog as $$
declare
  v_app int := meta.app_id();
  v_id  int;
  v_log bigint;
begin
  if v_app is null then
    raise exception 'meta.run_automation: no current application (call it from application code)';
  end if;
  select id into v_id from meta.automation
   where app_id = v_app and lower(name) = lower(p_name)
   order by name = p_name desc limit 1;
  if v_id is null then
    raise exception 'Automation % does not exist in this application.', p_name;
  end if;
  insert into meta.automation_log (automation_id, trigger, run_by) values (v_id, 'sql', meta.app_user()) returning id into v_log;
  return meta.automation_definition(v_id) || jsonb_build_object('log_id', v_log);
end
$$;

create function meta.automation_end(p_log bigint, p_status text, p_result jsonb, p_message text) returns void
language plpgsql security definer set search_path = meta, pg_catalog as $$
declare
  v_id int;
  v_disable boolean;
begin
  select l.automation_id, x.error_handling = 'disable' into v_id, v_disable
    from meta.automation_log l join meta.automation x on x.id = l.automation_id
   where l.id = p_log and l.status = 'running' and l.trigger = 'sql' and x.app_id = meta.app_id();
  if v_id is null then
    raise exception 'automation run % is not running', p_log;
  end if;
  if p_status not in ('ok', 'warning', 'error') then
    raise exception 'bad status %', p_status;
  end if;
  v_disable := v_disable and p_status = 'error';
  update meta.automation_log
     set finished_at = now(), status = p_status, rows = (p_result ->> 'rows')::int, rows_failed = (p_result ->> 'failed')::int,
         errors = nullif(p_result -> 'errors', '[]'::jsonb),
         message = left(p_message || case when v_disable then ' (the automation was disabled)' else '' end, 2000)
   where id = p_log;
  update meta.automation set last_run_at = now(), last_status = p_status, enabled = enabled and not v_disable where id = v_id;
  delete from meta.automation_log where automation_id = v_id
     and id not in (select id from meta.automation_log where automation_id = v_id order by started_at desc, id desc limit 100);
end
$$;

-- Run an automation of the current application now, in the caller's
-- transaction (like APEX_AUTOMATION.EXECUTE): as the caller's database
-- role, with the automation's roles (meta.has_role) and user
-- (automation:<name>) while it runs. Waits for nobody: when the scheduler
-- or another session is running it, it raises an error. Returns
-- {"status", "rows", "failed", "errors", "message"}.
-- p_raise: an error is raised (default); false: the run's changes are
-- rolled back and the result says "error" (the log entry is kept when the
-- caller commits).
create function meta.run_automation(p_name text, p_raise boolean default true) returns jsonb
language plpgsql as $$
declare
  v_def    jsonb;
  v_log    bigint;
  v_id     int;
  v_chain  text := coalesce(current_setting('pgapex.automation_chain', true), '');
  v_user   text := current_setting('pgapex.app_user', true);
  v_auto   text := current_setting('pgapex.automation_id', true);
  v_sess   text := current_setting('pgapex.session_id', true);
  v_res    jsonb;
  v_status text;
  v_msg    text;
  v_state  text;
begin
  v_def := meta.automation_begin(p_name);
  v_log := (v_def ->> 'log_id')::bigint;
  v_id := (v_def ->> 'id')::int;
  if position(',' || v_id || ',' in v_chain) > 0 then
    raise exception 'Automation % is running already (it calls itself).', v_def ->> 'name';
  end if;
  if not pg_try_advisory_xact_lock(1885823352, v_id) then
    raise exception 'Automation % is running already.', v_def ->> 'name';
  end if;
  begin
    perform set_config('pgapex.app_user', v_def -> 'binds' ->> 'APP_USER', true),
            set_config('pgapex.automation_id', v_id::text, true),
            set_config('pgapex.session_id', '', true),
            set_config('pgapex.automation_chain', coalesce(nullif(v_chain, ''), ',') || v_id || ',', true);
    v_res := meta.automation_execute(v_def);
    perform set_config('pgapex.app_user', coalesce(v_user, ''), true),
            set_config('pgapex.automation_id', coalesce(v_auto, ''), true),
            set_config('pgapex.session_id', coalesce(v_sess, ''), true),
            set_config('pgapex.automation_chain', v_chain, true);
  exception when others then
    -- the run's changes and settings are rolled back here
    get stacked diagnostics v_msg = message_text, v_state = returned_sqlstate;
    v_res := jsonb_build_object('rows', null, 'failed', null, 'errors', '[]'::jsonb);
    v_status := 'error';
  end;
  if v_status is null then
    v_status := case when (v_res ->> 'failed')::int = 0 then 'ok'
                     when (v_res ->> 'failed')::int >= (v_res ->> 'rows')::int then 'error' else 'warning' end;
    if v_status <> 'ok' then
      v_msg := format('%s of %s row(s) failed', v_res ->> 'failed', v_res ->> 'rows');
    end if;
  end if;
  perform meta.automation_end(v_log, v_status, v_res, v_msg);
  if v_status = 'error' and v_state is not null and p_raise then
    raise exception using message = v_msg, errcode = v_state;
  end if;
  return v_res || jsonb_build_object('status', v_status, 'message', v_msg);
end
$$;
grant execute on function meta.run_automation(text, boolean), meta.automation_begin(text), meta.automation_end(bigint, text, jsonb, text) to public;

-- ---------------------------------------------------------------- export / import
-- Same as 043, plus "automation_actions"; automations leave out the
-- write-only code column. On import, an automation of an older file with
-- code gets it as its single action (the trigger above).
create or replace function meta.export_app(p_alias text) returns jsonb
language sql stable set search_path = meta, pg_catalog as $$
  select jsonb_build_object(
    'format', 'pgapex/2',
    'app', to_jsonb(a) - 'id' - 'created_at' - 'updated_at',
    'authz_schemes', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.name) from meta.authz_scheme x where x.app_id = a.id), '[]'),
    'app_items', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.name) from meta.app_item x where x.app_id = a.id), '[]'),
    'app_processes', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.seq, x.id) from meta.app_process x where x.app_id = a.id), '[]'),
    'lovs', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.name) from meta.lov x where x.app_id = a.id), '[]'),
    'group_roles', coalesce((select jsonb_agg(to_jsonb(x) - 'app_id' order by x.group_name, x.role) from meta.app_group_role x where x.app_id = a.id), '[]'),
    'text_messages', coalesce((select jsonb_agg(to_jsonb(x) - 'app_id' order by x.name, x.language) from meta.text_message x where x.app_id = a.id), '[]'),
    'translations', coalesce((select jsonb_agg(to_jsonb(x) - 'app_id' order by x.language, x.source) from meta.translation x where x.app_id = a.id), '[]'),
    'report_layouts', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' - 'logo' || jsonb_build_object('logo', encode(x.logo, 'base64')) order by x.name)
                                  from meta.report_layout x where x.app_id = a.id), '[]'),
    'automations', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' - 'next_run_at' - 'last_run_at' - 'last_status' - 'code' order by x.name)
                               from meta.automation x where x.app_id = a.id), '[]'),
    -- (044) the actions of the automations, by automation name
    'automation_actions', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.automation_name collate "C", x.seq, x.name collate "C")
                                      from meta.automation_action x where x.app_id = a.id), '[]'),
    'document_templates', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.name) from meta.document_template x where x.app_id = a.id), '[]'),
    'task_definitions', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.name) from meta.task_definition x where x.app_id = a.id), '[]'),
    'workflow_definitions', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.name) from meta.workflow_definition x where x.app_id = a.id), '[]'),
    'rest_modules', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.name) from meta.rest_module x where x.app_id = a.id), '[]'),
    'template_components', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.static_id) from meta.template_component x where x.app_id = a.id), '[]'),
    'build_options', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.name) from meta.build_option x where x.app_id = a.id), '[]'),
    -- (030) secrets never leave the installation: they are entered again after an import
    'web_credentials', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' - 'secret_enc' order by x.name) from meta.web_credential x where x.app_id = a.id), '[]'),
    'rest_sources', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.name) from meta.rest_source x where x.app_id = a.id), '[]'),
    -- (041) data load definitions
    'data_load_definitions', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.name) from meta.data_load_def x where x.app_id = a.id), '[]'),
    -- (042) lists; entries keep their ids so parents can be remapped on import
    'lists', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.name) from meta.list x where x.app_id = a.id), '[]'),
    'list_entries', coalesce((select jsonb_agg(to_jsonb(x) - 'app_id' order by x.list_name, x.parent_id nulls first, x.seq, x.id) from meta.list_entry x where x.app_id = a.id), '[]'),
    -- (042) supporting objects: install, upgrade and deinstall scripts (never run on import)
    'supporting_scripts', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.name) from meta.supporting_script x where x.app_id = a.id), '[]'),
    -- nav entries and regions keep their ids, so parents and references can be remapped on import
    'nav', coalesce((select jsonb_agg(to_jsonb(x) - 'app_id' order by x.parent_id nulls first, x.seq, x.id) from meta.nav_entry x where x.app_id = a.id), '[]'),
    'pages', coalesce((
      select jsonb_agg(to_jsonb(p) - 'id' - 'app_id' || jsonb_build_object(
        'regions', coalesce((select jsonb_agg(to_jsonb(r) - 'page_id' order by r.seq, r.id) from meta.region r where r.page_id = p.id), '[]'),
        'items', coalesce((select jsonb_agg(to_jsonb(i) - 'id' - 'page_id' order by i.seq, i.id) from meta.item i where i.page_id = p.id), '[]'),
        'buttons', coalesce((select jsonb_agg(to_jsonb(b) - 'id' - 'page_id' order by b.seq, b.id) from meta.button b where b.page_id = p.id), '[]'),
        'dynamic_actions', coalesce((select jsonb_agg(to_jsonb(d) - 'id' - 'page_id' order by d.seq, d.id) from meta.dynamic_action d where d.page_id = p.id), '[]'),
        'validations', coalesce((select jsonb_agg(to_jsonb(v) - 'id' - 'page_id' order by v.seq, v.id) from meta.validation v where v.page_id = p.id), '[]'),
        'processes', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'page_id' order by x.seq, x.id) from meta.process x where x.page_id = p.id), '[]'),
        'computations', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'page_id' order by x.seq, x.id) from meta.computation x where x.page_id = p.id), '[]'),
        'branches', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'page_id' order by x.seq, x.id) from meta.branch x where x.page_id = p.id), '[]')
      ) order by p.page_no)
      from meta.page p where p.app_id = a.id), '[]'))
  from meta.app a
  where a.alias = p_alias
$$;

create or replace function meta.import_app(p_doc jsonb, p_alias text default null) returns int
language plpgsql set search_path = meta, pg_catalog as $$
declare
  v_app_id  int;
  v_page_id int;
  v_page    jsonb;
  v_e       jsonb;
  v_rmap    jsonb;
  v_nmap    jsonb := '{}';
  v_lmap    jsonb := '{}';
  v_new_id  int;
begin
  if p_doc->>'format' is distinct from 'pgapex/2' then
    raise exception 'unsupported export format %', coalesce(p_doc->>'format', '(none)');
  end if;

  insert into meta.app
  select (jsonb_populate_record(null::meta.app, p_doc->'app' || jsonb_build_object(
            'id', nextval('meta.app_id_seq'),
            'alias', coalesce(p_alias, p_doc->'app'->>'alias'),
            'created_at', now(), 'updated_at', now()))).*
  returning id into v_app_id;

  insert into meta.authz_scheme
  select (jsonb_populate_record(null::meta.authz_scheme, e || jsonb_build_object('id', nextval('meta.authz_scheme_id_seq'), 'app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'authz_schemes', '[]')) e;
  insert into meta.app_item
  select (jsonb_populate_record(null::meta.app_item, e || jsonb_build_object('id', nextval('meta.app_item_id_seq'), 'app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'app_items', '[]')) e;
  insert into meta.app_process
  select (jsonb_populate_record(null::meta.app_process, e || jsonb_build_object('id', nextval('meta.app_process_id_seq'), 'app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'app_processes', '[]')) e;
  insert into meta.lov
  select (jsonb_populate_record(null::meta.lov, e || jsonb_build_object('id', nextval('meta.lov_id_seq'), 'app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'lovs', '[]')) e;
  insert into meta.app_group_role
  select (jsonb_populate_record(null::meta.app_group_role, e || jsonb_build_object('app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'group_roles', '[]')) e;
  insert into meta.text_message
  select (jsonb_populate_record(null::meta.text_message, e || jsonb_build_object('app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'text_messages', '[]')) e;
  insert into meta.translation
  select (jsonb_populate_record(null::meta.translation, e || jsonb_build_object('app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'translations', '[]')) e;
  insert into meta.report_layout
  select (jsonb_populate_record(null::meta.report_layout, (e - 'logo') || jsonb_build_object(
            'id', nextval('meta.report_layout_id_seq'), 'app_id', v_app_id,
            'logo', null))).*
    from jsonb_array_elements(coalesce(p_doc->'report_layouts', '[]')) e;
  update meta.report_layout l
     set logo = decode(e->>'logo', 'base64')
    from jsonb_array_elements(coalesce(p_doc->'report_layouts', '[]')) e
   where l.app_id = v_app_id and l.name = e->>'name' and e->>'logo' is not null;
  -- imported automations start switched off: the copy must not run the original's jobs unasked.
  -- (044) a file with actions: the automations' code is ignored; an older file: code becomes the single action
  insert into meta.automation
  select (jsonb_populate_record(null::meta.automation, '{"error_handling": "stop"}'::jsonb
            || jsonb_strip_nulls(case when p_doc ? 'automation_actions' then e - 'code' else e end)
            || jsonb_build_object('id', nextval('meta.automation_id_seq'), 'app_id', v_app_id, 'enabled', false))).*
    from jsonb_array_elements(coalesce(p_doc->'automations', '[]')) e;
  insert into meta.automation_action
  select (jsonb_populate_record(null::meta.automation_action, '{"seq": 10}'::jsonb || jsonb_strip_nulls(e)
            || jsonb_build_object('id', nextval('meta.automation_action_id_seq'), 'app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'automation_actions', '[]')) e;
  insert into meta.document_template
  select (jsonb_populate_record(null::meta.document_template, e || jsonb_build_object('id', nextval('meta.document_template_id_seq'), 'app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'document_templates', '[]')) e;
  insert into meta.task_definition
  select (jsonb_populate_record(null::meta.task_definition, e || jsonb_build_object('id', nextval('meta.task_definition_id_seq'), 'app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'task_definitions', '[]')) e;
  insert into meta.workflow_definition
  select (jsonb_populate_record(null::meta.workflow_definition, e || jsonb_build_object('id', nextval('meta.workflow_definition_id_seq'), 'app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'workflow_definitions', '[]')) e;
  insert into meta.rest_module
  select (jsonb_populate_record(null::meta.rest_module, e || jsonb_build_object('id', nextval('meta.rest_module_id_seq'), 'app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'rest_modules', '[]')) e;
  -- (028) template components: regions and report columns refer to them by static id
  insert into meta.template_component
  select (jsonb_populate_record(null::meta.template_component, e || jsonb_build_object('id', nextval('meta.template_component_id_seq'), 'app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'template_components', '[]')) e;
  -- (029) build options (components name them by name)
  insert into meta.build_option
  select (jsonb_populate_record(null::meta.build_option, e || jsonb_build_object('id', nextval('meta.build_option_id_seq'), 'app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'build_options', '[]')) e;
  -- (030) web credentials arrive without a secret, whatever the document holds
  insert into meta.web_credential
  select (jsonb_populate_record(null::meta.web_credential, '{"type": "basic", "valid_for": []}'::jsonb || jsonb_strip_nulls(e - 'secret_enc')
            || jsonb_build_object('id', nextval('meta.web_credential_id_seq'), 'app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'web_credentials', '[]')) e;
  insert into meta.rest_source
  select (jsonb_populate_record(null::meta.rest_source, '{"method": "GET", "headers": {}, "params": [], "columns": [], "cache_seconds": 0, "timeout_s": 10, "max_rows": 1000}'::jsonb
            || jsonb_strip_nulls(e) || jsonb_build_object('id', nextval('meta.rest_source_id_seq'), 'app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'rest_sources', '[]')) e;

  -- (041) data load definitions (the data_load process names them)
  insert into meta.data_load_def
  select (jsonb_populate_record(null::meta.data_load_def, '{"format": "auto", "headers": true, "mode": "append", "skip_errors": false, "columns": []}'::jsonb
            || jsonb_strip_nulls(e) || jsonb_build_object('id', nextval('meta.data_load_def_id_seq'), 'app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'data_load_definitions', '[]')) e;

  -- (042) lists and their entries, supporting scripts. Entries are inserted
  -- without a parent first and the parents set afterwards, so the order of
  -- the entries in the document doesn't matter (a moved entry may have a
  -- higher id than its children).
  insert into meta.list
  select (jsonb_populate_record(null::meta.list, '{"type": "static"}'::jsonb || jsonb_strip_nulls(e) || jsonb_build_object('id', nextval('meta.list_id_seq'), 'app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'lists', '[]')) e;
  for v_e in select * from jsonb_array_elements(coalesce(p_doc->'list_entries', '[]')) loop
    insert into meta.list_entry
    select (jsonb_populate_record(null::meta.list_entry, '{"target_items": {}}'::jsonb || jsonb_strip_nulls(v_e) || jsonb_build_object(
              'id', nextval('meta.list_entry_id_seq'), 'app_id', v_app_id, 'parent_id', null))).*
    returning id into v_new_id;
    if v_e->>'id' is not null then
      v_lmap := v_lmap || jsonb_build_object(v_e->>'id', v_new_id);
    end if;
  end loop;
  update meta.list_entry x
     set parent_id = (v_lmap->>(e->>'parent_id'))::int
    from jsonb_array_elements(coalesce(p_doc->'list_entries', '[]')) e
   where e->>'parent_id' is not null and v_lmap ? (e->>'parent_id') and v_lmap ? (e->>'id')
     and x.id = (v_lmap->>(e->>'id'))::int;
  insert into meta.supporting_script
  select (jsonb_populate_record(null::meta.supporting_script, '{"kind": "install", "seq": 10, "script": ""}'::jsonb || jsonb_strip_nulls(e)
            || jsonb_build_object('id', nextval('meta.supporting_script_id_seq'), 'app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'supporting_scripts', '[]')) e;

  for v_e in select * from jsonb_array_elements(coalesce(p_doc->'nav', '[]')) loop
    insert into meta.nav_entry
    select (jsonb_populate_record(null::meta.nav_entry, v_e || jsonb_build_object(
              'id', nextval('meta.nav_entry_id_seq'), 'app_id', v_app_id,
              'parent_id', v_nmap->>(v_e->>'parent_id')))).*
    returning id into v_new_id;
    v_nmap := v_nmap || jsonb_build_object(v_e->>'id', v_new_id);
  end loop;

  for v_page in select * from jsonb_array_elements(coalesce(p_doc->'pages', '[]')) loop
    insert into meta.page
    select (jsonb_populate_record(null::meta.page, v_page || jsonb_build_object('id', nextval('meta.page_id_seq'), 'app_id', v_app_id))).*
    returning id into v_page_id;

    v_rmap := '{}';
    for v_e in select * from jsonb_array_elements(coalesce(v_page->'regions', '[]')) loop
      insert into meta.region
      select (jsonb_populate_record(null::meta.region, v_e || jsonb_build_object('id', nextval('meta.region_id_seq'), 'page_id', v_page_id))).*
      returning id into v_new_id;
      v_rmap := v_rmap || jsonb_build_object(v_e->>'id', v_new_id);
    end loop;
    -- facet and map regions point at their report region by id
    update meta.region r
       set config = jsonb_set(r.config, '{report}', to_jsonb((v_rmap->>(r.config->>'report'))::int))
     where r.page_id = v_page_id and r.type in ('facets', 'smart_filters', 'map') and v_rmap ? (r.config->>'report');

    insert into meta.item
    select (jsonb_populate_record(null::meta.item, e || jsonb_build_object('id', nextval('meta.item_id_seq'), 'page_id', v_page_id, 'region_id', v_rmap->>(e->>'region_id')))).*
      from jsonb_array_elements(coalesce(v_page->'items', '[]')) e;
    insert into meta.button
    select (jsonb_populate_record(null::meta.button, e || jsonb_build_object('id', nextval('meta.button_id_seq'), 'page_id', v_page_id, 'region_id', v_rmap->>(e->>'region_id')))).*
      from jsonb_array_elements(coalesce(v_page->'buttons', '[]')) e;
    insert into meta.dynamic_action
    select (jsonb_populate_record(null::meta.dynamic_action, e || jsonb_build_object('id', nextval('meta.dynamic_action_id_seq'), 'page_id', v_page_id, 'affected_region_id', v_rmap->>(e->>'affected_region_id')))).*
      from jsonb_array_elements(coalesce(v_page->'dynamic_actions', '[]')) e;
    insert into meta.validation
    select (jsonb_populate_record(null::meta.validation, e || jsonb_build_object('id', nextval('meta.validation_id_seq'), 'page_id', v_page_id))).*
      from jsonb_array_elements(coalesce(v_page->'validations', '[]')) e;
    insert into meta.process
    select (jsonb_populate_record(null::meta.process, e || jsonb_build_object('id', nextval('meta.process_id_seq'), 'page_id', v_page_id, 'region_id', v_rmap->>(e->>'region_id')))).*
      from jsonb_array_elements(coalesce(v_page->'processes', '[]')) e;
    insert into meta.computation
    select (jsonb_populate_record(null::meta.computation, e || jsonb_build_object('id', nextval('meta.computation_id_seq'), 'page_id', v_page_id))).*
      from jsonb_array_elements(coalesce(v_page->'computations', '[]')) e;
    insert into meta.branch
    select (jsonb_populate_record(null::meta.branch, e || jsonb_build_object('id', nextval('meta.branch_id_seq'), 'page_id', v_page_id))).*
      from jsonb_array_elements(coalesce(v_page->'branches', '[]')) e;
  end loop;

  return v_app_id;
end
$$;
