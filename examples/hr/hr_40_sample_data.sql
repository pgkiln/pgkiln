-- =====================================================================
-- HR example, part 40: a saved sample data generator
-- (SQL Workshop → Sample Data, docs/guide/16-files.md#sql-workshop--sample-data)
--
-- "HR demo staff" adds 3 departments, 15 employees in them (managers picked
-- from the existing and new employees, salaries below the president's so
-- the hr.check_salary trigger accepts them) and 30 leave requests that end
-- on or after the day they start. Open it in the builder to preview the
-- rows, insert them, download them as SQL or CSV, or change the generators.
-- The seed makes every run produce the same values (the keys come from the
-- identity columns; unique department names are drawn again when taken).
-- =====================================================================

insert into meta.data_generator (name, description, schema_name, seed, tables, created_by, updated_by)
values ('HR demo staff', 'Departments, employees and leave requests for trying out the HR pages.', 'hr', 2026, $json$[
  {"table": "dept", "rows": 3, "columns": [
    {"column": "deptno", "generator": "skip", "options": "", "nulls": 0},
    {"column": "dname", "generator": "words", "options": "1..2", "nulls": 0},
    {"column": "loc", "generator": "city", "options": "", "nulls": 0},
    {"column": "lat", "generator": "decimal", "options": "45.00000..55.00000", "nulls": 0},
    {"column": "lng", "generator": "decimal", "options": "-5.00000..15.00000", "nulls": 0}]},
  {"table": "emp", "rows": 15, "columns": [
    {"column": "empno", "generator": "skip", "options": "", "nulls": 0},
    {"column": "ename", "generator": "full_name", "options": "", "nulls": 0},
    {"column": "job", "generator": "list", "options": "CLERK, CLERK, SALESMAN, ANALYST, MANAGER", "nulls": 0},
    {"column": "mgr", "generator": "foreign_key", "options": "", "nulls": 10},
    {"column": "hiredate", "generator": "date", "options": "2018-01-01..2026-06-30", "nulls": 0},
    {"column": "sal", "generator": "decimal", "options": "800.00..2900.00", "nulls": 0},
    {"column": "comm", "generator": "decimal", "options": "0.00..500.00", "nulls": 70},
    {"column": "deptno", "generator": "foreign_key", "options": "", "nulls": 0},
    {"column": "active", "generator": "boolean", "options": "90", "nulls": 0},
    {"column": "username", "generator": "skip", "options": "", "nulls": 0},
    {"column": "photo", "generator": "skip", "options": "", "nulls": 0},
    {"column": "photo_name", "generator": "skip", "options": "", "nulls": 0},
    {"column": "photo_mime", "generator": "skip", "options": "", "nulls": 0},
    {"column": "work_location", "generator": "city", "options": "", "nulls": 20}]},
  {"table": "leave_request", "rows": 30, "columns": [
    {"column": "id", "generator": "skip", "options": "", "nulls": 0},
    {"column": "empno", "generator": "foreign_key", "options": "", "nulls": 0},
    {"column": "start_date", "generator": "date", "options": "2026-01-01..2026-12-31", "nulls": 0},
    {"column": "end_date", "generator": "date", "options": "start_date + 0..10", "nulls": 0},
    {"column": "days", "generator": "integer", "options": "1..10", "nulls": 0},
    {"column": "reason", "generator": "list", "options": "Holiday, Family visit, Medical appointment, Moving house, Training", "nulls": 0},
    {"column": "status", "generator": "list", "options": "PENDING, PENDING, APPROVED, REJECTED", "nulls": 0},
    {"column": "decided_by", "generator": "skip", "options": "", "nulls": 0},
    {"column": "decided_at", "generator": "skip", "options": "", "nulls": 0},
    {"column": "decision_note", "generator": "skip", "options": "", "nulls": 0},
    {"column": "created_at", "generator": "timestamp", "options": "2025-10-01..2026-10-01", "nulls": 0}]}
]$json$::jsonb, 'admin', 'admin')
on conflict (name) do nothing;
