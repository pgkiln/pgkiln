-- ---------------------------------------------------------------------
-- 127: the builder in more languages (sprint 121, WS-7; APEX: the
-- builder's language links on the sign-in page and the workspace home).
--
-- meta.developer.language: the builder language each developer chose (the
-- language menu in the builder's status bar, or a language link on the
-- builder's sign-in page); null = English. The builder's own texts are
-- message files in src/builder/i18n/ (en, de, es, fr, nl, pt); the check
-- keeps the column to codes of that shape, the server accepts only the
-- languages it has. A developer account is installation data: not
-- exported with an application or a workspace.
-- ---------------------------------------------------------------------
alter table meta.developer
  add column language text check (language ~ '^[a-z]{2}(-[A-Z]{2})?$');
comment on column meta.developer.language is
  'The developer''s builder language (127): en, de, es, fr, nl or pt; null = English.';
