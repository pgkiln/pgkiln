-- =====================================================================
-- HR example, part 61: a Form Designer (docs/guide/04-pages-and-regions.md,
-- "Form Designer")
--
-- Page 45 "Forms": the application's administrators (authorization scheme
-- ADMIN) build data entry forms on three tables the developer offers in the
-- region's settings, and publish them for every employee:
--   - "Departments": hr.dept, add and change rows;
--   - "Meetings": hr.meeting, add, change and delete rows; its row level
--     security still applies (an employee changes only their own meetings);
--   - "Employees": hr.emp, change rows only, with the job and department
--     as lists of values.
-- Two published forms are there to start from: "Departments" (a list of
-- departments with Add and Edit) and "Book a meeting" (no list: the form
-- only adds rows). Forms are installation data: not part of the export.
-- =====================================================================

insert into meta.page (app_id, page_no, name, title, parent_page)
select id, 45, 'Forms', 'Forms', 1 from meta.app where alias = 'hr';

insert into meta.region (page_id, seq, title, type, columns, template, config)
select p.id, 10, 'Form Designer', 'form_designer', 12, 'standard', $j${
  "design_authz": "ADMIN",
  "page_size": 15,
  "sources": [
    {"id": "departments", "label": "Departments", "description": "Department names and locations.",
     "schema": "hr", "table": "dept", "key": "deptno", "insert": true, "update": true, "delete": false,
     "columns": [{"name": "dname", "label": "Department"}, {"name": "loc", "label": "Location"}]},
    {"id": "meetings", "label": "Meetings", "description": "Meetings in the planner; employees change only their own.",
     "schema": "hr", "table": "meeting", "key": "id", "insert": true, "update": true, "delete": true,
     "columns": [{"name": "title", "label": "Title"}, {"name": "starts_at", "label": "Starts"}, {"name": "ends_at", "label": "Ends"}, {"name": "private", "label": "Private"}]},
    {"id": "employees", "label": "Employees", "description": "Job, department and salary of employees.",
     "schema": "hr", "table": "emp", "key": "empno", "insert": false, "update": true, "delete": false,
     "columns": [{"name": "ename", "label": "Name"}, {"name": "job", "label": "Job", "lov": "LOV:JOBS"}, {"name": "deptno", "label": "Department", "lov": "LOV:DEPARTMENTS"},
                 {"name": "hiredate", "label": "Hire date"}, {"name": "sal", "label": "Salary"}]}
  ]}$j$::jsonb
  from meta.page p join meta.app a on a.id = p.app_id
 where a.alias = 'hr' and p.page_no = 45;

-- two published forms to start from (forms are installation data: not part of the export)
insert into meta.user_form (app_id, region_id, name, description, published, definition, created_by, updated_by)
select a.id, r.id, f.name, f.description, true, f.definition, 'king', 'king'
  from meta.app a join meta.page p on p.app_id = a.id and p.page_no = 45 join meta.region r on r.page_id = p.id and r.type = 'form_designer',
       (values
  ('Departments', 'Add a department or change its name and location.',
   '{"source": "departments",
     "fields": [{"column": "dname", "label": "", "help": "", "required": true, "display": "auto", "default": ""},
                {"column": "loc", "label": "", "help": "The city.", "required": false, "display": "auto", "default": ""}],
     "list": ["dname", "loc"], "actions": {"insert": true, "update": true, "delete": false}}'::jsonb),
  ('Book a meeting', 'Put a meeting in the planner.',
   '{"source": "meetings",
     "fields": [{"column": "title", "label": "What", "help": "", "required": true, "display": "auto", "default": ""},
                {"column": "starts_at", "label": "", "help": "", "required": true, "display": "auto", "default": ""},
                {"column": "ends_at", "label": "", "help": "Leave empty for a meeting without an end.", "required": false, "display": "auto", "default": ""},
                {"column": "private", "label": "Only visible to me", "help": "", "required": false, "display": "auto", "default": "false"}],
     "list": [], "actions": {"insert": true, "update": false, "delete": false}}'::jsonb)
  ) as f (name, description, definition)
 where a.alias = 'hr';

insert into meta.nav_entry (app_id, parent_id, seq, label, icon, target_page)
select a.id, n.id, 60, 'Forms', 'file', 45
  from meta.app a join meta.nav_entry n on n.app_id = a.id and n.label = 'Administration' and n.parent_id is null
 where a.alias = 'hr';

insert into meta.translation (app_id, language, source, target)
select a.id, 'nl', t.source, t.target
  from meta.app a, (values
  ('Forms', 'Formulieren'),
  ('Form Designer', 'Formulierbouwer'),
  ('Department names and locations.', 'Namen en vestigingsplaatsen van afdelingen.'),
  ('Meetings', 'Vergaderingen'),
  ('Meetings in the planner; employees change only their own.', 'Vergaderingen in de planner; medewerkers wijzigen alleen hun eigen.'),
  ('Job, department and salary of employees.', 'Functie, afdeling en salaris van medewerkers.'),
  ('Title', 'Titel'),
  ('Starts', 'Begint'),
  ('Ends', 'Eindigt'),
  ('Private', 'Privé')
  ) as t (source, target)
 where a.alias = 'hr'
on conflict do nothing;
