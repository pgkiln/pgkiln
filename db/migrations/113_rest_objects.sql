-- ---------------------------------------------------------------------
-- 113: AutoREST (sprint 100, Database Actions DA-11 part 1; ORDS: REST ›
-- Enable on a table or view). SQL Workshop › RESTful Services publishes a
-- table or view through an application of the workspace:
--
--   /a/<alias>/autorest/<object>/            GET (paged, filters), POST
--   /a/<alias>/autorest/<object>/<key>       GET, PUT, DELETE (tables with a primary key)
--   /a/<alias>/autorest/openapi.json         the OpenAPI description of them all
--
-- The application decides how a request runs: its database role (never the
-- object's owner, a superuser or a role that bypasses row level security,
-- checked when the object is enabled and at every request), its tokens and
-- OAuth clients (App › REST API), its accounts' roles (meta.has_role) and
-- its availability. Without a bearer token an object answers 401 unless the
-- developer chose "public" for it explicitly.
--
-- The builder writes the rows as the owner; the runtime reads them.
-- Installation data like the application's OAuth clients: not exported (an
-- in-place import keeps them); the application's own REST modules are what
-- travels with an export.
-- ---------------------------------------------------------------------
create table meta.rest_object (
  id           int generated always as identity primary key,
  app_id       int  not null references meta.app on delete cascade,
  schema_name  text not null check (length(schema_name) between 1 and 63),
  object_name  text not null check (length(object_name) between 1 and 63),
  -- the URL segment: /a/<alias>/autorest/<alias>/
  alias        text not null check (alias ~ '^[a-z][a-z0-9_-]{0,62}$' and alias <> 'openapi.json'),
  methods      text[] not null default '{GET}' check (methods <@ '{GET,POST,PUT,DELETE}'::text[] and cardinality(methods) > 0),
  -- token: a bearer token of the application (default); public: no token needed, meta.app_user() = nobody
  auth         text not null default 'token' check (auth in ('token', 'public')),
  -- the caller needs one of these application roles (meta.has_role); empty: any caller the auth allows
  roles        text[] not null default '{}',
  page_size    int  not null default 25 check (page_size between 1 and 500),
  enabled      boolean not null default true,
  created_by   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (app_id, alias),
  unique (app_id, schema_name, object_name)
);
revoke all on meta.rest_object from public;
grant select on meta.rest_object to pgkiln_runtime;
-- isolated workspaces (090): a workspace's logins see the rows of their own applications only
alter table meta.rest_object enable row level security;
create policy workspace on meta.rest_object
  using ((select meta.isolation_off()) or app_id in (select meta.visible_apps()))
  with check ((select meta.isolation_off()) or app_id in (select meta.visible_apps()));
comment on table meta.rest_object is 'AutoREST (113): tables and views published through an application at /a/<alias>/autorest/<alias>/; installation data, not exported';
