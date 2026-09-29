-- =====================================================================
-- 004: single sign-on with OpenID Connect
--
-- Identity providers are configured once for the installation; each
-- application chooses which providers (and/or passwords) its login page
-- offers, and maps identity-provider groups to application roles.
-- =====================================================================

create table meta.auth_provider (
  id             serial primary key,
  name           text not null unique check (name ~ '^[a-z][a-z0-9_-]*$'),
  display_name   text not null,
  -- the issuer URL; discovery is read from <issuer>/.well-known/openid-configuration
  issuer         text not null check (issuer ~ '^https?://'),
  client_id      text not null,
  -- confidential clients; NULL for public clients (PKCE only). Readable only by the owner.
  client_secret  text,
  scopes         text not null default 'openid profile email',
  -- claim that becomes the pgapex username (e.g. preferred_username, email, upn)
  username_claim text not null default 'preferred_username',
  -- claim with the user's groups (dot path allowed, e.g. realm_access.roles)
  groups_claim   text not null default 'groups',
  -- create an account on first sign-in when none exists
  auto_create    boolean not null default false,
  enabled        boolean not null default true,
  created_at     timestamptz not null default now()
);

-- Links an account to its identity at a provider by the provider's stable
-- subject ("sub"), so later sign-ins don't depend on a changeable claim.
create table meta.account_identity (
  provider_id int  not null references meta.auth_provider on delete cascade,
  subject     text not null,
  account_id  int  not null references meta.account on delete cascade,
  linked_at   timestamptz not null default now(),
  primary key (provider_id, subject),
  unique (account_id, provider_id)
);

-- Sign-in methods per application.
alter table meta.app add column sso_providers text[] not null default '{}';
alter table meta.app add column local_login boolean not null default true;

-- Identity-provider group -> application role.
create table meta.app_group_role (
  app_id     int  not null references meta.app on delete cascade,
  group_name text not null,
  role       text not null,
  primary key (app_id, group_name, role)
);

-- Authorization requests in flight (state, PKCE verifier, nonce). Rows live
-- a few minutes and are deleted when used.
create table meta.sso_pending (
  state         text primary key,
  app_id        int  not null references meta.app on delete cascade,
  provider_id   int  not null references meta.auth_provider on delete cascade,
  code_verifier text not null,
  nonce         text not null,
  -- sha256 of a random value kept in a cookie of the browser that started the flow
  browser_hash  text not null,
  next          text,
  created_at    timestamptz not null default now()
);

-- The runtime role gets nothing here: pgapex handles SSO with the owner
-- connection (secrets never reach the role that runs application SQL).
-- It may read group mappings to explain roles, but doesn't need to.

-- ---------------------------------------------------------------------
-- Export/import: include group -> role mappings (providers are instance
-- configuration and are not exported).
-- ---------------------------------------------------------------------
create or replace function meta.export_app(p_alias text) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'format', 'pgapex/2',
    'app', to_jsonb(a) - 'id' - 'created_at' - 'updated_at',
    'authz_schemes', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.name) from meta.authz_scheme x where x.app_id = a.id), '[]'),
    'app_items', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.name) from meta.app_item x where x.app_id = a.id), '[]'),
    'app_processes', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.seq, x.id) from meta.app_process x where x.app_id = a.id), '[]'),
    'lovs', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' order by x.name) from meta.lov x where x.app_id = a.id), '[]'),
    'group_roles', coalesce((select jsonb_agg(to_jsonb(x) - 'app_id' order by x.group_name, x.role) from meta.app_group_role x where x.app_id = a.id), '[]'),
    'nav', coalesce((select jsonb_agg(to_jsonb(x) - 'app_id' order by x.parent_id nulls first, x.seq, x.id) from meta.nav_entry x where x.app_id = a.id), '[]'),
    'pages', coalesce((
      select jsonb_agg(to_jsonb(p) - 'id' - 'app_id' || jsonb_build_object(
        'regions', coalesce((select jsonb_agg(to_jsonb(r) - 'page_id' order by r.seq, r.id) from meta.region r where r.page_id = p.id), '[]'),
        'items', coalesce((select jsonb_agg(to_jsonb(i) - 'id' - 'page_id' order by i.seq, i.id) from meta.item i where i.page_id = p.id), '[]'),
        'buttons', coalesce((select jsonb_agg(to_jsonb(b) - 'id' - 'page_id' order by b.seq, b.id) from meta.button b where b.page_id = p.id), '[]'),
        'dynamic_actions', coalesce((select jsonb_agg(to_jsonb(d) - 'id' - 'page_id' order by d.seq, d.id) from meta.dynamic_action d where d.page_id = p.id), '[]'),
        'validations', coalesce((select jsonb_agg(to_jsonb(v) - 'id' - 'page_id' order by v.seq, v.id) from meta.validation v where v.page_id = p.id), '[]'),
        'processes', coalesce((select jsonb_agg(to_jsonb(x) - 'id' - 'page_id' order by x.seq, x.id) from meta.process x where x.page_id = p.id), '[]')
      ) order by p.page_no)
      from meta.page p where p.app_id = a.id), '[]'))
  from meta.app a
  where a.alias = p_alias
