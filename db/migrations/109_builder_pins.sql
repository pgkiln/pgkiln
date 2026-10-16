-- ---------------------------------------------------------------------
-- 109: pins on the SQL Workshop's Launchpad (sprint 96, Database Actions
-- DA-15: Pinned & Recently Visited). A developer pins a tool, a database
-- object or a saved worksheet; the home page lists them first. Per
-- developer and workspace, at most 24 (the builder refuses more). Only
-- builder paths (/builder/…) are kept. The builder reads and writes it as
-- the owner; installation data, not exported.
-- ---------------------------------------------------------------------
create table meta.builder_pin (
  id            bigint generated always as identity primary key,
  username      text not null,
  workspace_id  int not null default 1 references meta.workspace on delete cascade,
  href          text not null check (href ~ '^/builder/' and length(href) <= 400),
  label         text not null check (length(label) between 1 and 120),
  icon          text not null default 'bookmark' check (icon ~ '^[a-z0-9-]{1,40}$'),
  at            timestamptz not null default now(),
  unique (username, workspace_id, href)
);
comment on table meta.builder_pin is 'The SQL Workshop Launchpad''s pins per developer and workspace (109); installation data, not exported';
