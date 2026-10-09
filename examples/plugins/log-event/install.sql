-- Log an event (process plug-in): the table and the function the process calls.
create schema if not exists pgkiln_plugins;

create table if not exists pgkiln_plugins.event_log (
  id       bigint generated always as identity primary key,
  at       timestamptz not null default now(),
  app_user text,
  event    text not null,
  detail   text
);

create or replace function pgkiln_plugins.log_event(p_attributes jsonb) returns text
language plpgsql as $$
begin
  insert into pgkiln_plugins.event_log (app_user, event, detail)
  values (meta.app_user(), coalesce(nullif(p_attributes->>'EVENT', ''), 'event'), nullif(p_attributes->>'DETAIL', ''));
  return nullif(p_attributes->>'MESSAGE', '');
end
$$;
