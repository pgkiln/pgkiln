-- Sprint 141 (AP-7): what a workspace's applications share (APEX: Static Workspace Files, Remote Servers,
-- workspace-level Web Credentials).
--
-- meta.workspace_file        a workspace's CSS, JavaScript, images and fonts (never HTML), served to each of its
--                            applications at /a/<alias>/workspace-files/<name> (the application's own origin, so the
--                            Content-Security-Policy stays script-src 'self') and named #WORKSPACE_FILES#<name> in the
--                            "every page loads" lists and in templates. The runtime role reads neither the table nor
--                            the content: meta.workspace_file_versions() gives an application its own workspace's
--                            names and versions; the server sends the content with the owner pool.
-- meta.remote_server         a named base URL per workspace (static id, e.g. CRM): this installation's URL, or an
--                            environment variable PGKILN_SERVER_<...> that wins when it is set, and an optional
--                            default web credential. REST data sources (meta.rest_source.server), REST source catalogs
--                            (meta.rest_catalog.server) and AI services (meta.ai_service.server_id) refer to it; the
--                            URL it resolves to goes through the same checks as before (allow-list, the workspace's
--                            network access list, address checks at connect time). Not readable by the runtime role.
-- meta.workspace_credential  web credentials of a workspace, used by its applications by name when an application has
--                            none of that name. Secrets (*_enc) are encrypted by the server with PGKILN_SECRET_KEY
--                            (src/secrets.ts), write-only, never exported; no grant to the runtime role at all.
--
-- All new columns on existing tables are nullable: exports of older versions import as they are, and export_app /
-- import_app copy every column of meta.rest_source (no redefinition needed).

-- ---------------------------------------------------------------- workspace files
create table meta.workspace_file (
  id           serial primary key,
  workspace_id int  not null references meta.workspace on delete cascade,
  name         text not null check (name ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$' and name !~ '\.\.' and lower(name) !~ '\.(html?|xhtml|xml|php|exe)$'),
  mime         text not null check (mime ~ '^[a-z]+/[a-z0-9.+-]+$'),
  content      bytea not null check (octet_length(content) <= 5 * 1024 * 1024),
  updated_by   text,
  updated_at   timestamptz not null default now(),
  unique (workspace_id, name)
);
revoke all on meta.workspace_file from public;
comment on table meta.workspace_file is 'Static workspace files (141): served to the workspace''s applications at /a/<alias>/workspace-files/<name>; in the workspace export';

-- The names and versions (milliseconds) of the workspace files an application may load: its own workspace's only.
create function meta.workspace_file_versions(p_app_id int) returns jsonb
language sql stable security definer set search_path = meta, pg_catalog as $$
  select coalesce(jsonb_object_agg(f.name, floor(extract(epoch from f.updated_at))::bigint), '{}')
    from meta.workspace_file f
   where f.workspace_id = meta.app_workspace(meta.checked_app(p_app_id))
$$;
revoke all on function meta.workspace_file_versions(int) from public;
grant execute on function meta.workspace_file_versions(int) to pgkiln_runtime;

-- ---------------------------------------------------------------- remote servers
create table meta.remote_server (
  id           serial primary key,
  workspace_id int  not null references meta.workspace on delete cascade,
  static_id    text not null check (static_id ~ '^[A-Z][A-Z0-9_]{0,59}$'),
  name         text not null check (name ~ '^\S(.{0,98}\S)?$'),
  description  text check (length(description) <= 2000),
  -- this installation's base URL, e.g. https://crm.example.com/api (no trailing slash, query or fragment)
  base_url     text check (base_url ~ '^https?://[^\s<>"{}?#]+$' and base_url !~ '/$' and length(base_url) <= 2000),
  -- or the server's environment variable that holds it (wins when set): PGKILN_SERVER_<NAME> only
  env_var      text check (env_var ~ '^PGKILN_SERVER_[A-Z0-9_]{1,60}$'),
  -- the web credential sources on this server use when they name none of their own
  credential   text check (credential ~ '^[A-Z][A-Z0-9_]{0,59}$'),
  updated_by   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (workspace_id, static_id),
  check (base_url is not null or env_var is not null)
);
revoke all on meta.remote_server from public;
comment on table meta.remote_server is 'Remote servers (141): a named base URL per workspace for REST data sources, catalogs and AI services; in the workspace export';

-- a REST data source on a server: its URL is then a path after the server's base URL ('' is the base URL itself)
alter table meta.rest_source add column server text check (server ~ '^[A-Z][A-Z0-9_]{0,59}$');
alter table meta.rest_source drop constraint rest_source_url_check;
alter table meta.rest_source add constraint rest_source_url_check
  check (url ~ '^https?://' or (server is not null and url ~ '^([/?][^\s]*)?$'));
comment on column meta.rest_source.server is 'A remote server of the application''s workspace (static id): the URL is then a path after its base URL';

-- a catalog on a server: services are paths after the server's base URL; base_url is then optional
alter table meta.rest_catalog add column server text check (server ~ '^[A-Z][A-Z0-9_]{0,59}$');
alter table meta.rest_catalog alter column base_url drop not null;
alter table meta.rest_catalog add constraint rest_catalog_base_or_server check (base_url is not null or server is not null);
comment on column meta.rest_catalog.server is 'A remote server of the workspace (static id): data sources made from the catalog use it';

-- an AI service on a server (administrators choose one of any workspace): its base URL is the server's plus server_path
alter table meta.ai_service
  add column server_id int references meta.remote_server on delete set null,
  add column server_path text check (server_path ~ '^/[^\s]*$' and length(server_path) <= 500);
alter table meta.ai_service drop constraint ai_service_compatible_url;
alter table meta.ai_service add constraint ai_service_compatible_url
  check (provider <> 'openai_compatible' or base_url is not null or server_id is not null);
comment on column meta.ai_service.server_id is 'A remote server whose base URL (plus server_path) the service calls instead of base_url';

-- ---------------------------------------------------------------- workspace web credentials
create table meta.workspace_credential (
  id                 serial primary key,
  workspace_id       int  not null references meta.workspace on delete cascade,
  name               text not null check (name ~ '^[A-Z][A-Z0-9_]{0,59}$'),
  description        text check (length(description) <= 2000),
  type               text not null default 'basic' check (type in ('basic', 'header', 'bearer', 'oauth2', 'aws_sigv4')),
  username           text,
  header_name        text check (header_name ~ '^[A-Za-z0-9!#$%&''*+.^_`|~-]{1,64}$'),
  token_url          text check (token_url ~ '^https?://'),
  scope              text,
  valid_for          text[] not null default '{}',
  grant_type         text not null default 'client_credentials' check (grant_type in ('client_credentials', 'password', 'refresh_token')),
  oauth_username     text,
  -- "v1:" + base64(iv, tag, ciphertext); written by the server only (src/secrets.ts)
  secret_enc         text,
  password_enc       text,
  refresh_token_enc  text,
  token_refreshed_at timestamptz,
  updated_by         text,
  updated_at         timestamptz not null default now(),
  unique (workspace_id, name)
);
revoke all on meta.workspace_credential from public;
comment on table meta.workspace_credential is 'Web credentials of a workspace (141): its applications use them by name when they have none of that name; secrets encrypted, never exported';
