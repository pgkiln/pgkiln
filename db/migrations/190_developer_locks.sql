-- (sprint 233) Removing a developer releases their page and application locks.
--
-- meta.builder_lock.locked_by is text without a foreign key (042): the command line and the MCP server lock under
-- names that need not be developers (--as, PGKILN_DEVELOPER, the operating system user, 'MCP'). Before this, a
-- removed developer's locks stayed, held by nobody who could sign in; adding the same username again gave them back.
-- The builder's Remove releases them and logs each one (activity log, event lock_released); this trigger is the
-- backstop for any other delete of a developer. Locks that are already orphaned are not released here: a name that
-- is no developer may be a command-line user's; Developers → "Locks of names that are no developer" lists them for an
-- administrator to release.

create or replace function meta.developer_release_locks() returns trigger
language plpgsql set search_path = pg_catalog, meta as $$
begin
  delete from meta.builder_lock where locked_by = old.username;
  return old;
end $$;
comment on function meta.developer_release_locks() is 'trigger: a removed developer''s page and application locks are released (sprint 233)';

create trigger developer_release_locks after delete on meta.developer
  for each row execute function meta.developer_release_locks();
