-- =====================================================================
-- HR example, part 63: a Data Reporter dataset (docs/guide/04-pages-and-
-- regions.md, "Datasets and reporting applications")
--
-- The dataset "hr" of the Default workspace: employees (hr.emp) joined to
-- their department (hr.dept, a left join on the foreign key deptno), the
-- columns business users may see with labels, format masks and
-- descriptions, and a row filter: active employees only. In the builder,
-- App Builder → Data Reporter → Create reporting application makes a
-- reporting application on it in two clicks; datasets are installation
-- data (a file of their own, and the workspace export), not part of the
-- HR application's export.
-- =====================================================================

insert into meta.dataset (workspace_id, name, label, description, schema_name, tables, columns, filters, created_by)
values (1, 'hr', 'HR', 'Active employees with their department.', 'hr',
  '[{"alias": "t1", "table": "emp"},
    {"alias": "t2", "table": "dept", "join": {"to": "t1", "type": "left", "on": [{"column": "deptno", "ref": "deptno"}]}}]',
  '[{"name": "empno", "table": "t1", "column": "empno", "label": "No."},
    {"name": "ename", "table": "t1", "column": "ename", "label": "Name"},
    {"name": "job", "table": "t1", "column": "job", "label": "Job"},
    {"name": "hiredate", "table": "t1", "column": "hiredate", "label": "Hire date"},
    {"name": "sal", "table": "t1", "column": "sal", "label": "Salary", "format": "FML999G990D00", "description": "Monthly salary"},
    {"name": "comm", "table": "t1", "column": "comm", "label": "Commission", "format": "FML999G990D00"},
    {"name": "dname", "table": "t2", "column": "dname", "label": "Department"},
    {"name": "loc", "table": "t2", "column": "loc", "label": "Location", "description": "Where the department is"}]',
  '[{"table": "t1", "column": "active", "op": "eq", "value": "true"}]',
  'admin')
on conflict (workspace_id, name) do nothing;
