-- Sprint 175 (Database Actions DA-17 leftover): a rollback block per change set.
--
--   rollback_sql   the SQL that undoes the change set (Liquibase: --rollback lines; Flyway: an undo migration
--                  U0001__<name>.sql). pgkiln proposes it when every statement of the change set has an obvious
--                  inverse (create table / view / index / sequence, add column, add constraint, a comment); the
--                  developer writes or changes it in SQL Workshop > Change Log. pgkiln never runs it.

alter table meta.change_set add column rollback_sql text
  check (length(rollback_sql) between 1 and 1000000);

comment on column meta.change_set.rollback_sql is
  'The change log (157): the SQL that undoes this change set, written to migration files as its rollback block (null: none)';
