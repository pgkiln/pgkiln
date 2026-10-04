-- =====================================================================
-- HR example, part 24: a planner calendar and more chart types
-- (docs/guide/04-pages-and-regions.md, calendar and chart regions)
--
-- Page 24 "Planner":
--   - a calendar of team meetings with month, week, day and list views;
--     a click on an empty day or hour opens the form below with the time
--     filled in (create on click), and organizers drag meetings to move
--     them (hr.move_meeting, run as hr_app; RLS hides private meetings);
--   - a bubble chart and gauges that drill down to the employee list of a
--     department, a funnel of leave requests and a radar of jobs per
--     department.
-- =====================================================================

create table hr.meeting (
  id        serial primary key,
  title     text not null,
  starts_at timestamp not null,
  ends_at   timestamp,
  private   boolean not null default false,
  organizer text not null default meta.app_user(),
  check (ends_at is null or ends_at >= starts_at)
);
grant select, insert, update, delete on hr.meeting to hr_app;
grant usage on sequence hr.meeting_id_seq to hr_app;

alter table hr.meeting enable row level security;
create policy meeting_visible on hr.meeting for select
  using (not private or lower(organizer) = lower(meta.app_user()) or meta.has_role('admin'));
create policy meeting_insert on hr.meeting for insert
  with check (lower(organizer) = lower(meta.app_user()));
create policy meeting_update on hr.meeting for update
  using (lower(organizer) = lower(meta.app_user()) or meta.has_role('admin'));
create policy meeting_delete on hr.meeting for delete
  using (lower(organizer) = lower(meta.app_user()) or meta.has_role('admin'));

-- The calendar's drag and drop calls this (as hr_app): only the organizer (or an admin) may move a meeting.
create function hr.move_meeting(p_id int, p_start timestamp, p_end timestamp) returns void
language plpgsql as $$
begin
  update hr.meeting set starts_at = p_start, ends_at = p_end where id = p_id;
  if not found then
    raise exception 'Only the organizer can move this meeting.';
  end if;
end
$$;
grant execute on function hr.move_meeting(int, timestamp, timestamp) to hr_app;

-- meetings around this week (Monday = d)
insert into hr.meeting (title, starts_at, ends_at, private, organizer)
select x.title, d + x.s, d + x.e, x.p, x.o
  from (select date_trunc('week', current_date)::timestamp as d) w(d),
       (values ('Team stand-up',         interval '0 days 09:00', interval '0 days 09:30', false, 'king'),
               ('Budget review',         interval '1 days 13:00', interval '1 days 15:00', false, 'king'),
               ('Interview: analyst',    interval '2 days 10:00', interval '2 days 11:00', false, 'blake'),
               ('Sales kick-off',        interval '3 days',       interval '4 days',       false, 'blake'),
               ('One-to-one with Jones', interval '3 days 16:00', interval '3 days 16:30', true,  'king'),
               ('Research demo',         interval '8 days 14:00', interval '8 days 15:30', false, 'jones'),
               ('Quarterly planning',    interval '10 days',      interval '10 days',      false, 'king')
       ) x(title, s, e, p, o);

insert into meta.page (app_id, page_no, name, title, parent_page)
select id, 24, 'Planner', 'Planner', 1 from meta.app where alias = 'hr';

insert into meta.region (page_id, seq, title, type, columns, template, source, config)
select p.id, r.seq, r.title, r.type, r.cols, r.tpl, r.source, r.config::jsonb
  from meta.page p join meta.app a on a.id = p.app_id, (values
  (10, 'Meetings', 'calendar', 8, 'standard',
   $q$select m.id, m.title || case when m.private then ' (private)' else '' end as title,
       m.starts_at as start_date, m.ends_at as end_date
  from hr.meeting m$q$,
   $j${"view": "week",
       "link": {"page": 24, "items": {"P24_ID": "#id#"}},
       "create": {"page": 24, "items": {"P24_STARTS_AT": "#start#", "P24_ENDS_AT": "#end#"}},
       "move": "select hr.move_meeting(:EVENT_ID::int, :NEW_START::timestamp, :NEW_END::timestamp)",
       "move_authz": "MUST_NOT_BE_PUBLIC_USER"}$j$),
  (30, 'Departments: service, pay and size', 'chart', 6, 'standard',
   $q$select d.dname as department,
       round(avg(extract(year from age(current_date, e.hiredate)))::numeric, 1) as "Years of service",
       round(avg(e.sal)) as "Average salary",
       count(*) as "Employees",
       d.deptno
  from hr.emp e join hr.dept d using (deptno)
 where e.active
 group by d.deptno, d.dname
 order by 1$q$,
   '{"kind": "bubble", "link": {"page": 2, "items": {"P2_DEPTNO": "#deptno#"}}}'),
  (40, 'Monthly payroll against budget (%)', 'chart', 6, 'standard',
   $q$select d.dname as department, round(100.0 * coalesce(sum(e.sal), 0) / 10000) as "Budget used", d.deptno
  from hr.dept d left join hr.emp e on e.deptno = d.deptno and e.active
 group by d.deptno, d.dname
 order by 1$q$,
   '{"kind": "gauge", "gauge": {"min": 0, "max": 120, "warning": 80, "critical": 100}, "link": {"page": 2, "items": {"P2_DEPTNO": "#deptno#"}}}'),
  (50, 'Leave requests: from request to approval', 'chart', 6, 'standard',
   $q$select stage, n as "Requests" from (
  select 1 as k, 'Requested' as stage, count(*) as n from hr.leave_request
  union all select 2, 'Decided', count(*) filter (where status in ('APPROVED', 'REJECTED')) from hr.leave_request
  union all select 3, 'Approved', count(*) filter (where status = 'APPROVED') from hr.leave_request
) s order by k$q$,
   '{"kind": "funnel"}'),
  (60, 'Jobs per department', 'chart', 6, 'standard',
   $q$select initcap(j.job) as job,
       count(e.empno) filter (where e.deptno = 10) as "Accounting",
       count(e.empno) filter (where e.deptno = 20) as "Research",
       count(e.empno) filter (where e.deptno = 30) as "Sales"
  from (values ('CLERK'), ('SALESMAN'), ('ANALYST'), ('MANAGER'), ('PRESIDENT')) j(job)
  left join hr.emp e on e.job = j.job and e.active
 group by j.job
 order by 1$q$,
   '{"kind": "radar"}')
) r(seq, title, type, cols, tpl, source, config)
 where a.alias = 'hr' and p.page_no = 24;

