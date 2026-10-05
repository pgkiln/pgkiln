-- =====================================================================
-- 056: application types and subscriptions (APEX 26.1: theme, library and
-- boilerplate applications; APEX: subscribing to shared components)
--
-- meta.app.app_type
--   standard     an ordinary application
--   theme        its theme (colours, navigation, styles of the Theme Roller)
--                and template components are offered to other applications
--   library      its shared components (lists of values, authorization
--                schemes, build options, template components, lists) are
--                offered to other applications
--   boilerplate  a starting point: Create application can copy it
-- The type is part of the definition and travels with an export; an export
-- made before 056 imports as 'standard' (trigger below).
--
-- meta.subscription: a component of app_id that is a copy of the component
-- with the same name in master_app_id. Refreshing copies the master's
-- definition again (src/subscriptions.ts); publishing refreshes every
-- subscriber. kind 'theme' subscribes to the master's whole theme (name '').
-- Subscriptions are builder state of this installation: not exported.
-- =====================================================================

alter table meta.app add column app_type text not null default 'standard'
  check (app_type in ('standard', 'theme', 'library', 'boilerplate'));

create function meta.app_type_default() returns trigger
language plpgsql set search_path = pg_catalog as $$
begin
  new.app_type := coalesce(new.app_type, 'standard');
  return new;
end $$;
create trigger app_type_default before insert or update on meta.app
  for each row execute function meta.app_type_default();

create table meta.subscription (
  app_id        int  not null references meta.app on delete cascade,
  kind          text not null check (kind in ('theme', 'lov', 'authz_scheme', 'build_option', 'template_component', 'list')),
  name          text not null check (length(name) <= 200 and (kind = 'theme') = (name = '')),
  master_app_id int  not null references meta.app on delete cascade,
  created_by    text not null,
  created_at    timestamptz not null default now(),
  refreshed_at  timestamptz,
  refreshed_by  text,
  primary key (app_id, kind, name),
  check (app_id <> master_app_id)
);
create index subscription_master_idx on meta.subscription (master_app_id, kind, name);

comment on table meta.subscription is 'Shared components (or the theme) of app_id copied from master_app_id; refreshed on demand';
comment on column meta.app.app_type is 'standard, theme, library (components offered to other apps) or boilerplate (a starting point for new apps)';
