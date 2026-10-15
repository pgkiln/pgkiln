-- ---------------------------------------------------------------------
-- 107: an application's version (APEX: Application Definition → Version,
-- "Release 1.0"), shown in the footer of its pages with "Back to top".
-- New applications start with 'Release 1.0'; existing ones have none (no
-- version in the footer) until a developer sets one in Settings. It travels
-- with the export like the other columns of meta.app.
-- ---------------------------------------------------------------------
alter table meta.app add column version text check (length(version) <= 40);
comment on column meta.app.version is 'The application''s version, e.g. Release 1.0: shown in its pages'' footer (107)';
