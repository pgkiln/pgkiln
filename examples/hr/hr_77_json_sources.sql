-- =====================================================================
-- HR example, part 77: a JSON source (sprint 142, AP-8; migration 142;
-- docs/guide/19-rest-data-sources.md "JSON sources")
--
-- hr.emp gets a jsonb column "profile": a document per employee with a
-- job title, a start date, an office, skills (objects) and languages
-- (values), and keys no form knows about (e.g. "badge"). JSON source
-- EMP_PROFILE (Shared Components → JSON sources) describes it, and the
-- three views below are what its "Create views" makes:
--
--   hr.emp_profile            empno and a column per path (title, since,
--                             office_city, office_floor, remote);
--   hr.emp_profile_skills     a row per skill: empno, row_key, position,
--                             skill, level;
--   hr.emp_profile_languages  a row per language.
--
-- Saving the form changes only the paths whose values changed, so "badge"
-- and anything else in the document stay. Page 51 "Employee profiles"
-- (Administration): a report of the employees with JSON path columns
-- (title and first skill read from the document), a form on
-- hr.emp_profile and the skills and languages as detail grids.
-- =====================================================================

alter table hr.emp add column if not exists profile jsonb
  check (profile is null or jsonb_typeof(profile) = 'object');
comment on column hr.emp.profile is 'Profile document (JSON source EMP_PROFILE): title, since, office {city, floor}, remote, skills [{name, level}], languages []';

update hr.emp e set profile = p.doc::jsonb
  from (values
  (7839, '{"title": "Chief executive", "since": "1981-11-17", "office": {"city": "New York", "floor": 30}, "remote": false,
           "skills": [{"name": "Strategy", "level": 5}, {"name": "Negotiation", "level": 4}], "languages": ["en", "fr"],
           "badge": {"color": "gold", "printed": "2024-01-08"}}'),
  (7698, '{"title": "Sales manager", "since": "1981-05-01", "office": {"city": "Chicago", "floor": 12}, "remote": false,
           "skills": [{"name": "Sales", "level": 5}, {"name": "Coaching", "level": 3, "certified": true}], "languages": ["en", "es"]}'),
  (7782, '{"title": "Accounting manager", "since": "1981-06-09", "office": {"city": "New York", "floor": 28},
           "skills": [{"name": "Accounting", "level": 5}, {"name": "SQL", "level": 3}], "languages": ["en"]}'),
  (7566, '{"title": "Research manager", "since": "1981-04-02", "office": {"city": "Dallas", "floor": 4}, "remote": true,
           "skills": [{"name": "PostgreSQL", "level": 5}, {"name": "Statistics", "level": 4}], "languages": ["en", "de", "nl"],
           "badge": {"color": "blue"}}'),
  (7788, '{"title": "Analyst", "since": "1987-04-19", "office": {"city": "Dallas"}, "remote": true,
           "skills": [{"name": "SQL", "level": 5}, {"name": "TypeScript", "level": 3}], "languages": ["en"]}')
  ) as p (empno, doc)
 where e.empno = p.empno and e.profile is null;

