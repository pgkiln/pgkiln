-- =====================================================================
-- 126: Administration 26.1 / 26.2 (sprint 118, WS-9): the mail queue,
-- a workspace's own mail service and its network access list
--
-- meta.workspace.network_restricted / network_hosts: a workspace's
--   outbound allow-list (APEX 26.2: workspace-level network ACLs). When
--   restricted, every outgoing web call made for one of its applications
--   (meta.web_request, REST data sources, invoke API, web credential token
--   endpoints, object storage, REST source catalogs) must match an entry
--   here AND the installation's list (PGKILN_REST_ALLOWED_HOSTS /
--   PGKILN_REST_PRIVATE_HOSTS): the workspace's list only narrows. Entries:
--   "api.example.com", "*.example.com" (subdomains), "host:8443" (one
--   port). Restricted with no entries: no outgoing calls at all. Checked in
--   src/webclient.ts on every hop (redirects too); installation data like
--   isolation (not in the workspace export).
-- meta.mail_service.workspace_id: a workspace's own mail service (APEX
--   26.1: workspace-level SMTP credentials), managed by the workspace's
--   administrators; null = an installation service (administrators). Its
--   secret is encrypted like a web credential's and never shown or
--   exported. Applications of the workspace without a service of their own
--   send through it. Its SMTP host is checked like a web request's host.
-- meta.mail_queue.last_attempt_at / duration_ms / provider: when the last
--   attempt to hand a mail over ended, how long the provider took, and which
--   provider it was (Administration → Mail queue).
-- meta.network_refusal: outgoing calls refused by the allow-lists, per
--   workspace and application (Administration → Network access), kept 7
--   days. Installation data: not exported, kept by an in-place import.
-- =====================================================================

-- one entry of a network access list: host, *.domain, host:port, [IPv6]:port (lower case)
create function meta.network_host_ok(p text) returns boolean
language sql immutable set search_path = pg_catalog as $$
  select p is not null and length(p) <= 260 and (
    p ~ '^(\*\.)?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*(:[1-9][0-9]{0,4})?$'
    or p ~ '^\[[0-9a-f:.]{2,45}\](:[1-9][0-9]{0,4})?$')
    and coalesce(nullif(substring(p from ':([0-9]+)$'), '')::int, 1) between 1 and 65535
$$;

create function meta.network_hosts_ok(p text[]) returns boolean
language sql immutable set search_path = pg_catalog as $$
  select p is not null and cardinality(p) <= 200 and coalesce(bool_and(meta.network_host_ok(h)), true) from unnest(p) h
$$;
revoke all on function meta.network_host_ok(text), meta.network_hosts_ok(text[]) from public;

alter table meta.workspace
  add column network_restricted boolean not null default false,
  add column network_hosts text[] not null default '{}' constraint workspace_network_hosts_ok check (meta.network_hosts_ok(network_hosts));
comment on column meta.workspace.network_restricted is 'Outgoing web calls of the workspace''s applications are limited to network_hosts (126), within the installation''s list';
comment on column meta.workspace.network_hosts is 'The workspace''s network access list (126): host, *.domain or host:port entries';

-- a workspace's own mail service (one at most); null: an installation service
alter table meta.mail_service add column workspace_id int references meta.workspace on delete cascade;
create unique index mail_service_workspace_key on meta.mail_service (workspace_id) where workspace_id is not null;
comment on column meta.mail_service.workspace_id is 'A workspace''s own mail service (126), managed by its administrators; null = the installation''s';

alter table meta.mail_queue
  add column last_attempt_at timestamptz,
  add column duration_ms int,
  add column provider text;
create index mail_queue_status_attempt on meta.mail_queue (status, last_attempt_at);
comment on column meta.mail_queue.duration_ms is 'How long the provider took to accept or refuse the last attempt (126)';

-- The mail service an application sends through: the one an administrator gave it (an installation
-- service, or its own workspace's), else its workspace's own service. Null: none.
create function meta.mail_service_for_app(p_app_id int) returns int
language sql stable security definer set search_path = meta, pg_catalog as $$
  select coalesce(
    (select x.service_id from meta.app_mail_service x join meta.mail_service s on s.id = x.service_id
      where x.app_id = p_app_id and (s.workspace_id is null or s.workspace_id = meta.app_workspace(p_app_id))),
    case when not exists (select 1 from meta.app_mail_service x where x.app_id = p_app_id)
         then (select s.id from meta.mail_service s where s.workspace_id = meta.app_workspace(p_app_id)) end)
$$;
revoke all on function meta.mail_service_for_app(int) from public;

-- (081) the calling application and its mail service; now also its workspace's own service
create or replace function meta.mail_caller(out app_id int, out service_id int, out from_address text, out max_per_day int, out senders text[])
language plpgsql stable security definer set search_path = meta, pg_catalog as $$
declare
  v_role text;
begin
  app_id := meta.app_id();
  if app_id is null then
    raise exception 'meta.send_mail: no current application (call it from application code)';
  end if;
  select a.db_role into v_role from meta.app a where a.id = app_id;
  if not found then
    raise exception 'meta.send_mail: no current application (call it from application code)';
  end if;
  if v_role is not null and current_setting('role') is distinct from v_role then
    raise exception 'meta.send_mail: called outside the application''s own database role';
  end if;
  select s.id, coalesce(x.from_address, nullif(s.settings->>'default_from', '')), x.max_per_day, s.senders
    into service_id, from_address, max_per_day, senders
    from meta.mail_service s left join meta.app_mail_service x on x.app_id = mail_caller.app_id and x.service_id = s.id
   where s.id = meta.mail_service_for_app(mail_caller.app_id) and s.enabled;
  if not found then
    raise exception 'meta.send_mail: this application may not send e-mail (an administrator chooses its mail service under Workspace utilities → Mail services, or the workspace''s administrators set up the workspace''s own)';
  end if;
end
$$;
revoke all on function meta.mail_caller() from public;

create table meta.network_refusal (
  id           bigint generated always as identity primary key,
  at           timestamptz not null default now(),
  workspace_id int references meta.workspace on delete cascade,
  app_id       int references meta.app on delete cascade,
  -- what made the call: web request, REST data source, invoke API, token endpoint, object storage, REST catalog, mail
  what         text not null check (length(what) <= 100),
  -- host[:port] and the URL without its query string (it may carry keys)
  host         text not null check (length(host) <= 300),
  url          text check (length(url) <= 1000),
  -- installation (not on the installation's list) or workspace (not on the workspace's)
  list         text not null check (list in ('installation', 'workspace')),
  message      text check (length(message) <= 1000)
);
create index network_refusal_ws on meta.network_refusal (workspace_id, at desc);
revoke all on meta.network_refusal from public;
comment on table meta.network_refusal is 'Outgoing web calls refused by the network access lists (126), kept 7 days; installation data, not exported';