$$;

-- import_app: same as 002, plus group_roles.
create or replace function meta.import_app(p_doc jsonb, p_alias text default null) returns int
language plpgsql as $$
declare
  v_app_id  int;
  v_page_id int;
  v_page    jsonb;
  v_e       jsonb;
  v_rmap    jsonb;
  v_nmap    jsonb := '{}';
  v_new_id  int;
begin
  if p_doc->>'format' is distinct from 'pgapex/2' then
    raise exception 'unsupported export format %', p_doc->>'format';
  end if;

  insert into meta.app
  select (jsonb_populate_record(null::meta.app, p_doc->'app' || jsonb_build_object(
            'id', nextval('meta.app_id_seq'),
            'alias', coalesce(p_alias, p_doc->'app'->>'alias'),
            'created_at', now(), 'updated_at', now()))).*
  returning id into v_app_id;

  insert into meta.authz_scheme
  select (jsonb_populate_record(null::meta.authz_scheme, e || jsonb_build_object('id', nextval('meta.authz_scheme_id_seq'), 'app_id', v_app_id))).*
    from jsonb_array_elements(p_doc->'authz_schemes') e;
  insert into meta.app_item
  select (jsonb_populate_record(null::meta.app_item, e || jsonb_build_object('id', nextval('meta.app_item_id_seq'), 'app_id', v_app_id))).*
    from jsonb_array_elements(p_doc->'app_items') e;
  insert into meta.app_process
  select (jsonb_populate_record(null::meta.app_process, e || jsonb_build_object('id', nextval('meta.app_process_id_seq'), 'app_id', v_app_id))).*
    from jsonb_array_elements(p_doc->'app_processes') e;
  insert into meta.lov
  select (jsonb_populate_record(null::meta.lov, e || jsonb_build_object('id', nextval('meta.lov_id_seq'), 'app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'lovs', '[]')) e;
  insert into meta.app_group_role
  select (jsonb_populate_record(null::meta.app_group_role, e || jsonb_build_object('app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'group_roles', '[]')) e;

  for v_e in select * from jsonb_array_elements(p_doc->'nav') loop
    insert into meta.nav_entry
    select (jsonb_populate_record(null::meta.nav_entry, v_e || jsonb_build_object(
              'id', nextval('meta.nav_entry_id_seq'), 'app_id', v_app_id,
              'parent_id', v_nmap->>(v_e->>'parent_id')))).*
    returning id into v_new_id;
    v_nmap := v_nmap || jsonb_build_object(v_e->>'id', v_new_id);
  end loop;

  for v_page in select * from jsonb_array_elements(p_doc->'pages') loop
    insert into meta.page
    select (jsonb_populate_record(null::meta.page, v_page || jsonb_build_object('id', nextval('meta.page_id_seq'), 'app_id', v_app_id))).*
    returning id into v_page_id;

    v_rmap := '{}';
    for v_e in select * from jsonb_array_elements(v_page->'regions') loop
      insert into meta.region
      select (jsonb_populate_record(null::meta.region, v_e || jsonb_build_object('id', nextval('meta.region_id_seq'), 'page_id', v_page_id))).*
      returning id into v_new_id;
      v_rmap := v_rmap || jsonb_build_object(v_e->>'id', v_new_id);
    end loop;
    update meta.region r
       set config = jsonb_set(r.config, '{report}', to_jsonb((v_rmap->>(r.config->>'report'))::int))
     where r.page_id = v_page_id and r.type = 'facets' and v_rmap ? (r.config->>'report');

    insert into meta.item
    select (jsonb_populate_record(null::meta.item, e || jsonb_build_object('id', nextval('meta.item_id_seq'), 'page_id', v_page_id, 'region_id', v_rmap->>(e->>'region_id')))).*
      from jsonb_array_elements(v_page->'items') e;
    insert into meta.button
    select (jsonb_populate_record(null::meta.button, e || jsonb_build_object('id', nextval('meta.button_id_seq'), 'page_id', v_page_id, 'region_id', v_rmap->>(e->>'region_id')))).*
      from jsonb_array_elements(v_page->'buttons') e;
    insert into meta.dynamic_action
    select (jsonb_populate_record(null::meta.dynamic_action, e || jsonb_build_object('id', nextval('meta.dynamic_action_id_seq'), 'page_id', v_page_id, 'affected_region_id', v_rmap->>(e->>'affected_region_id')))).*
      from jsonb_array_elements(v_page->'dynamic_actions') e;
    insert into meta.validation
    select (jsonb_populate_record(null::meta.validation, e || jsonb_build_object('id', nextval('meta.validation_id_seq'), 'page_id', v_page_id))).*
      from jsonb_array_elements(v_page->'validations') e;
    insert into meta.process
    select (jsonb_populate_record(null::meta.process, e || jsonb_build_object('id', nextval('meta.process_id_seq'), 'page_id', v_page_id, 'region_id', v_rmap->>(e->>'region_id')))).*
      from jsonb_array_elements(v_page->'processes') e;
  end loop;

  return v_app_id;
end
$$;
