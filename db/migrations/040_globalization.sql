-- Globalization (APEX: Shared Components → Globalization Attributes):
--
--   * time_zone: the application's time zone (an IANA name such as
--     Europe/Amsterdam). The runtime sets it with SET LOCAL for the app's
--     queries, so timestamptz values are shown and read in it. Empty: the
--     database's own setting.
--   * time_zone_auto (APEX: Automatic Time Zone): each user's browser time
--     zone (sent once per session by app.js) or their own choice on My
--     account (meta.account.time_zone) replaces the application's.
--   * currency: the ISO 4217 code behind the L and C elements of number
--     format masks (999G990D00L). Empty: the default of the language.
--
-- Names are checked against pg_timezone_names by the runtime and the builder
-- (a check constraint cannot read that view). The columns are nullable so
-- exports from older versions still import.

alter table meta.app
  add column time_zone text check (time_zone is null or (octet_length(time_zone) between 1 and 64 and time_zone ~ '^[A-Za-z0-9_+/-]+$')),
  add column time_zone_auto boolean,
  add column currency text check (currency is null or currency ~ '^[A-Z]{3}$');

comment on column meta.app.time_zone is 'the application''s time zone (IANA name); null: the database''s';
comment on column meta.app.time_zone_auto is 'automatic time zone: the browser''s or the user''s own time zone replaces the application''s';
comment on column meta.app.currency is 'ISO 4217 currency code for the L and C number format elements; null: the language''s default';

alter table meta.account
  add column time_zone text check (time_zone is null or (octet_length(time_zone) between 1 and 64 and time_zone ~ '^[A-Za-z0-9_+/-]+$'));

comment on column meta.account.time_zone is 'the user''s own time zone (applications with an automatic time zone); null: the browser''s';

grant select (time_zone) on meta.account to pgapex_runtime;
grant update (time_zone) on meta.account to pgapex_runtime;
