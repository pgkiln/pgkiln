-- The catalogued values of the application components (check constraints of the meta
-- schema: region types, item types, process types, …): one row per value.
-- Used by test/sample-coverage.test.ts.
with cat as (
  select c.conrelid::regclass::text as tbl, a.attname as col,
         (regexp_matches(pg_get_constraintdef(c.oid), '''([^'']+)''::text', 'g'))[1] as val
    from pg_constraint c
    join pg_namespace n on n.oid = c.connamespace
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
   where n.nspname = 'meta' and c.contype = 'c' and cardinality(c.conkey) = 1
     and pg_get_constraintdef(c.oid) ~ 'ANY \(ARRAY\['
     and (c.conrelid::regclass::text, a.attname) in (
       ('meta.region', 'type'), ('meta.region', 'template'), ('meta.region', 'position'),
       ('meta.item', 'type'), ('meta.process', 'type'), ('meta.process', 'point'),
       ('meta.validation', 'type'), ('meta.validation', 'display_location'),
       ('meta.computation', 'type'), ('meta.computation', 'point'),
       ('meta.app_computation', 'type'), ('meta.app_process', 'point'),
       ('meta.dynamic_action', 'event'), ('meta.dynamic_action', 'action'), ('meta.dynamic_action', 'condition_type'),
       ('meta.button', 'action'), ('meta.button', 'slot'), ('meta.branch', 'target_type'), ('meta.branch', 'point'),
       ('meta.page', 'mode'), ('meta.page', 'page_template'), ('meta.page', 'protection'),
       ('meta.list', 'type'), ('meta.authz_scheme', 'type'), ('meta.plugin', 'type'),
       ('meta.search_config', 'search_type'), ('meta.search_config', 'source_type'),
       ('meta.task_definition', 'type'), ('meta.shortcut', 'type'), ('meta.report_query', 'format'),
       ('meta.app', 'authentication'), ('meta.app', 'access_control'), ('meta.app', 'language_from')))
select tbl, col, val from cat order by 1, 2, 3
