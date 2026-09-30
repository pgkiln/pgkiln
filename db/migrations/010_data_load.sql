-- ---------------------------------------------------------------------
-- Data loading in applications: page process type 'data_load'
--
-- Loads the CSV/TSV/XLSX file of a file item (config.file_item, stored as
-- a temporary file) into config.table, as the application's database
-- role (grants and row level security apply). Columns are matched by
-- name, or mapped with config.columns {"File heading": "column"}.
--   config: {"file_item": "P13_FILE", "table": "hr.emp", "mode": "merge",
--            "skip_errors": false, "headers": true}
-- ---------------------------------------------------------------------
-- nullable: application exports made before this column existed import as null
alter table meta.process add column config jsonb default '{}';

alter table meta.process drop constraint process_type_check;
alter table meta.process add constraint process_type_check check (type in ('form_dml', 'grid_dml', 'sql', 'data_load'));
