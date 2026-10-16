-- ---------------------------------------------------------------------
-- 117: RESTful Services modules, templates and handlers (sprint 104,
-- Database Actions DA-11 part 2; ORDS: REST › Modules). SQL Workshop ›
-- RESTful Services edits an application's REST modules (024) as ORDS does:
-- a module (its base path), its templates (URIs with :parameters) and their
-- handlers (method and source type: collection query, single row, SQL,
-- PL/pgSQL, media).
--
-- The handlers stay in meta.rest_module.handlers (jsonb), so modules travel
-- with the application's export as before (export_app takes the whole row:
-- the new columns go along without redefining it). New here:
--
--   roles      the module's privilege: a caller needs one of these
--              application roles (meta.has_role) for every handler of the
--              module, on top of a handler's own roles
--   templates  [{"uri": "emp/:id", "description": "…"}]: a template can
--              exist before its first handler, and its description goes
--              into the OpenAPI document
--
-- PL/pgSQL handlers run their block as an anonymous DO block as the
-- application's database role. A DO block takes no parameters, so the
-- request's binds are set as transaction-local settings (query parameters:
-- never part of the SQL text) and :NAME in the block reads them through
-- meta.rest_param('NAME'); meta.rest_reply(body, status) sets the response.
-- ---------------------------------------------------------------------
alter table meta.rest_module
  add column roles text[] not null default '{}',
  add column templates jsonb not null default '[]' check (jsonb_typeof(templates) = 'array');

-- an export from before 117 has no "roles" or "templates": jsonb_populate_record gives NULL, the default applies
create function meta.rest_module_defaults() returns trigger
language plpgsql set search_path = pg_catalog as $$
begin
  new.roles := coalesce(new.roles, '{}');
  new.templates := coalesce(new.templates, '[]');
  return new;
end $$;
create trigger rest_module_defaults before insert or update on meta.rest_module
  for each row execute function meta.rest_module_defaults();

-- A bind of the REST request a PL/pgSQL handler runs for (NULL when the request has none).
create function meta.rest_param(p_name text) returns text
language sql stable set search_path = pg_catalog as $$
  select nullif(current_setting('pgkiln_bind.' || lower(p_name), true), '')
$$;
comment on function meta.rest_param(text) is 'REST handlers (117): a bind of the request (path, query or body parameter; BODY is the JSON body); :NAME in a PL/pgSQL handler reads it';

-- The response of a PL/pgSQL REST handler: a JSON body and an optional HTTP status (200-599).
create function meta.rest_reply(p_body jsonb, p_status int default null) returns void
language plpgsql set search_path = pg_catalog as $$
begin
  if p_status is not null and (p_status < 200 or p_status > 599) then
    raise exception 'meta.rest_reply: the status is 200 to 599, not %', p_status;
  end if;
  perform set_config('pgkiln_rest.body', coalesce(p_body::text, ''), true);
  perform set_config('pgkiln_rest.status', coalesce(p_status::text, ''), true);
end $$;
comment on function meta.rest_reply(jsonb, int) is 'REST handlers (117): the JSON response of a PL/pgSQL handler and its status';

grant execute on function meta.rest_param(text), meta.rest_reply(jsonb, int) to public;

comment on column meta.rest_module.roles is 'The module''s privilege (117): the caller needs one of these application roles for every handler';
comment on column meta.rest_module.templates is 'Templates (117): [{"uri": "emp/:id", "description": "…"}]; handlers name their template in "path"';
