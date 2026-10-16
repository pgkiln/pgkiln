-- ---------------------------------------------------------------------
-- 116: Schema Export / Import jobs (sprint 103, Database Actions DA-16:
-- Data Pump). Administration › Schema Export / Import runs pg_dump for a
-- schema and pg_restore into a new or existing schema as background jobs
-- (src/datapump.ts). A job's file lives in the dump directory
-- (PGKILN_DUMP_DIR) until it expires (PGKILN_DUMP_KEEP_DAYS); the row
-- keeps the job's options, size, timing and log.
--
-- The builder reads and writes it as the owner, for administrators only;
-- nobody else has grants. Installation data, not exported.
-- ---------------------------------------------------------------------
create table meta.dump_job (
  id             bigint generated always as identity primary key,
  kind           text not null check (kind in ('export', 'import')),
  -- uploaded: a file waiting for its import options
  status         text not null check (status in ('uploaded', 'running', 'succeeded', 'failed', 'cancelled')),
  username       text not null,
  -- export: the schema dumped; import: the schema in the dump
  schema_name    text check (length(schema_name) between 1 and 63),
  -- import: the schema the objects went to
  target_schema  text check (length(target_schema) between 1 and 63),
  options        jsonb not null default '{}',
  -- the file in the dump directory (a plain name, no path); null once removed
  file_name      text check (file_name ~ '^[A-Za-z0-9_.-]{1,120}$'),
  -- an upload's own file name, as shown
  original_name  text check (length(original_name) <= 255),
  -- an import of an export's file
  source_job     bigint references meta.dump_job on delete set null,
  bytes          bigint,
  log            text not null default '',
  error          text,
  created_at     timestamptz not null default now(),
  started_at     timestamptz,
  finished_at    timestamptz,
  -- a running job's server writes it every few seconds; a job without it for minutes was interrupted
  heartbeat_at   timestamptz,
  expires_at     timestamptz
);
create index dump_job_created on meta.dump_job (created_at desc);
revoke all on meta.dump_job from public;
comment on table meta.dump_job is 'Schema Export / Import jobs (116): pg_dump and pg_restore runs with their options, files, sizes and logs; installation data, not exported';
