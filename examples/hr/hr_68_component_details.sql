-- =====================================================================
-- HR example, part 68: component details of APEX 26.1 (migration 124;
-- docs/guide/05-items.md "Popup LOV", docs/guide/07-dynamic-actions.md
-- "Wait popup" and "Menu entry chosen")
--
-- Page 47 "Component details":
--   * P47_REF, a popup LOV over 6,000 reference numbers: the dialog loads
--     the next 100 as the list scrolls (no More button).
--   * RECALC, a submit button whose process takes two seconds: a dynamic
--     action shows the wait popup on its click; the next page removes it.
--   * CHECK ("Check in the background"): wait popup, an Ajax call (execute_sql,
--     a second and a half) that fills P47_RESULT, remove wait popup.
--   * ACTIONS, a menu button: a link, and two entries that run dynamic
--     actions (event menu_entry): COUNT (the same Ajax call with a wait
--     popup) and HELLO (a success message).
-- =====================================================================

insert into meta.page (app_id, page_no, name, title, parent_page)
select id, 47, 'Component details', 'Component details', 1 from meta.app where alias = 'hr';

insert into meta.region (page_id, seq, title, type, columns, template, source)
select p.id, 10, 'Component details', 'static', 12, 'standard',
       '<p>A popup list of values that loads more rows as you scroll, a wait popup around a long process and an Ajax call, and a menu button whose entries run dynamic actions.</p>'
  from meta.page p join meta.app a on a.id = p.app_id
 where a.alias = 'hr' and p.page_no = 47;

insert into meta.item (page_id, region_id, seq, name, label, type, lov, config, help)
select p.id, r.id, i.seq, i.name, i.label, i.type, i.lov, i.config::jsonb, i.help
  from meta.page p join meta.app a on a.id = p.app_id
  join meta.region r on r.page_id = p.id and r.title = 'Component details', (values
  (10, 'P47_REF', 'Reference', 'popup_lov',
   'select ''REF-'' || lpad(n::text, 5, ''0'') || '' · '' || (array[''Accounting'', ''Research'', ''Sales'', ''Operations''])[1 + n % 4] as name, n as ref
  from generate_series(1, 6000) n
 order by n',
   '{"page_size": 100}', '6,000 reference numbers: scroll the dialog to load more.'),
  (20, 'P47_RESULT', 'Result', 'text', null, '{}', 'Filled by the Ajax call behind Check in the background, or Actions → Count employees.')
  ) as i (seq, name, label, type, lov, config, help)
 where a.alias = 'hr' and p.page_no = 47;

insert into meta.button (page_id, region_id, seq, name, label, action, hot, menu)
select p.id, r.id, b.seq, b.name, b.label, b.action, b.hot, b.menu::jsonb
  from meta.page p join meta.app a on a.id = p.app_id
  join meta.region r on r.page_id = p.id and r.title = 'Component details', (values
  (10, 'RECALC', 'Recalculate', 'submit', true, null),
  (20, 'CHECK', 'Check in the background', 'da', false, null),
  (30, 'ACTIONS', 'Actions', 'menu', false,
   '[{"label": "Count employees", "action": "COUNT", "icon": "users"},
     {"label": "Say hello", "action": "HELLO", "icon": "bell"},
     {"label": "Pick an employee", "page": 26, "icon": "search"}]')
  ) as b (seq, name, label, action, hot, menu)
 where a.alias = 'hr' and p.page_no = 47;

-- the long process: two seconds on RECALC
insert into meta.process (page_id, seq, name, type, point, code, when_button, success_message)
select p.id, 10, 'Recalculate (slow)', 'sql', 'submit', 'select pg_sleep(2)', 'RECALC', 'Recalculated.'
  from meta.page p join meta.app a on a.id = p.app_id
 where a.alias = 'hr' and p.page_no = 47;

insert into meta.dynamic_action (page_id, seq, name, event, trigger_element, action, affected_items, code, message)
select p.id, d.seq, d.name, d.event, d.trig, d.action, d.affected, d.code, d.message
  from meta.page p join meta.app a on a.id = p.app_id, (values
  (10, 'Wait while recalculating', 'click', 'RECALC', 'wait_popup', null, null, 'Recalculating…'),
  (20, 'Wait for the check', 'click', 'CHECK', 'wait_popup', null, null, 'Checking…'),
  (30, 'The check', 'click', 'CHECK', 'execute_sql', 'P47_RESULT',
   'select (select count(*) from hr.emp) || '' employees, checked at '' || to_char(clock_timestamp(), ''HH24:MI:SS'') as p47_result from pg_sleep(1.5)', null),
  (40, 'Check done', 'click', 'CHECK', 'remove_wait_popup', null, null, null),
  (50, 'Wait for the count', 'menu_entry', 'COUNT', 'wait_popup', null, null, 'Counting employees…'),
  (60, 'The count', 'menu_entry', 'COUNT', 'execute_sql', 'P47_RESULT',
   'select (select count(*) from hr.emp) || '' employees, counted at '' || to_char(clock_timestamp(), ''HH24:MI:SS'') as p47_result from pg_sleep(1.5)', null),
  (70, 'Count done', 'menu_entry', 'COUNT', 'remove_wait_popup', null, null, null),
  (80, 'Hello', 'menu_entry', 'HELLO', 'show_success', null, null, 'Hello from a menu entry.')
  ) as d (seq, name, event, trig, action, affected, code, message)
 where a.alias = 'hr' and p.page_no = 47;

insert into meta.nav_entry (app_id, seq, label, icon, target_page)
select id, 34, 'Component details', 'list', 47 from meta.app where alias = 'hr';

insert into meta.translation (app_id, language, source, target)
select a.id, 'nl', t.source, t.target
  from meta.app a, (values
  ('Component details', 'Componentdetails'),
  ('Reference', 'Referentie'),
  ('Result', 'Resultaat'),
  ('Recalculate', 'Herberekenen'),
  ('Check in the background', 'Op de achtergrond controleren'),
  ('Actions', 'Acties'),
  ('Count employees', 'Medewerkers tellen'),
  ('Say hello', 'Hallo zeggen'),
  ('Recalculating…', 'Herberekenen…'),
  ('Checking…', 'Controleren…'),
  ('Counting employees…', 'Medewerkers tellen…'),
  ('Recalculated.', 'Herberekend.'),
  ('Hello from a menu entry.', 'Hallo vanuit een menu-item.')
  ) as t(source, target)
 where a.alias = 'hr'
on conflict do nothing;
