-- =====================================================================
-- 101: an application opens in its own light or dark mode until the user
-- chooses (sprint 79; parity handoff UI-2)
--
-- meta.account.theme_pref was 'auto' unless the user chose: at sign-in that
-- choice replaced the application's mode, so an Iris application (light)
-- followed the operating system's dark mode for every signed-in user. Null
-- now means "no choice": the application's mode (meta.app.theme.mode).
-- The 'auto' that every account had is cleared; a user who chose
-- Automatic chooses it again from the Appearance menu.
-- =====================================================================
alter table meta.account alter column theme_pref drop not null;
alter table meta.account alter column theme_pref set default null;
update meta.account set theme_pref = null where theme_pref = 'auto';
comment on column meta.account.theme_pref is 'The user''s light/dark choice (auto, light, dark); null: the application''s mode (101).';