-- the meeting form next to the calendar: new (from a click on a slot) or the meeting clicked
insert into meta.region (page_id, seq, title, type, columns, template, table_name, pk_column, pk_item)
select p.id, 20, 'Meeting', 'form', 4, 'standard', 'hr.meeting', 'id', 'P24_ID'
  from meta.page p join meta.app a on a.id = p.app_id where a.alias = 'hr' and p.page_no = 24;

insert into meta.item (page_id, region_id, seq, name, label, type, source_column, required, readonly_condition, help)
select p.id, r.id, i.seq, i.name, i.label, i.type, i.col, i.req, i.ro, i.help
  from meta.page p join meta.app a on a.id = p.app_id join meta.region r on r.page_id = p.id and r.type = 'form', (values
  (10, 'P24_ID', null, 'hidden', 'id', false, null, null),
  (20, 'P24_TITLE', 'Title', 'text', 'title', true, null, null),
  (30, 'P24_STARTS_AT', 'Starts', 'datetime', 'starts_at', true, null, 'Click an empty day or hour in the calendar to fill this in.'),
  (40, 'P24_ENDS_AT', 'Ends', 'datetime', 'ends_at', false, null, null),
  (50, 'P24_PRIVATE', 'Private', 'switch', 'private', false, null, 'Only you (and administrators) see a private meeting.'),
  (60, 'P24_ORGANIZER', 'Organizer', 'display', 'organizer', false, null, null)
) i(seq, name, label, type, col, req, ro, help)
 where a.alias = 'hr' and p.page_no = 24;

insert into meta.button (page_id, region_id, seq, name, label, action, target_page, condition, hot, confirm)
select p.id, r.id, b.seq, b.name, b.label, b.action, 24, b.cond, b.hot, b.confirm
  from meta.page p join meta.app a on a.id = p.app_id join meta.region r on r.page_id = p.id and r.type = 'form', (values
  (10, 'CANCEL', 'New meeting', 'redirect', ':P24_ID is not null', false, null),
  (20, 'DELETE', 'Delete', 'submit', ':P24_ID is not null', false, 'Delete this meeting?'),
  (30, 'SAVE', 'Save', 'submit', ':P24_ID is not null', true, null),
  (40, 'CREATE', 'Add meeting', 'submit', ':P24_ID is null', true, null)
) b(seq, name, label, action, cond, hot, confirm)
 where a.alias = 'hr' and p.page_no = 24;

insert into meta.process (page_id, seq, name, type, region_id, success_message)
select p.id, 10, 'Save meeting', 'form_dml', r.id, 'Meeting saved.'
  from meta.page p join meta.app a on a.id = p.app_id join meta.region r on r.page_id = p.id and r.type = 'form'
 where a.alias = 'hr' and p.page_no = 24;

insert into meta.nav_entry (app_id, seq, label, icon, target_page)
select id, 3, 'Planner', 'calendar', 24 from meta.app where alias = 'hr';

insert into meta.translation (app_id, language, source, target)
select a.id, 'nl', t.source, t.target
  from meta.app a, (values
  ('Planner', 'Planner'),
  ('Meetings', 'Vergaderingen'),
  ('Meeting', 'Vergadering'),
  ('Departments: service, pay and size', 'Afdelingen: dienstjaren, salaris en omvang'),
  ('Monthly payroll against budget (%)', 'Maandsalarissen tegen budget (%)'),
  ('Leave requests: from request to approval', 'Verlofaanvragen: van aanvraag tot goedkeuring'),
  ('Jobs per department', 'Functies per afdeling'),
  ('Title', 'Titel'),
  ('Starts', 'Begint'),
  ('Ends', 'Eindigt'),
  ('Private', 'Privé'),
  ('Organizer', 'Organisator'),
  ('New meeting', 'Nieuwe vergadering'),
  ('Add meeting', 'Vergadering toevoegen'),
  ('Meeting saved.', 'Vergadering opgeslagen.'),
  ('Click an empty day or hour in the calendar to fill this in.', 'Klik op een lege dag of een leeg uur in de kalender om dit in te vullen.'),
  ('Only you (and administrators) see a private meeting.', 'Alleen jij (en beheerders) zien een privévergadering.')
) t(source, target)
 where a.alias = 'hr'
on conflict do nothing;
