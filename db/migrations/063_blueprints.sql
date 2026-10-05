-- =====================================================================
-- 063: Blueprints (APEX 26.1: Blueprints, spec-driven development)
--
-- A blueprint is a JSON document that describes a new application: its
-- name, alias and schema, tables with their columns, foreign keys and
-- allowed values, pages (the create page wizards' types), navigation and
-- sample data (src/blueprint.ts). The builder checks it, shows what it
-- will create (tables as SQL, pages, menu, rows) and creates the
-- application only from a reviewed blueprint, in one transaction.
-- Developers write blueprints, or let the App Builder's AI service draft
-- one from a description (migration 062); a draft is never created
-- without the review.
--
-- meta.blueprint: saved blueprints of this installation (builder data:
--   not exported); app_id is the application last created from it.
-- =====================================================================

create table meta.blueprint (
  id          serial primary key,
  name        text not null check (length(btrim(name)) between 1 and 100),
  spec        jsonb not null check (jsonb_typeof(spec) = 'object' and octet_length(spec::text) <= 500000),
  app_id      int references meta.app on delete set null,
  created_by  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
revoke all on meta.blueprint from public;
comment on table meta.blueprint is 'Saved application blueprints (builder data of this installation; not exported)';
