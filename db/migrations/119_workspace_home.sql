-- ---------------------------------------------------------------------
-- 119: the Workspace home (sprint 109, WS-1; APEX: the workspace home
-- page). The builder opens /builder/home after signing in: tool cards, the
-- workspace's top applications and users by page views over a reporting
-- timeframe, a summary of counts, the workspace message and a system
-- message.
--
-- meta.developer.home_timeframe: the reporting timeframe each developer
-- chose for Top applications and Top users (hour, day or week); null is
-- the default (day). A developer account is installation data: not
-- exported with an application or a workspace.
--
-- The "new version available" check is an instance setting
-- (meta.setting 'release_check' = 'on' / 'off'; else the environment
-- variable PGKILN_RELEASE_CHECK; off by default): no table needed.
-- ---------------------------------------------------------------------
alter table meta.developer
  add column home_timeframe text check (home_timeframe in ('hour', 'day', 'week'));
comment on column meta.developer.home_timeframe is
  'The reporting timeframe of the developer''s Workspace home (119): hour, day or week; null = day.';
