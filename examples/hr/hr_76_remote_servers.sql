-- =====================================================================
-- HR example, part 76: a remote server and a static workspace file
-- (sprint 141, AP-7; migration 141; docs/guide/19-rest-data-sources.md
--  "Remote servers", docs/guide/16-files.md "Static workspace files")
--
-- Remote server CRM (Workspace utilities → Remote servers) stands for the
-- web service of part 23: the HR example's own REST API on
-- http://127.0.0.1:3100. The REST data sources DEPARTMENTS, DEPARTMENT and
-- EMPLOYEES_API now name the server and keep only their path
-- (/a/hr/rest/v1/departments, ...). Moving the API to another host changes
-- one value: the server's base URL, e.g. https://crm.example.com, or the
-- server's environment variable PGKILN_SERVER_CRM, which wins when it is
-- set (one value per environment: development, test, production). Every
-- source on the server follows at once; the new host must still be on the
-- allow-list (PGKILN_REST_ALLOWED_HOSTS) and the workspace's network
-- access list.
--
-- brand.css is a static workspace file: every application of the
-- workspace may load it. HR loads it on every page as
-- #WORKSPACE_FILES#brand.css (Shared Components → Static application
-- files → Every page loads); another application of the workspace adds the
-- same line to share the styles.
-- =====================================================================

insert into meta.remote_server (workspace_id, static_id, name, description, base_url, env_var)
select meta.app_workspace(a.id), 'CRM', 'HR API (CRM)',
       'The HR example''s REST API, served by this pgkiln server. Set PGKILN_SERVER_CRM on another environment.',
       'http://127.0.0.1:3100', 'PGKILN_SERVER_CRM'
  from meta.app a where a.alias = 'hr'
on conflict (workspace_id, static_id) do nothing;

update meta.rest_source s
   set server = 'CRM', url = substr(s.url, length('http://127.0.0.1:3100') + 1)
  from meta.app a
 where a.id = s.app_id and a.alias = 'hr' and s.server is null
   and s.name in ('DEPARTMENTS', 'DEPARTMENT', 'EMPLOYEES_API') and s.url like 'http://127.0.0.1:3100/%';

insert into meta.workspace_file (workspace_id, name, mime, content)
select meta.app_workspace(a.id), 'brand.css', 'text/css', convert_to($css$/* A static workspace file (Workspace utilities → Static workspace files):
   the applications of the workspace load it as #WORKSPACE_FILES#brand.css. */
.region-header h2 { letter-spacing: .01em; }
.ws-brand { color: var(--accent, #2b62c4); font-weight: 600; }
$css$, 'utf8')
  from meta.app a where a.alias = 'hr'
on conflict (workspace_id, name) do nothing;

update meta.app set static_includes = static_includes || '{#WORKSPACE_FILES#brand.css}'
 where alias = 'hr' and not ('#WORKSPACE_FILES#brand.css' = any (static_includes));
