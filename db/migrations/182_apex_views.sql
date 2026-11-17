-- =====================================================================
-- 182: APEX's dictionary views, read-only, over pgkiln's own tables
--      (sprint 217, NX-F5 follow-up)
--
-- An APEX application's administration pages (Access control, Activity,
-- Feedback, Automations, Build options …: in f77536 the pages 10000 and
-- up) read APEX's views: apex_activity_log, apex_appl_acl_users,
-- apex_application_pages … Schema apex has the ones those pages use,
-- with APEX 26.2's names and the columns pgkiln has data for, so that
-- the imported pages show data. The importer qualifies the names
-- (apex_activity_log → apex.apex_activity_log); hand-written SQL does
-- the same or puts apex on its search path.
--
-- Rows: at run time only the running application's (meta.app_id());
-- in the SQL Workshop a workspace's developer login sees its own
-- workspace's applications; pgkiln's owner every application; any
-- other login nothing. No password hashes, secrets or session ids.
--
-- Read-only: APEX's APIs that change these (apex_acl, apex_util
-- .set_build_option_status, apex_theme …) stay PL/SQL to port.
-- =====================================================================

create schema apex;
comment on schema apex is
  'APEX dictionary views (apex_activity_log, apex_appl_acl_users …) over pgkiln''s tables, read-only (migration 182)';
grant usage on schema apex to public;

-- which applications the caller may see in these views
create function meta.apex_view_app(p_app_id int) returns boolean
language sql stable security definer set search_path = meta, pg_catalog as $$
  select case
           when meta.app_id() is not null then p_app_id = meta.app_id()
           when meta.owner_login() then true
           when meta.login_workspace() is not null then meta.app_workspace(p_app_id) = meta.login_workspace()
           else false
         end
$$;
grant execute on function meta.apex_view_app(int) to public;

-- a role's id: stable for an application and role name (APEX numbers its roles)
create function meta.apex_role_id(p_app_id int, p_role text) returns bigint
language sql immutable as $$ select abs(hashtextextended(p_app_id || ':' || lower(p_role), 0)) % 1000000000000 $$;
grant execute on function meta.apex_role_id(int, text) to public;

-- ---------------------------------------------------------------------
-- applications and pages
-- ---------------------------------------------------------------------
create view apex.apex_applications with (security_barrier) as
  select coalesce(w.name, 'DEFAULT') as workspace, a.id as application_id, a.name as application_name,
         upper(a.alias) as alias, upper(a.db_role) as owner, a.version, a.home_page, a.login_page,
         a.authentication as authentication_scheme, a.build_status, a.availability as availability_status,
         a.created_at::timestamp as created_on, a.updated_at::timestamp as last_updated_on,
         42 as theme_number, 'No'::text as theme_style_by_user_pref,
         (select count(*) from meta.page p where p.app_id = a.id) as pages
    from meta.app a left join meta.workspace w on w.id = meta.app_workspace(a.id)
   where meta.apex_view_app(a.id);

create view apex.apex_application_pages with (security_barrier) as
  select coalesce(w.name, 'DEFAULT') as workspace, a.id as application_id, a.name as application_name,
         p.page_no as page_id, p.name as page_name, p.alias as page_alias, p.title as page_title,
         p.page_group, case p.mode when 'modal' then 'Modal Dialog' when 'nonmodal' then 'Non-Modal Dialog' else 'Normal' end as page_mode,
         case when p.requires_auth then 'Yes' else 'No' end as page_requires_authentication,
         p.authz as authorization_scheme, p.build_option, p.help as help_text, p.id as page_component_id
    from meta.page p join meta.app a on a.id = p.app_id left join meta.workspace w on w.id = meta.app_workspace(a.id)
   where meta.apex_view_app(p.app_id);

create view apex.apex_application_build_options with (security_barrier) as
  select a.id as application_id, a.name as application_name, b.id as build_option_id, b.name as build_option_name,
         case b.status when 'include' then 'Include' else 'Exclude' end as build_option_status,
         b.description as component_comment
    from meta.build_option b join meta.app a on a.id = b.app_id
   where meta.apex_view_app(b.app_id);

-- a static list of values (STATIC:Display;Return,…): one row per entry; a query's entries are its rows, not here
create view apex.apex_application_lov_entries with (security_barrier) as
  select a.id as application_id, a.name as application_name, l.name as list_of_values_name, l.id as lov_id,
         e.n::int * 10 as display_sequence, split_part(e.entry, ';', 1) as display_value,
         case when strpos(e.entry, ';') > 0 then substr(e.entry, strpos(e.entry, ';') + 1) else e.entry end as return_value
    from meta.lov l join meta.app a on a.id = l.app_id,
         regexp_split_to_table(substr(l.query, 8), ',') with ordinality e(entry, n)
   where l.query ilike 'STATIC:%' and meta.apex_view_app(l.app_id);

