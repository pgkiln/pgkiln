-- =====================================================================
-- 171: personal builder tokens for the command line and the MCP server
--      (sprint 194, NX-F4, SEC-1)
--
-- A developer makes a token on their Security page (after a recent
-- sign-in with the factors they need: single sign-on, a second factor)
-- and gives it to `pgkiln mcp --url … --token-env …` on their own
-- machine. The builder's API (/builder/api/v1/…) then acts as that
-- developer, in one workspace, with the token's scopes:
--
--   read    applications, pages, files and exports of the workspace;
--           the catalog through the workspace's developer login
--   write   imports over the workspace's applications, working copies
--           and locks, with the builder's lock rules
--   sql     read-only queries as the workspace's developer login (the
--           SQL Workshop's identity, migration 166), never the owner
--
-- Only sha256 of the token is kept. A token always expires (at most a
-- year), can be revoked, and grants no more than its developer has at
-- the time of each request (membership and administrator status are
-- looked up then, not copied here). Removing a developer removes their
-- tokens; a password set by an administrator and a reset of their
-- second factors revoke them.
-- =====================================================================

create table meta.builder_token (
  id             bigserial primary key,
  username       text not null references meta.developer on update cascade on delete cascade,
  workspace_id   int not null references meta.workspace on delete cascade,
  name           text not null check (name ~ '^\S(.{0,58}\S)?$'),
  token_hash     text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  scopes         text[] not null check (cardinality(scopes) between 1 and 3 and scopes <@ array['read', 'write', 'sql']),
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null,
  last_used_at   timestamptz,
  last_used_ip   text check (length(last_used_ip) <= 100),
  revoked_at     timestamptz,
  revoked_by     text check (length(revoked_by) <= 200),
  revoked_reason text check (length(revoked_reason) <= 200),
  -- never "never": at most a year (and a day for clock and rounding)
  check (expires_at > created_at and expires_at <= created_at + interval '366 days')
);
create index on meta.builder_token (username);
create unique index builder_token_live_name on meta.builder_token (username, lower(name)) where revoked_at is null;
comment on table meta.builder_token is
  'Personal builder tokens (171): sha256 of the token, the developer, one workspace, scopes read/write/sql, expiry (at most a year), last use, revocation.';

-- the owner only: no grants to pgkiln_runtime or any workspace login
revoke all on meta.builder_token from public;
