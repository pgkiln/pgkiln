-- =====================================================================
-- HR example, part 22: page logic without code in the page
-- (docs/guide/06-processing.md "Computations", "Branches", "Build
-- options"; docs/guide/07-dynamic-actions.md; buttons: "Menu buttons and
-- badges")
--
-- Page 22 "Leave planner" checks how many days an employee wants to take:
--   * computations fill the employee (yours, when none is chosen), the
--     name (a PL/pgSQL function body), the pending requests (a query) and,
--     after a submit, round the days (a SQL expression);
--   * branches: "Check" with more than 10 days goes to the leave
--     calendar; "Plan" goes to a new leave request for the employee; the
--     "More" menu's "Start over" comes back to the page, cleared;
--   * the "Check" button shows a badge with the pending requests, the
--     "More" button is a menu of links and a submit request;
--   * dynamic actions: focus on the days, an inline error for 0 days that
--     clears when the value changes, a highlight, and a success message;
--   * build options: LEAVE_FORECAST (excluded) hides the forecast region,
--     which "Planner tips" replaces while it is excluded.
-- =====================================================================

insert into meta.build_option (app_id, name, status, description)
select id, 'LEAVE_FORECAST', 'exclude', 'The leave forecast on the leave planner (not ready yet).'
  from meta.app where alias = 'hr';

insert into meta.page (app_id, page_no, name, title, parent_page)
select id, 22, 'Leave planner', 'Leave planner', 6 from meta.app where alias = 'hr';

insert into meta.region (page_id, seq, title, type, columns, template, source, build_option)
select p.id, r.seq, r.title, r.type, r.columns, 'standard', r.source, r.build_option
  from meta.page p join meta.app a on a.id = p.app_id, (values
  (10, 'Plan your leave', 'static', 8, null, null),
  (20, 'Planner tips', 'static', 4,
   '<p>Choose an employee and the number of days, then <b>Check</b>. More than 10 days takes you to the leave calendar; <b>Plan</b> opens a new leave request.</p>',
   '!LEAVE_FORECAST'),
  (30, 'Forecast', 'report', 4,
   'select status, count(*) as requests from hr.leave_request group by status order by status',
   'LEAVE_FORECAST')
  ) as r (seq, title, type, columns, source, build_option)
 where a.alias = 'hr' and p.page_no = 22;

insert into meta.item (page_id, region_id, seq, name, label, type, lov, required, help)
select p.id, r.id, i.seq, i.name, i.label, i.type, i.lov, i.required, i.help
  from meta.page p join meta.app a on a.id = p.app_id
  join meta.region r on r.page_id = p.id and r.title = 'Plan your leave', (values
  (10, 'P22_EMPNO', 'Employee', 'select', 'select initcap(ename) as d, empno as r from hr.emp where active order by ename', true, null),
  (20, 'P22_NAME', 'Name', 'display', null, false, 'Computed by a PL/pgSQL function body.'),
  (30, 'P22_PENDING', 'Pending requests', 'display', null, false, 'Computed by a SQL query before the page is shown.'),
  (40, 'P22_DAYS', 'Days', 'number', null, false, 'Rounded after a submit (a SQL expression computation).')
  ) as i (seq, name, label, type, lov, required, help)
 where a.alias = 'hr' and p.page_no = 22;

-- computations
insert into meta.computation (page_id, seq, item_name, point, type, expression, condition_type, condition_expr)
select p.id, c.seq, c.item, c.point, c.type, c.expr, c.ctype, c.cexpr
  from meta.page p join meta.app a on a.id = p.app_id, (values
  (10, 'P22_EMPNO', 'before_header', 'sql_query', 'select empno from hr.emp where lower(username) = lower(:APP_USER)', 'item_null', 'P22_EMPNO'),
  (20, 'P22_NAME', 'before_header', 'function_body',
   E'declare\n  v_name text;\nbegin\n  select initcap(ename) || '' ('' || initcap(job) || '')'' into v_name from hr.emp where empno = :P22_EMPNO::int;\n  return v_name;\nend;',
   'item_not_null', 'P22_EMPNO'),
  (30, 'P22_PENDING', 'before_header', 'sql_query', 'select count(*) from hr.leave_request where empno = :P22_EMPNO::int and status = ''PENDING''', null, null),
  (40, 'P22_DAYS', 'after_submit', 'sql_expression', 'round(:P22_DAYS::numeric)', 'item_not_null', 'P22_DAYS')
  ) as c (seq, item, point, type, expr, ctype, cexpr)
 where a.alias = 'hr' and p.page_no = 22;

insert into meta.validation (page_id, seq, name, item_name, type, expression, message, when_button)
select p.id, 10, 'Days between 1 and 30', 'P22_DAYS', 'sql', ':P22_DAYS::numeric between 1 and 30', 'Enter 1 to 30 days.', 'CHECK'
  from meta.page p join meta.app a on a.id = p.app_id where a.alias = 'hr' and p.page_no = 22;

-- buttons: Check (badge), Plan, a menu, Highlight (dynamic action)
insert into meta.button (page_id, region_id, seq, name, label, action, hot, badge, menu)
select p.id, r.id, b.seq, b.name, b.label, b.action, b.hot, b.badge, b.menu::jsonb
  from meta.page p join meta.app a on a.id = p.app_id
  join meta.region r on r.page_id = p.id and r.title = 'Plan your leave', (values
  (10, 'CHECK', 'Check', 'submit', true, '&P22_PENDING.', null),
  (20, 'PLAN', 'Plan', 'submit', false, null, null),
  (30, 'MORE', 'More', 'menu', false, null,
   '[{"label": "Leave requests", "page": 6, "icon": "list"},
     {"label": "Leave calendar", "page": 12, "icon": "calendar"},
     {"label": "Start over", "request": "RESET", "icon": "close"}]'),
  (40, 'HIGHLIGHT', 'Highlight', 'da', false, null, null)
  ) as b (seq, name, label, action, hot, badge, menu)
 where a.alias = 'hr' and p.page_no = 22;

-- branches, in sequence; without one, the page shows again
insert into meta.branch (page_id, seq, name, when_button, condition_type, condition_expr, condition_value, target_page, target_items)
select p.id, b.seq, b.name, b.button, b.ctype, b.cexpr, b.cval, b.page, b.items::jsonb
  from meta.page p join meta.app a on a.id = p.app_id, (values
  (10, 'Long leave: see the calendar', 'CHECK', 'sql', ':P22_DAYS::numeric > 10', null, 12, null),
  (20, 'Plan a request', 'PLAN', null, null, null, 7, '{"P7_EMPNO": "&P22_EMPNO."}'),
  (30, 'Start over', null, 'request_in', null, 'RESET', 22, '{"P22_DAYS": ""}')
  ) as b (seq, name, button, ctype, cexpr, cval, page, items)
 where a.alias = 'hr' and p.page_no = 22;

-- dynamic actions (26.1): focus, inline error, clear errors, CSS class, success message
insert into meta.dynamic_action (page_id, seq, name, event, trigger_element, condition_type, condition_value,
                                 action, affected_items, affected_region_id, message, css_classes)
select p.id, d.seq, d.name, d.event, d.trig, d.ctype, d.cval, d.action, d.affected,
       case when d.region then r.id end, d.message, d.classes
  from meta.page p join meta.app a on a.id = p.app_id
  join meta.region r on r.page_id = p.id and r.title = 'Plan your leave', (values
  (10, 'Start in the days field', 'load', null, null, null, 'set_focus', 'P22_DAYS', false, null, null),
  (20, 'No zero days', 'change', 'P22_DAYS', 'equals', '0', 'show_error', 'P22_DAYS', false, 'Zero days is not a leave.', null),
  (30, 'Clear the error', 'change', 'P22_DAYS', 'not_equals', '0', 'clear_errors', 'P22_DAYS', false, null, null),
  (40, 'Highlight the form', 'click', 'HIGHLIGHT', null, null, 'add_class', null, true, null, 'is-highlight'),
  (50, 'Confirm the highlight', 'click', 'HIGHLIGHT', null, null, 'show_success', null, false, 'The form is highlighted.', null)
  ) as d (seq, name, event, trig, ctype, cval, action, affected, region, message, classes)
 where a.alias = 'hr' and p.page_no = 22;

insert into meta.nav_entry (app_id, parent_id, seq, label, icon, target_page)
select a.id, n.id, 30, 'Leave planner', 'calendar', 22
  from meta.app a join meta.nav_entry n on n.app_id = a.id and n.label = 'Leave requests' and n.parent_id is null
 where a.alias = 'hr';

insert into meta.translation (app_id, language, source, target)
select a.id, 'nl', t.source, t.target
  from meta.app a, (values
  ('Leave planner', 'Verlofplanner'),
  ('Plan your leave', 'Plan je verlof'),
  ('Planner tips', 'Tips'),
  ('Pending requests', 'Openstaande aanvragen'),
  ('Days', 'Dagen'),
  ('Check', 'Controleren'),
  ('Plan', 'Plannen'),
  ('More', 'Meer'),
  ('Start over', 'Opnieuw'),
  ('Highlight', 'Markeren'),
  ('Enter 1 to 30 days.', 'Vul 1 tot 30 dagen in.'),
  ('Zero days is not a leave.', 'Nul dagen is geen verlof.'),
  ('The form is highlighted.', 'Het formulier is gemarkeerd.')
  ) as t (source, target)
 where a.alias = 'hr'
on conflict do nothing;
