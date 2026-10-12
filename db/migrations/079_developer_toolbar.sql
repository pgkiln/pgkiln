-- =====================================================================
-- 079: the developer toolbar (APEX: Runtime Developer Toolbar) and the
-- session state viewer
--
-- A builder session hands the browser a second, random token in the cookie
-- pgkiln_devbar (path /a, HttpOnly). Pages of an application show the
-- developer toolbar when that token belongs to a live builder session of a
-- developer who may open the application (src/runtime/devbar.ts). The token
-- only shows the toolbar: it is not the builder session's token.
-- =====================================================================

alter table meta.session add column devbar_hash text;
create unique index session_devbar_hash on meta.session (devbar_hash) where devbar_hash is not null;

comment on column meta.session.devbar_hash is 'Builder sessions: sha256 of the developer toolbar token (079)';

-- Debug messages of a session the toolbar put in debug (state __DEBUG_LEVEL, set only by
-- POST /a/<alias>/<page>/devbar/debug for a developer) are stored even when the
-- application is not in debug. Same as 051 otherwise.
create or replace function meta.debug_save(p_app_id int, p_page_no int, p_username text, p_session_id uuid, p_method text, p_path text,
                                p_status int, p_level int, p_started_at timestamptz, p_elapsed_ms numeric, p_entries jsonb)
returns bigint
language plpgsql security definer set search_path = meta, pg_catalog as $$
declare
  v_id bigint;
  v_level int;
begin
  -- only for an application that is in debug now, or (079) a session the developer toolbar put in debug
  select debug_level into v_level from meta.app where id = p_app_id;
  if coalesce(v_level, 0) = 0 then
    select (s.state->>'__DEBUG_LEVEL')::int into v_level
      from meta.session s
     where s.id = p_session_id and s.app_id = p_app_id and s.state->>'__DEBUG_LEVEL' in ('1', '2', '4', '6', '9');
  end if;
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
