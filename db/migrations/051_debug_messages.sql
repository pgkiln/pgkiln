-- Debug messages (APEX debug) and the install/upgrade log.
--
-- An application's debug level (0 = off, APEX levels 1 error, 2 warning,
-- 4 info, 6 trace, 9 everything) makes the runtime record, per request, a
-- "page view" (meta.debug_view) with timed entries (meta.debug_message):
-- the request's steps, regions and processes, errors, and the messages that
-- application SQL writes with meta.debug(level, text). With the level at 0
-- nothing is recorded and meta.debug() returns at once.
--
-- meta.debug() does not write to a table: it raises a NOTICE (marked with
-- the detail 'pgapex.debug') that the runtime collects on its connection, so
-- messages from a statement that fails or a transaction that rolls back are
-- kept too. The runtime stores a request's entries after the response with
-- meta.debug_save() (security definer, pgapex_runtime only); application
-- roles can neither read nor write the debug tables.

alter table meta.app
  add column debug_level smallint not null default 0 check (debug_level in (0, 1, 2, 4, 6, 9)),
  add column debug_retention_days int not null default 7 check (debug_retention_days between 1 and 90);

comment on column meta.app.debug_level is
  'Debug messages: 0 off, 1 errors, 2 warnings, 4 information, 6 trace, 9 everything (with item values; never password items)';
comment on column meta.app.debug_retention_days is 'Days debug messages are kept (1–90)';

create table meta.debug_view (
  id          bigint generated always as identity primary key,
  app_id      int not null references meta.app on delete cascade,
  page_no     int,
  username    text,
  session_id  uuid,
  method      text not null,
  -- the path without its query string (query values can carry item values)
  path        text not null,
  status      int,
  level       smallint not null,
  started_at  timestamptz not null default now(),
  elapsed_ms  numeric(10, 1),
  entries     int not null default 0
);
create index on meta.debug_view (app_id, id desc);
create index on meta.debug_view (started_at);

create table meta.debug_message (
  view_id     bigint not null references meta.debug_view on delete cascade,
  seq         int not null,
  -- since the start of the request
  elapsed_ms  numeric(10, 1) not null,
  -- of a timed step (a region, a process), else null
  duration_ms numeric(10, 1),
  level       smallint not null,
  component   text,
  message     text not null,
  primary key (view_id, seq)
);

comment on table meta.debug_view is 'Debug messages: one row per request of an application in debug (installation data, not exported)';
comment on table meta.debug_message is 'Debug messages: the timed entries of a request (meta.debug_view)';

-- The request's debug level (0 when debug is off or outside a request).
create function meta.debug_level() returns int
language sql stable as $$
  select case when s ~ '^[0-9]$' then s::int else 0 end
    from coalesce(current_setting('pgapex.debug_level', true), '') as s
$$;

-- Whether a message of this level would be recorded: to skip building expensive texts.
create function meta.debug_enabled(p_level int default 4) returns boolean
language sql stable as $$
  select coalesce(p_level, 4) between 1 and meta.debug_level()
$$;

-- Write a debug message (APEX: apex_debug.message). Levels: 1 error,
-- 2 warning, 4 information, 6 trace, 9 everything.
create function meta.debug(p_level int, p_text text) returns void
language plpgsql as $$
begin
  if p_text is null or p_level is null or p_level < 1 or p_level > meta.debug_level() then
    return;
  end if;
  raise notice using message = left(p_text, 4000), detail = 'pgapex.debug', hint = p_level::text;
end
$$;

create function meta.debug(p_text text) returns void
language sql as $$ select meta.debug(4, p_text) $$;

grant execute on function meta.debug_level(), meta.debug_enabled(int), meta.debug(int, text), meta.debug(text) to public;

-- Store one request's entries (called by the runtime after the response) and,
-- now and then, purge what is older than each application's retention.
create function meta.debug_save(p_app_id int, p_page_no int, p_username text, p_session_id uuid, p_method text, p_path text,
                                p_status int, p_level int, p_started_at timestamptz, p_elapsed_ms numeric, p_entries jsonb)
returns bigint
language plpgsql security definer set search_path = meta, pg_catalog as $$
declare
  v_id bigint;
  v_level int;
begin
  -- only for an application that is in debug now
  select debug_level into v_level from meta.app where id = p_app_id;
  if coalesce(v_level, 0) = 0 then
    return null;
  end if;
  insert into meta.debug_view (app_id, page_no, username, session_id, method, path, status, level, started_at, elapsed_ms, entries)
  values (p_app_id, p_page_no, left(p_username, 200), p_session_id, left(p_method, 10), left(p_path, 500), p_status,
          least(greatest(coalesce(p_level, v_level), 1), 9), coalesce(p_started_at, now()), p_elapsed_ms,
          least(coalesce(jsonb_array_length(p_entries), 0), 2000))
  returning id into v_id;
  insert into meta.debug_message (view_id, seq, elapsed_ms, duration_ms, level, component, message)
  select v_id, e.ord::int, coalesce((e.v->>'ms')::numeric(10, 1), 0), (e.v->>'dur')::numeric(10, 1),
         least(greatest(coalesce((e.v->>'level')::int, 4), 1), 9), left(e.v->>'component', 100), left(coalesce(e.v->>'text', ''), 4000)
    from jsonb_array_elements(coalesce(p_entries, '[]')) with ordinality as e(v, ord)
   where e.ord <= 2000;
  if random() < 0.02 then
    perform meta.debug_purge();
  end if;
  return v_id;
end
$$;

-- Delete page views older than their application's retention, and keep at
-- most 5000 per application. Returns the number of page views deleted.
create function meta.debug_purge() returns int
language plpgsql security definer set search_path = meta, pg_catalog as $$
declare
  n int;
  m int;
begin
  delete from meta.debug_view v using meta.app a
   where a.id = v.app_id and v.started_at < now() - make_interval(days => a.debug_retention_days);
  get diagnostics n = row_count;
  delete from meta.debug_view v
   where v.id in (select id from (select id, row_number() over (partition by app_id order by id desc) as rn from meta.debug_view) x where x.rn > 5000);
  get diagnostics m = row_count;
  return n + m;
end
$$;

revoke all on function meta.debug_save(int, int, text, uuid, text, text, int, int, timestamptz, numeric, jsonb) from public;
revoke all on function meta.debug_purge() from public;
grant execute on function meta.debug_save(int, int, text, uuid, text, text, int, int, timestamptz, numeric, jsonb) to pgapex_runtime;
grant execute on function meta.debug_purge() to pgapex_runtime;
