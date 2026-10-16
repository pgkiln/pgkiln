-- ---------------------------------------------------------------------
-- 108: the SQL Worksheet's history (sprint 92, Database Actions DA-5:
-- SQL History). One row per statement a developer ran in the worksheet:
-- the text, how it ended (ok or error), the rows and the time. Running
-- the same statement again right after counts on the same row (runs,
-- at), so repeated runs don't flood the list. Kept per developer and
-- workspace, at most 500 rows each (the builder deletes older ones).
-- The builder reads and writes it as the owner; nobody else has grants.
-- The activity log keeps its own 'sql_command' entries (the SQL Workshop
-- home's Recent SQL Commands).
-- ---------------------------------------------------------------------
create table meta.sql_history (
  id            bigint generated always as identity primary key,
  username      text not null,
  workspace_id  int not null default 1 references meta.workspace on delete cascade,
  sql           text not null check (length(sql) <= 20000),
  status        text not null check (status in ('ok', 'error')),
  rows          bigint,
  ms            int,
  error         text,
  runs          int not null default 1,
  at            timestamptz not null default now()
);
create index sql_history_user_idx on meta.sql_history (username, workspace_id, id desc);
comment on table meta.sql_history is 'The SQL Worksheet''s history per developer and workspace (108); installation data, not exported';
