-- =====================================================================
-- HR example, part 70: data security per table (sprint 119, WS-13;
-- docs/guide/08-security.md "Data security per table")
--
-- hr.emp_masked, the masking view that SQL Workshop › hr.emp › Security
-- writes when sal and comm are masked (empty) for everyone but the
-- application role manager. It runs as hr_masking, so row level security
-- on hr.emp would still apply inside it. hr_app keeps SELECT on hr.emp
-- because the other pages read it: the Security page warns that the mask
-- holds only where the view is read.
--
-- Page 48 "Salaries (masked)": a report on the view. Signed in as KING
-- (manager) it shows salaries; as ALLEN (no manager role) they are empty.
-- =====================================================================

do $role$ begin
  if not exists (select from pg_roles where rolname = 'hr_masking') then
    create role hr_masking nologin;
  end if;
end $role$;
grant hr_masking to current_user;
grant usage on schema hr to hr_masking;
grant select on hr.emp to hr_masking;
grant hr_app to hr_masking;

create view hr.emp_masked with (security_barrier) as
select t.empno,
       t.ename,
       t.job,
       t.mgr,
       t.hiredate,
       case when (select meta.has_role('manager')) then t.sal end as sal,
       case when (select meta.has_role('manager')) then t.comm end as comm,
       t.deptno,
       t.active,
       t.username,
       t.photo,
       t.photo_name,
       t.photo_mime,
       t.work_location
  from hr.emp t;
alter view hr.emp_masked owner to hr_masking;
comment on view hr.emp_masked is 'pgkiln masking view of emp: {"table":"emp","roles":["manager"],"cols":{"comm":{"mask":"null","see":["manager"],"others":false},"sal":{"mask":"null","see":["manager"],"others":false}}}';
grant select on hr.emp_masked to hr_app;

do $check$ begin
  if exists (select from pg_roles r where r.rolname = 'hr_masking'
              and (r.rolsuper or r.rolbypassrls or pg_has_role(r.oid, (select relowner from pg_class where oid = 'hr.emp'::regclass), 'USAGE'))) then
    raise exception 'the masking role hr_masking would bypass row level security on hr.emp';
  end if;
end $check$;

insert into meta.page (app_id, page_no, name, title, parent_page)
select id, 48, 'Salaries (masked)', 'Salaries (masked)', 1 from meta.app where alias = 'hr';

insert into meta.region (page_id, seq, title, type, columns, template, source, config)
select p.id, r.seq, r.title, r.type, 12, 'standard', r.source, r.config::jsonb
  from meta.page p join meta.app a on a.id = p.app_id, (values
  (10, 'Salaries (masked)', 'static',
   '<p>This report reads <code>hr.emp_masked</code>: salary and commission are only shown to the role <b>manager</b>. Open SQL Workshop › hr.emp › Security to change who sees what.</p>', '{}'),
  (20, 'Employees', 'report',
   'select ename, job, sal, comm from hr.emp_masked where active order by ename',
   '{"page_size": 15, "headings": {"ename": "Name", "job": "Job", "sal": "Salary", "comm": "Commission"}}')
  ) as r (seq, title, type, source, config)
 where a.alias = 'hr' and p.page_no = 48;

insert into meta.nav_entry (app_id, seq, label, icon, target_page)
select id, 35, 'Salaries (masked)', 'shield', 48 from meta.app where alias = 'hr';

insert into meta.translation (app_id, language, source, target)
select a.id, 'nl', t.source, t.target
  from meta.app a, (values
  ('Salaries (masked)', 'Salarissen (gemaskeerd)'),
  ('Employees', 'Medewerkers'),
  ('Salary', 'Salaris'),
  ('Commission', 'Commissie')
  ) as t(source, target)
 where a.alias = 'hr'
on conflict do nothing;