-- APEX's Universal Theme is theme 42; pgkiln has one theme per application, with its base style
create view apex.apex_application_themes with (security_barrier) as
  select a.id as application_id, a.name as application_name, 42 as theme_number, 'Universal Theme'::text as theme_name,
         'Yes'::text as is_current
    from meta.app a
   where meta.apex_view_app(a.id);

create view apex.apex_application_theme_styles with (security_barrier) as
  -- pgkiln's base styles (src/runtime/styles.ts BASE_STYLES; theme->>'base', standard unless iris or lavender)
  select a.id as application_id, 42 as theme_number, s.n::int as theme_style_id, s.label as name,
         case when s.style = case when a.theme->>'base' in ('iris', 'lavender') then a.theme->>'base' else 'standard' end
              then 'Yes' else 'No' end as is_current,
         'Yes'::text as is_public
    from meta.app a,
         unnest(array['standard', 'iris', 'lavender'], array['Standard', 'Iris', 'Lavender']) with ordinality s(style, label, n)
   where meta.apex_view_app(a.id);

-- ---------------------------------------------------------------------
-- activity
-- ---------------------------------------------------------------------
-- page views and errors (APEX logs a row per page request); time_stamp is a DATE in APEX: here a timestamp in the
-- session's time zone, so that sysdate (→ localtimestamp(0)) compares with it; elap in seconds
create view apex.apex_activity_log with (security_barrier) as
  select coalesce(w.name, 'DEFAULT') as workspace, l.app_id as flow_id, a.name as application_name, l.page_no as step_id,
         l.at::timestamp(0) as time_stamp, l.username as userid, lower(l.username) as userid_lc, l.ip as ip_address,
         l.elapsed_ms / 1000.0 as elap, case when l.event = 'error' then l.detail end as sqlerrm,
         null::text as sqlerrm_component_type, null::text as sqlerrm_component_name,
         'D'::text as page_mode, l.event as component_type, null::text as component_name, null::int as num_rows,
         null::text as ir_search, l.detail as information, l.id as log_id,
         -- pgkiln's log has no session (a session id is a secret): every row its own
         l.id as session_id
    from meta.activity_log l join meta.app a on a.id = l.app_id left join meta.workspace w on w.id = meta.app_workspace(a.id)
   where l.event in ('page_view', 'error') and meta.apex_view_app(l.app_id);

-- APEX's feedback status numbers (its FEEDBACK_STATUS list of values): 0 no action (declined), 1 acknowledged (in
-- progress), 3 open, 4 closed (done)
create view apex.apex_team_feedback with (security_barrier) as
  select coalesce(w.name, 'DEFAULT') as workspace, f.id as feedback_id, f.app_id as application_id, a.name as application_name,
         f.page_no as page_id, p.name as page_name, f.body as feedback, f.kind as feedback_type,
         -- pgkiln's rating is 1 to 5, APEX's 1 (negative) to 3 (positive)
         case when f.rating is null then null when f.rating <= 2 then 1 when f.rating = 3 then 2 else 3 end as feedback_rating,
         case f.status when 'open' then 3 when 'in_progress' then 1 when 'done' then 4 when 'declined' then 0 end as feedback_status,
         f.response as public_response, f.username as created_by, f.created_at::timestamp(0) as created_on,
         coalesce(f.responded_at, f.created_at)::timestamp(0) as updated_on, f.responded_by as updated_by,
         f.user_agent as http_user_agent
    from meta.feedback f join meta.app a on a.id = f.app_id
         left join meta.page p on p.app_id = f.app_id and p.page_no = f.page_no
         left join meta.workspace w on w.id = meta.app_workspace(a.id)
   where meta.apex_view_app(f.app_id);

-- ---------------------------------------------------------------------
-- access control: the roles an application uses (role authorization schemes, identity-provider group mappings and
-- the roles of its users) and its users
-- ---------------------------------------------------------------------
create view apex.apex_appl_acl_roles with (security_barrier) as
  with r as (
    select s.app_id, lower(s.value) as role from meta.authz_scheme s where s.type = 'role' and s.value <> ''
    union select g.app_id, lower(g.role) from meta.app_group_role g
    union select aa.app_id, lower(x) from meta.app_access aa, unnest(aa.roles) x where x <> '')
  select coalesce(w.name, 'DEFAULT') as workspace, r.app_id as application_id, a.name as application_name,
         meta.apex_role_id(r.app_id, r.role) as role_id, upper(r.role) as role_static_id,
         initcap(replace(r.role, '_', ' ')) as role_name, null::text as role_desc
    from r join meta.app a on a.id = r.app_id left join meta.workspace w on w.id = meta.app_workspace(a.id)
   where meta.apex_view_app(r.app_id);