-- the JSON source (the builder writes this list; it travels with the application's export)
update meta.app set json_sources = json_sources || $j$[{"name": "EMP_PROFILE",
  "description": "The employee profile (hr.emp.profile): job title, office, skills and languages",
  "schema": "hr", "table": "emp", "key": ["empno"], "column": "profile", "view": "emp_profile",
  "columns": [{"name": "title", "path": ["title"], "type": "text"}, {"name": "since", "path": ["since"], "type": "date"},
              {"name": "office_city", "path": ["office", "city"], "type": "text"},
              {"name": "office_floor", "path": ["office", "floor"], "type": "integer"},
              {"name": "remote", "path": ["remote"], "type": "boolean"}],
  "arrays": [{"name": "skills", "path": ["skills"], "view": "emp_profile_skills",
              "columns": [{"name": "skill", "path": ["name"], "type": "text"}, {"name": "level", "path": ["level"], "type": "integer"}]},
             {"name": "languages", "path": ["languages"], "view": "emp_profile_languages",
              "columns": [{"name": "language", "path": [], "type": "text"}]}]}]$j$::jsonb
 where alias = 'hr' and not json_sources @> '[{"name": "EMP_PROFILE"}]';

-- the views, as Shared Components → JSON sources → Create views makes them
create view hr.emp_profile with (security_invoker = true) as
select t.empno,
       t.profile #>> array['title'] as title,
       case when meta.input_ok(t.profile #>> array['since'], 'date') then (t.profile #>> array['since'])::date end as since,
       t.profile #>> array['office', 'city'] as office_city,
       case when meta.input_ok(t.profile #>> array['office', 'floor'], 'integer') then (t.profile #>> array['office', 'floor'])::integer end as office_floor,
       case when meta.input_ok(t.profile #>> array['remote'], 'boolean') then (t.profile #>> array['remote'])::boolean end as remote
  from hr.emp t;

comment on view hr.emp_profile is 'JSON source EMP_PROFILE of application hr: hr.emp.profile (made by pgkiln; Shared Components → JSON sources makes it again)';

create trigger json_source_write
  instead of insert or update or delete on hr.emp_profile
  for each row execute function meta.json_source_write('{"name":"EMP_PROFILE","schema":"hr","table":"emp","key":["empno"],"column":"profile","rows":false,"columns":[{"name":"title","path":["title"]},{"name":"since","path":["since"]},{"name":"office_city","path":["office","city"]},{"name":"office_floor","path":["office","floor"]},{"name":"remote","path":["remote"]}]}');

grant delete, insert, select, update on hr.emp_profile to "hr_app";

create view hr.emp_profile_skills with (security_invoker = true) as
select t.empno,
       k.key as row_key,
       k.idx + 1 as position,
       e.v #>> array['name'] as skill,
       case when meta.input_ok(e.v #>> array['level'], 'integer') then (e.v #>> array['level'])::integer end as level
  from hr.emp t
  cross join lateral meta.jsonb_element_keys(t.profile #> array['skills']) k
  cross join lateral (select (t.profile #> array['skills']) -> k.idx as v) e;

comment on view hr.emp_profile_skills is 'JSON source EMP_PROFILE of application hr: the array skills of hr.emp.profile, one row per element (made by pgkiln)';

create trigger json_source_write
  instead of insert or update or delete on hr.emp_profile_skills
  for each row execute function meta.json_array_write('{"name":"EMP_PROFILE","schema":"hr","table":"emp","key":["empno"],"column":"profile","array":["skills"],"row_key":"row_key","position":"position","columns":[{"name":"skill","path":["name"]},{"name":"level","path":["level"]}]}');

grant delete, insert, select, update on hr.emp_profile_skills to "hr_app";

create view hr.emp_profile_languages with (security_invoker = true) as
select t.empno,
       k.key as row_key,
       k.idx + 1 as position,
       e.v #>> array[]::text[] as language
  from hr.emp t
  cross join lateral meta.jsonb_element_keys(t.profile #> array['languages']) k
  cross join lateral (select (t.profile #> array['languages']) -> k.idx as v) e;

comment on view hr.emp_profile_languages is 'JSON source EMP_PROFILE of application hr: the array languages of hr.emp.profile, one row per element (made by pgkiln)';

create trigger json_source_write
  instead of insert or update or delete on hr.emp_profile_languages
  for each row execute function meta.json_array_write('{"name":"EMP_PROFILE","schema":"hr","table":"emp","key":["empno"],"column":"profile","array":["languages"],"row_key":"row_key","position":"position","columns":[{"name":"language","path":[]}]}');

grant delete, insert, select, update on hr.emp_profile_languages to "hr_app";

-- ---------------------------------------------------------------- page 51

insert into meta.page (app_id, page_no, name, title, parent_page)
select id, 51, 'Employee profiles', 'Employee profiles', 1 from meta.app where alias = 'hr';

insert into meta.region (page_id, seq, title, type, columns, source, table_name, pk_column, pk_item, condition, config)
select p.id, r.seq, r.title, r.type, r.cols, r.source, r.table_name, r.pk_column, r.pk_item, r.condition, r.config::jsonb
  from meta.page p join meta.app a on a.id = p.app_id, (values
  (10, 'Employees', 'report', 12,
   'select empno, ename, job, profile from hr.emp order by profile is null, ename', null, null, null, null,
   '{"hidden": ["profile"], "headings": {"empno": "No.", "ename": "Name", "job": "Job", "title": "Title (profile)", "first_skill": "First skill", "since": "Since"},
     "json_columns": [{"name": "title", "column": "profile", "path": "title", "type": "text"},
                      {"name": "first_skill", "column": "profile", "path": "skills.0.name", "type": "text"},
                      {"name": "since", "column": "profile", "path": "since", "type": "date"}],
     "link": {"page": 51, "column": "empno", "items": {"P51_EMPNO": "#empno#"}}, "page_size": 5}'),
  (20, 'Profile', 'form', 12, null, 'hr.emp_profile', 'empno', 'P51_EMPNO', ':P51_EMPNO is not null', '{}'),
  (30, 'Skills', 'grid', 8,
   'select empno, row_key, position, skill, level
  from hr.emp_profile_skills
 where empno::text = :P51_EMPNO
 order by position', 'hr.emp_profile_skills', 'row_key', null, ':P51_EMPNO is not null',
   '{"master": {"item": "P51_EMPNO", "column": "empno"}, "readonly": ["position"], "layout": {"hidden": ["empno", "row_key"]},
     "headings": {"position": "#", "skill": "Skill", "level": "Level (1-5)"}, "columns": {"skill": {"required": true}}, "row_actions": {"delete": true}}'),
  (40, 'Languages', 'grid', 4,
   'select empno, row_key, position, language
  from hr.emp_profile_languages
 where empno::text = :P51_EMPNO
 order by position', 'hr.emp_profile_languages', 'row_key', null, ':P51_EMPNO is not null',
   '{"master": {"item": "P51_EMPNO", "column": "empno"}, "readonly": ["position"], "layout": {"hidden": ["empno", "row_key"]},
     "headings": {"position": "#", "language": "Language"}, "row_actions": {"delete": true}}')
  ) as r (seq, title, type, cols, source, table_name, pk_column, pk_item, condition, config)
 where a.alias = 'hr' and p.page_no = 51;

insert into meta.item (page_id, region_id, seq, name, label, type, source_column)
select p.id, r.id, i.seq, i.name, i.label, i.type, i.col
  from meta.page p join meta.app a on a.id = p.app_id
  join meta.region r on r.page_id = p.id and r.title = 'Profile', (values
  (10, 'P51_EMPNO', 'Employee', 'hidden', 'empno'),
  (20, 'P51_TITLE', 'Title', 'text', 'title'),
  (30, 'P51_SINCE', 'Since', 'date', 'since'),
  (40, 'P51_OFFICE_CITY', 'Office city', 'text', 'office_city'),
  (50, 'P51_OFFICE_FLOOR', 'Office floor', 'number', 'office_floor'),
  (60, 'P51_REMOTE', 'Works remotely', 'switch', 'remote')
  ) as i (seq, name, label, type, col)
 where a.alias = 'hr' and p.page_no = 51;

insert into meta.button (page_id, region_id, seq, name, label, action, hot)
select p.id, r.id, 10, 'SAVE', 'Apply Changes', 'submit', true
  from meta.page p join meta.app a on a.id = p.app_id
  join meta.region r on r.page_id = p.id and r.title = 'Profile'
 where a.alias = 'hr' and p.page_no = 51;

insert into meta.process (page_id, region_id, seq, name, type, point)
select p.id, r.id, r.seq, case r.type when 'form' then 'Process form Profile' else 'Save ' || r.title end,
       case r.type when 'form' then 'form_dml' else 'grid_dml' end, 'submit'
  from meta.page p join meta.app a on a.id = p.app_id
  join meta.region r on r.page_id = p.id and r.type in ('form', 'grid')
 where a.alias = 'hr' and p.page_no = 51;

insert into meta.nav_entry (app_id, parent_id, seq, label, icon, target_page)
select a.id, n.id, 80, 'Employee profiles', 'id-card', 51
  from meta.app a join meta.nav_entry n on n.app_id = a.id and n.label = 'Administration' and n.parent_id is null
 where a.alias = 'hr';
