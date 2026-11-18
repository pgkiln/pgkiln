-- Sprint 221 (parity: Liquibase change log, "Missing: preconditions and contexts"): Liquibase's attributes of a
-- change set, written to the Liquibase formatted SQL changelog by SQL Workshop > Change Log.
--
--   context                a context expression (Liquibase: context:dev, context:"dev and !prod"): the change set
--                          runs only in a matching run; a download can pick change sets for given contexts
--   labels                 labels, comma separated (Liquibase: labels:jira-123,reporting)
--   precondition_sql       a check query (Liquibase: --precondition-sql-check); pgkiln proposes one for a plain
--                          create or added column (the object doesn't exist yet: expected 0)
--   precondition_expected  the result the check query must give (expectedResult)
--   precondition_on_fail   what Liquibase does when it doesn't: HALT, CONTINUE, MARK_RAN or WARN
--
-- pgkiln never runs the check: it is text for the migration files, like the rollback (157).

alter table meta.change_set
  add column context text check (length(context) between 1 and 200 and context ~ '^[A-Za-z0-9_ ,!()-]+$'),
  add column labels text check (length(labels) between 1 and 200 and labels ~ '^[A-Za-z0-9_ ,!()-]+$'),
  add column precondition_sql text check (length(precondition_sql) between 1 and 100000),
  add column precondition_expected text check (length(precondition_expected) between 1 and 200 and precondition_expected !~ '[\r\n]'),
  add column precondition_on_fail text check (precondition_on_fail in ('HALT', 'CONTINUE', 'MARK_RAN', 'WARN'));

comment on column meta.change_set.context is
  'The change log (183): the Liquibase context expression of this change set (null: every context)';
comment on column meta.change_set.labels is
  'The change log (183): the Liquibase labels of this change set, comma separated';
comment on column meta.change_set.precondition_sql is
  'The change log (183): a Liquibase sql-check precondition (a query); pgkiln never runs it';
comment on column meta.change_set.precondition_expected is
  'The change log (183): the expected result of the precondition query (Liquibase expectedResult)';
comment on column meta.change_set.precondition_on_fail is
  'The change log (183): what Liquibase does when the precondition fails: HALT, CONTINUE, MARK_RAN or WARN';
