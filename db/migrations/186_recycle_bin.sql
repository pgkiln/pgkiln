-- Sprint 228 (parity: SQL Workshop, "Missing: a recycle bin (PostgreSQL has none)"): Oracle's recycle bin for the
-- SQL Workshop. "Drop to the recycle bin" renames a table to a hidden name (BIN$…) in its own schema, on the SQL
-- Workshop's own connection (so the developer's privileges apply: only the table's owner can); the table, its rows,
-- indexes, constraints, triggers and grants stay. SQL Workshop > Recycle Bin restores it (renamed back) or purges it
-- (dropped). This table remembers what was dropped, per workspace; the table itself is found by its oid.

create table meta.recycle_bin (
  id            bigserial primary key,
  workspace_id  int not null references meta.workspace on delete cascade,
  schema_name   text not null,
  original_name text not null check (length(original_name) between 1 and 63),
  bin_name      text not null check (bin_name ~ '^BIN\$[a-z0-9]{8,40}$'),
  table_oid     oid not null,
  dropped_by    text,
  dropped_at    timestamptz not null default now(),
  unique (schema_name, bin_name)
);
create index on meta.recycle_bin (workspace_id, dropped_at desc);
revoke all on meta.recycle_bin from public;
alter table meta.recycle_bin enable row level security;
create policy meta_owner_only on meta.recycle_bin using ((select meta.meta_owner_member())) with check ((select meta.meta_owner_member()));
comment on table meta.recycle_bin is
  'The SQL Workshop''s recycle bin (186): tables renamed to BIN$… instead of dropped, per workspace; builder only';
