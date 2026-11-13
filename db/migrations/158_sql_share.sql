-- ---------------------------------------------------------------------
-- 158: share links for query results (sprint 176, Database Actions DA-3
-- leftover). A developer shares the worksheet's query: a link with a
-- random token that another developer of the same workspace opens to see
-- the result. The link holds the SELECT, never its rows: the builder runs
-- it again, read-only, with the connection of the developer who opens it,
-- so everyone sees what their own privileges allow. A link ends on its
-- expiry date or when its maker (or an administrator) stops sharing.
-- Installation data, not exported.
-- ---------------------------------------------------------------------
create table meta.sql_share (
  id            int generated always as identity primary key,
  workspace_id  int not null default 1 references meta.workspace on delete cascade,
  token         text not null unique check (token ~ '^[A-Za-z0-9_-]{32}$'),
  title         text not null check (length(title) between 1 and 120),
  sql           text not null check (length(sql) between 1 and 20000),
  schema_name   text,
  created_by    text not null,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null default now() + interval '7 days'
);
create index sql_share_workspace on meta.sql_share (workspace_id, created_at desc);
comment on table meta.sql_share is 'SQL Workshop share links: a SELECT behind a token, run again for each developer who opens it (158); installation data, not exported';