create view apex.apex_appl_acl_user_roles with (security_barrier) as
  select coalesce(w.name, 'DEFAULT') as workspace, aa.app_id as application_id, a.name as application_name,
         upper(ac.username) as user_name, lower(ac.username) as user_name_lc,
         meta.apex_role_id(aa.app_id, x) as role_id, upper(x) as role_static_id, initcap(replace(lower(x), '_', ' ')) as role_name
    from meta.app_access aa join meta.account ac on ac.id = aa.account_id join meta.app a on a.id = aa.app_id
         left join meta.workspace w on w.id = meta.app_workspace(a.id), unnest(aa.roles) x
   where x <> '' and meta.apex_view_app(aa.app_id);

create view apex.apex_appl_acl_users with (security_barrier) as
  select coalesce(w.name, 'DEFAULT') as workspace, aa.app_id as application_id, a.name as application_name,
         ac.id, upper(ac.username) as user_name, lower(ac.username) as user_name_lc,
         (select string_agg(meta.apex_role_id(aa.app_id, x)::text, ':' order by lower(x)) from unnest(aa.roles) x where x <> '') as role_ids,
         (select string_agg(upper(x), ':' order by lower(x)) from unnest(aa.roles) x where x <> '') as role_static_ids,
         (select string_agg(initcap(replace(lower(x), '_', ' ')), ', ' order by lower(x)) from unnest(aa.roles) x where x <> '') as role_names
    from meta.app_access aa join meta.account ac on ac.id = aa.account_id join meta.app a on a.id = aa.app_id
         left join meta.workspace w on w.id = meta.app_workspace(a.id)
   where meta.apex_view_app(aa.app_id);

-- ---------------------------------------------------------------------
-- automations and their runs
-- ---------------------------------------------------------------------
create view apex.apex_appl_automations with (security_barrier) as
  select x.app_id as application_id, a.name as application_name, x.id as automation_id, x.name,
         upper(regexp_replace(x.name, '\W+', '_', 'g')) as static_id, 'POLLING'::text as trigger_type,
         x.schedule as polling_interval, case when x.enabled then 'ACTIVE' else 'DISABLED' end as polling_status,
         x.last_run_at::timestamp(0) as polling_last_run_timestamp, x.next_run_at::timestamp(0) as polling_next_run_timestamp,
         x.last_status
    from meta.automation x join meta.app a on a.id = x.app_id
   where meta.apex_view_app(x.app_id);

create view apex.apex_automation_log with (security_barrier) as
  select l.id, l.automation_id, x.name as automation_name, x.app_id as application_id,
         l.started_at::timestamp(0) as start_timestamp, l.finished_at::timestamp(0) as end_timestamp,
         case l.status when 'ok' then 'SUCCESS' when 'error' then 'FAILURE' when 'warning' then 'SUCCESS_WITH_ERRORS'
                       when 'running' then 'RUNNING' else upper(l.status) end as status,
         coalesce(l.rows, 0) - coalesce(l.rows_failed, 0) as successful_row_count, coalesce(l.rows_failed, 0) as error_row_count,
         'N'::text as is_job, l.trigger, l.run_by
    from meta.automation_log l join meta.automation x on x.id = l.automation_id
   where meta.apex_view_app(x.app_id);

-- the run's message and its row errors (meta.automation_log.errors: {row, action, message, values} per failed row)
create view apex.apex_automation_msg_log with (security_barrier) as
  select l.id * 1000 as id, l.id as automation_log_id, x.app_id as application_id, coalesce(l.finished_at, l.started_at)::timestamp(0) as message_timestamp,
         case when l.status = 'error' then 'ERROR' else 'INFO' end as message_type, l.message, null::text as pk_value
    from meta.automation_log l join meta.automation x on x.id = l.automation_id
   where l.message is not null and meta.apex_view_app(x.app_id)
  union all
  select l.id * 1000 + e.n, l.id, x.app_id, coalesce(l.finished_at, l.started_at)::timestamp(0), 'ERROR',
         concat_ws(': ', e.v->>'action', e.v->>'message'), coalesce(e.v->>'values', e.v->>'row')
    from meta.automation_log l join meta.automation x on x.id = l.automation_id,
         jsonb_array_elements(case when jsonb_typeof(l.errors) = 'array' then l.errors else '[]' end) with ordinality e(v, n)
   where meta.apex_view_app(x.app_id);

grant select on all tables in schema apex to public;
