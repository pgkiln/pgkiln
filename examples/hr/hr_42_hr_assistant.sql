-- =====================================================================
-- HR example, part 42: AI assistant with tools, and questions in your own
-- words on a report (docs/guide/04-pages-and-regions.md, "AI assistant")
--
-- Page 38 "HR assistant":
--   - "Ask HR": an AI assistant region (a chat). Before each question the
--     context query looks up matching passages of the HR policies
--     (hr.policy, full-text search on the question); the model may call
--     four tools, all run as the application's role (hr_app, so row level
--     security applies): my_leave (the user's leave requests), staff
--     (employees by department or job), departments (with their head
--     count) and request_leave, which files a leave request with
--     hr.request_leave (the only tool that may change data).
--   - "Staff list": an interactive report with "Ask in your own words":
--     e.g. "analysts and managers hired before 1982, highest salary first"
--     becomes the report's filters and sort.
--
-- Like part 41, the example creates no AI service: an administrator adds
-- one named HR_ASSISTANT (Claude or OpenAI) under App Builder → Workspace
-- utilities → AI services and allows the HR application to use it. Until
-- then the page says so. Questions, policy passages and the tools' results
-- are sent to the provider of that service.
-- =====================================================================

create table hr.policy (
  id     int generated always as identity primary key,
  title  text not null,
  body   text not null
);
grant select on hr.policy to hr_app;

insert into hr.policy (title, body) values
  ('Annual leave', 'Every employee has 25 days of paid annual leave per calendar year. Up to 5 unused days move to the next year and expire on 1 July.'),
  ('Requesting leave', 'Request leave at least two weeks ahead for periods longer than three days. Your manager approves or rejects the request; you can withdraw a pending request.'),
  ('Sick leave', 'Report sickness to your manager before 10:00 on the first day. From the third day a doctor''s note is needed.'),
  ('Public holidays', 'The office is closed on public holidays; they do not count as leave days.'),
  ('Working from home', 'Employees may work from home up to two days a week after agreeing the days with their manager.');

insert into meta.page (app_id, page_no, name, title, parent_page)
select id, 38, 'HR assistant', 'HR assistant', 1 from meta.app where alias = 'hr';

insert into meta.region (page_id, seq, title, type, columns, template, source, condition, config)
select p.id, r.seq, r.title, r.type, r.cols, 'standard', r.source, r.cond, r.config::jsonb
  from meta.page p join meta.app a on a.id = p.app_id, (values
  (10, 'No AI service yet', 'static', 12,
   '<p class="alert alert-info">No AI service is configured for this application yet. An administrator adds an AI service named <b>HR_ASSISTANT</b> (Claude or OpenAI, with an API key) under <i>App Builder → Workspace utilities → AI services</i> and allows the HR application to use it.</p>',
   'not meta.ai_available(''HR_ASSISTANT'')', '{}'),
  (20, 'Ask HR', 'ai_assistant', 6, null, 'meta.ai_available(''HR_ASSISTANT'')',
   $j${
     "service": "HR_ASSISTANT",
     "system": "You are the HR assistant of a small company, talking with the employee &APP_USER.. Today is &P38_TODAY.. Answer questions about the HR policies, colleagues, departments and the user's own leave, using the tools and the policy passages you are given; say so when they don't tell. Be brief and friendly. File a leave request (request_leave) only when the user clearly asks for it and the dates are clear; repeat the dates before you do.",
     "welcome": "Hello! Ask me about your leave, colleagues, departments or the HR policies. I can also file a leave request for you.",
     "placeholder": "e.g. How many leave requests do I have pending?",
     "context": [
       {"name": "policy",
        "sql": "select title, body from hr.policy where to_tsvector('english', title || ' ' || body) @@ to_tsquery('english', coalesce(nullif(replace(plainto_tsquery('english', :AI_PROMPT)::text, '&', '|'), ''), 'leave')) order by id limit 3"}
     ],
     "tools": [
       {"name": "my_leave", "description": "The signed-in user's own leave requests (newest first), optionally only those with one status.",
        "sql": "select id, start_date, end_date, days, status, reason, decision_note from hr.leave_request where empno = hr.current_empno() and (:STATUS is null or status = :STATUS) order by start_date desc",
        "parameters": {"STATUS": {"type": "string", "enum": ["PENDING", "APPROVED", "REJECTED", "WITHDRAWN"], "optional": true, "description": "Only requests with this status."}}},
       {"name": "staff", "description": "Employees with their job, department, location and hire date; optionally only one department or job (case-insensitive).",
        "sql": "select ename, job, dname, loc, hiredate from hr.staff_v where active and (:DNAME is null or dname ilike :DNAME) and (:JOB is null or job ilike :JOB) order by ename",
        "parameters": {"DNAME": {"type": "string", "optional": true, "description": "A department name, e.g. SALES."},
                       "JOB": {"type": "string", "optional": true, "description": "A job, e.g. MANAGER."}}},
       {"name": "departments", "description": "The departments with their location and number of active employees.",
        "sql": "select d.dname, d.loc, count(e.empno) filter (where e.active) as employees from hr.dept d left join hr.emp e on e.deptno = d.deptno group by d.deptno order by d.dname"},
       {"name": "request_leave", "description": "Files a leave request for the signed-in user (their manager is notified). Returns the request's id.",
        "sql": "select hr.request_leave(:START_DATE::date, :END_DATE::date, :REASON) as request_id",
        "parameters": {"START_DATE": {"type": "date", "description": "The first day of leave."},
                       "END_DATE": {"type": "date", "description": "The last day of leave."},
                       "REASON": {"type": "string", "description": "The reason in a few words."}},
        "writes": true}
     ],
     "max_rounds": 5,
     "max_turns": 20,
     "error_message": "The HR assistant could not answer just now. Please try again later."
   }$j$),
  (30, 'Staff list', 'report', 6,
   'select empno, ename, job, dname, loc, hiredate, sal from hr.staff_v where active',
   null,
   $j${"page_size": 10, "headings": {"empno": "No.", "ename": "Name", "dname": "Department", "loc": "Location", "hiredate": "Hired", "sal": "Salary"},
       "ai_filter": {"service": "HR_ASSISTANT", "placeholder": "e.g. analysts and managers hired before 1982, highest salary first"}}$j$)
  ) as r (seq, title, type, cols, source, cond, config)
 where a.alias = 'hr' and p.page_no = 38;

insert into meta.item (page_id, region_id, seq, name, label, type)
select p.id, r.id, 10, 'P38_TODAY', 'Today', 'hidden'
  from meta.page p join meta.app a on a.id = p.app_id and a.alias = 'hr'
  join meta.region r on r.page_id = p.id and r.seq = 10
 where p.page_no = 38;

-- the model needs today's date to read "next week"
insert into meta.computation (page_id, seq, item_name, point, type, expression)
select p.id, 10, 'P38_TODAY', 'before_header', 'sql_query', $q$select to_char(current_date, 'YYYY-MM-DD (FMDay)')$q$
  from meta.page p join meta.app a on a.id = p.app_id where a.alias = 'hr' and p.page_no = 38;

insert into meta.nav_entry (app_id, seq, label, icon, target_page)
select id, 30, 'HR assistant', 'users', 38 from meta.app where alias = 'hr';

insert into meta.translation (app_id, language, source, target)
select a.id, 'nl', t.source, t.target
  from meta.app a, (values
  ('HR assistant', 'HR-assistent'),
  ('Ask HR', 'Vraag het HR'),
  ('Staff list', 'Personeelslijst'),
  ('Hello! Ask me about your leave, colleagues, departments or the HR policies. I can also file a leave request for you.',
   'Hallo! Vraag me naar je verlof, collega''s, afdelingen of het HR-beleid. Ik kan ook een verlofaanvraag voor je indienen.'),
  ('e.g. How many leave requests do I have pending?', 'bijv. Hoeveel verlofaanvragen staan er nog open?'),
  ('e.g. analysts and managers hired before 1982, highest salary first', 'bijv. analisten en managers in dienst vóór 1982, hoogste salaris eerst')
  ) as t (source, target)
 where a.alias = 'hr'
on conflict do nothing;
