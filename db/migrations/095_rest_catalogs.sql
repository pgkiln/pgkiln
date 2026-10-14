-- =====================================================================
-- 095: REST source catalogs (APEX: Workspace Utilities → REST Source
-- Catalogs)
--
-- A catalog describes one web service for a workspace: its base URL and
-- its services (an endpoint each: path with {parameters}, method,
-- parameters, row selector, columns, write-back operations). Developers of
-- the workspace create a REST data source in any of its applications from a
-- catalog service, so the service is described once, not in every
-- application. A catalog is entered by hand or read from an OpenAPI 3 (or
-- Swagger 2) document.
--
-- A data source made from a catalog is a copy (meta.rest_source): changing
-- the catalog later doesn't change it. Credentials stay with the
-- application (web credentials), never in a catalog.
--
-- Workspace data: not part of an application's export; the workspace
-- export (Workspace utilities → Export) carries the catalogs.
-- =====================================================================
create table meta.rest_catalog (
  id           serial primary key,
  workspace_id int  not null references meta.workspace on delete cascade,
  name         text not null check (name ~ '^\S(.{0,58}\S)?$'),
  description  text check (length(description) <= 2000),
  -- e.g. https://api.example.com/v1 (no trailing slash: service paths start with /)
  base_url     text not null check (base_url ~ '^https?://[^\s<>"{}]+$' and base_url !~ '/$' and length(base_url) <= 2000),
  -- where it came from: by hand, or an OpenAPI document (its title and version are kept)
  source       text not null default 'manual' check (source in ('manual', 'openapi')),
  api_version  text check (length(api_version) <= 100),
  created_by   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create unique index rest_catalog_name_key on meta.rest_catalog (workspace_id, lower(name));

create table meta.rest_catalog_service (
  id           serial primary key,
  catalog_id   int  not null references meta.rest_catalog on delete cascade,
  -- the REST data source's name when one is made from it
  name         text not null check (name ~ '^[A-Z][A-Z0-9_]{0,59}$'),
  description  text check (length(description) <= 2000),
  -- after the catalog's base URL, e.g. /cities/{city}/weather?units=metric
  path         text not null check (path ~ '^/[^\s<>"]*$' and length(path) <= 2000),
  method       text not null default 'GET' check (method in ('GET', 'POST', 'PUT', 'PATCH', 'DELETE')),
  -- as meta.rest_source (030, 036)
  params       jsonb not null default '[]' check (jsonb_typeof(params) = 'array'),
  headers      jsonb not null default '{}' check (jsonb_typeof(headers) = 'object'),
  body         text,
  row_selector text,
  columns      jsonb not null default '[]' check (jsonb_typeof(columns) = 'array'),
  key_columns  text[] not null default '{}',
  operations   jsonb not null default '{}' check (jsonb_typeof(operations) = 'object'),
  position     int  not null default 0,
  unique (catalog_id, name)
);

revoke all on meta.rest_catalog, meta.rest_catalog_service from public;
comment on table meta.rest_catalog is 'REST source catalogs (095): a workspace''s descriptions of web services; applications make REST data sources from their services.';
comment on table meta.rest_catalog_service is 'A service (endpoint) of a REST source catalog (095): copied into meta.rest_source by "From a catalog".';
