-- =====================================================================
-- 098: activity reporting for an application's administrators (sprint 73;
-- APEX: the Activity Reporting feature of the Create Application wizard)
--
-- meta.app_activity(days): the page views, sign-ins and errors of the
-- current application (meta.app_id()) in the last days (1 to 366), newest
-- first, at most 10,000 rows. Only for a signed-in user with the admin role
-- whose session belongs to that application; anyone else gets an error.
-- The client's IP address and the error details are left out.
--
-- The wizard's Activity page (page 9010, authorization ADMIN) reads it:
--   select * from meta.app_activity(30)
-- =====================================================================
create function meta.app_activity(p_days int default 30)
returns table (at timestamptz, username text, event text, page_no int, elapsed_ms int)
language plpgsql stable security definer set search_path = meta, pg_catalog as $$
declare
  v_app     int := meta.app_id();
  v_session uuid := nullif(current_setting('pgkiln.session_id', true), '')::uuid;
begin
  if v_app is null or v_session is null
     or not exists (select 1 from meta.session s where s.id = v_session and s.app_id = v_app)
     or not meta.has_role('admin') then
    raise exception 'the activity of this application is for its administrators' using errcode = '42501';
  end if;
  return query
    select l.at, l.username, l.event, l.page_no, l.elapsed_ms
      from meta.activity_log l
     where l.app_id = v_app
       and l.at > now() - make_interval(days => least(greatest(coalesce(p_days, 30), 1), 366))
     order by l.at desc
     limit 10000;
end
$$;
revoke all on function meta.app_activity(int) from public;
grant execute on function meta.app_activity(int) to public;
comment on function meta.app_activity(int) is 'The current application''s activity (page views, sign-ins, errors) for its administrators (098).';
