-- =====================================================================
-- 083: application availability and build status (APEX: Application
-- Availability and Build Status)
--
-- meta.app.availability:
--   available   everyone who may sign in (the default)
--   developers  only developers with a builder session in the same browser
--               (the developer toolbar's token, migration 079)
--   restricted  only the users in availability_users (and developers)
--   unavailable nobody: every page shows availability_message (or a default)
-- Pages, file downloads, REST modules and PostgREST (meta.api_check) follow
-- it; automations, workflows, background jobs and queued mail keep running.
--
-- meta.app.build_status 'run_only': the builder refuses changes to the
-- application (as if it were locked), except to its availability and build
-- status. The command line's import --replace (deployment) still works.
--
-- Both belong to the installation: export_app leaves them out (redefined from
-- 081), an import of a new application gets the defaults, and an import over
-- an application keeps its values (src/cli/replace.ts).
-- =====================================================================

alter table meta.app
  add column availability text not null default 'available' check (availability in ('available', 'developers', 'restricted', 'unavailable')),
  add column availability_message text check (length(availability_message) <= 2000),
  add column availability_users text[] not null default '{}',
  add column build_status text not null default 'run_and_build' check (build_status in ('run_and_build', 'run_only'));

-- an export has none of these: NULL becomes the default
create function meta.app_availability_default() returns trigger
language plpgsql set search_path = pg_catalog as $$
begin
  new.availability := coalesce(new.availability, 'available');
  new.availability_users := coalesce(new.availability_users, '{}');
  new.build_status := coalesce(new.build_status, 'run_and_build');
  return new;
end $$;
create trigger app_availability before insert or update on meta.app
  for each row execute function meta.app_availability_default();

comment on column meta.app.availability is 'available, developers, restricted or unavailable (083)';
comment on column meta.app.build_status is 'run_and_build, or run_only: the builder refuses changes (083)';

-- ---------------------------------------------------------------- export
-- Same as 081, without the availability and build status.
create or replace function meta.export_app(p_alias text) returns jsonb
language sql stable set search_path = meta, pg_catalog as $$
  select jsonb_build_object(
    'format', 'pgkiln/2',
    -- (083) availability and build status belong to the installation
    'app', to_jsonb(a) - 'id' - 'created_at' - 'updated_at' - 'availability' - 'availability_message' - 'availability_users' - 'build_status',
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
    -- (050) nor do the password and refresh token of the OAuth2 flows, or the token state
    'web_credentials', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' - 'secret_enc' - 'password_enc' - 'refresh_token_enc' - 'token_refreshed_at' order by x.name)
                                   from meta.web_credential x where x.app_id = a.id), '[]'),
    -- (050) the synchronisation's state (next and last run) belongs to the installation
    'rest_sources', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' - 'sync_next_at' - 'sync_last_at' - 'sync_last_status' order by x.name)
                                from meta.rest_source x where x.app_id = a.id), '[]'),
    -- (041) data load definitions
    'data_load_definitions', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.name) from meta.data_load_def x where x.app_id = a.id), '[]'),
    -- (042) lists; entries keep their ids so parents can be remapped on import
    'lists', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.name) from meta.list x where x.app_id = a.id), '[]'),
    'list_entries', coalesce((select jsonb_agg(to_jsonb(x) - 'app_id' order by x.list_name, x.parent_id nulls first, x.seq, x.id) from meta.list_entry x where x.app_id = a.id), '[]'),
    -- (042) supporting objects: install, upgrade and deinstall scripts (never run on import)
    'supporting_scripts', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.name) from meta.supporting_script x where x.app_id = a.id), '[]'),
    -- (069) plug-ins (their files are static files, their templates template components)
    'plugins', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.name) from meta.plugin x where x.app_id = a.id), '[]'),
    -- (080) search configurations
    'search_configs', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.name) from meta.search_config x where x.app_id = a.id), '[]'),
    -- (081) e-mail templates
    'email_templates', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.name) from meta.email_template x where x.app_id = a.id), '[]'),
    -- (068) static application files (JavaScript, CSS, images, fonts) as base64
    'static_files', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' - 'content' - 'updated_at' || jsonb_build_object('content', translate(encode(x.content, 'base64'), E'\n', '')) order by x.name)
                                from meta.static_file x where x.app_id = a.id), '[]'),
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

-- ---------------------------------------------------------------- PostgREST
-- Same as 011, plus the application's availability.
create or replace function meta.api_check() returns void
language plpgsql stable security definer set search_path = meta, pg_catalog as $$
declare
  v_claims jsonb := meta.jwt_claims();
  v_role   text := current_setting('role', true);   -- the SET ROLE PostgREST did
  v_app    meta.app;
  v_acc    meta.account;
begin
  if v_claims is null or v_role is null or v_role in ('none', 'pgkiln_anon') then
    return;
  end if;
  select * into v_app from meta.app a where a.alias = v_claims->>'app';
  if not found or v_app.api_role is distinct from v_role then
    raise exception 'This token is not valid for an application with API role %.', v_role
      using errcode = 'PT401';
  end if;
  -- (083) the application's availability: unavailable or for developers only answers 503;
  -- restricted only for the users it names (never for an OAuth client)
  if v_app.availability in ('unavailable', 'developers') then
    raise exception '%', coalesce(nullif(v_app.availability_message, ''), 'The application is not available at the moment.') using errcode = 'PT503';
  end if;
  if v_app.availability = 'restricted'
     and (v_claims ? 'client_id' or not lower(meta.app_user()) = any (select lower(u) from unnest(v_app.availability_users) u)) then
    raise exception 'The application is not available to this account at the moment.' using errcode = 'PT403';
  end if;
  if v_claims ? 'client_id' then
    if not exists (select 1 from meta.api_client c
                    where c.client_id = v_claims->>'client_id' and c.app_id = v_app.id and c.active) then
      raise exception 'The OAuth client of this token does not exist or was revoked.' using errcode = 'PT401';
    end if;
    return;
  end if;
  select * into v_acc from meta.account ac where lower(ac.username) = lower(meta.app_user());
  if not found or not v_acc.active then
    raise exception 'The account of this token does not exist or is inactive.' using errcode = 'PT403';
  end if;
  if v_app.access_control <> 'any_user'
     and not exists (select 1 from meta.app_access aa where aa.app_id = v_app.id and aa.account_id = v_acc.id) then
    raise exception 'The account of this token has no access to the application.' using errcode = 'PT403';
  end if;
end
$$;
