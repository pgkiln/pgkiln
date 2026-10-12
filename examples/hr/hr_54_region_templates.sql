-- =====================================================================
-- HR example, part 54: region templates (migration 088;
-- docs/guide/04-pages-and-regions.md "Region templates")
--
-- Page 44 "Region templates" (Administration):
--   - a hero region (an icon, the title, text and a button);
--   - a title bar with buttons; a buttons container;
--   - "Leave policy" opens an inline dialog and "Help" an inline drawer
--     (dynamic actions "Open region"; a link to #R<id> opens them too);
--   - a carousel (a display selector with style carousel) over three
--     regions, turning every 8 seconds;
--   - the steps of onboarding as a wizard progress list above a wizard
--     region.
-- =====================================================================

insert into meta.page (app_id, page_no, name, title, parent_page)
select id, 44, 'Region templates', 'Region templates', 1 from meta.app where alias = 'hr';

insert into meta.list (app_id, name, type, description)
select id, 'HR_ONBOARDING_STEPS', 'static', 'The steps of onboarding (a wizard progress list on page 44)' from meta.app where alias = 'hr';

insert into meta.list_entry (app_id, list_name, seq, label, target_page)
select a.id, 'HR_ONBOARDING_STEPS', e.seq, e.label, e.page
  from meta.app a, (values (10, 'Personal details', 44), (20, 'Contract', 3), (30, 'Equipment', 28), (40, 'Done', 1)) as e (seq, label, page)
 where a.alias = 'hr';

insert into meta.region (page_id, seq, title, type, columns, template, source, config)
select p.id, r.seq, r.title, r.type, 12, r.template, r.source, r.config::jsonb
  from meta.page p join meta.app a on a.id = p.app_id, (values
  (10, 'Welcome to HR', 'static', 'hero',
   '<p>Everything about the people in the company: employees, departments, leave and reviews.</p>', '{"icon": "users"}'),
  (20, 'Employees this month', 'static', 'title_bar', '<p class="muted">Hires and departures of the current month.</p>', '{}'),
  (30, 'Actions', 'static', 'buttons_container', null, '{}'),
  (40, 'Leave policy', 'static', 'inline_dialog',
   '<p>Everyone has 25 days of leave a year. Ask your manager at least two weeks ahead; approvals come by e-mail.</p>', '{}'),
  (50, 'Help', 'static', 'inline_drawer',
   '<p>This page shows the region templates: hero, title bar, buttons container, inline dialog and drawer, carousel and wizard.</p>', '{}'),
  (60, 'Highlights', 'display_selector', 'plain', null, '{"style": "carousel", "interval": 8, "show_all": false}'),
  (61, 'New colleagues', 'static', 'standard', '<p>Three people joined the Research department this month.</p>', '{"display_selector": true}'),
  (62, 'Anniversaries', 'static', 'standard', '<p>KING celebrates 45 years with the company.</p>', '{"display_selector": true}'),
  (63, 'Open positions', 'static', 'standard', '<p>Two analysts and a clerk: see the intranet.</p>', '{"display_selector": true}'),
  (70, 'Onboarding steps', 'list', 'plain', null, '{"list": "HR_ONBOARDING_STEPS", "template": "wizard_progress"}'),
  (80, 'Personal details', 'static', 'wizard', '<p>Step 1: check your name, address and bank account in My account.</p>', '{}')
  ) as r (seq, title, type, template, source, config)
 where a.alias = 'hr' and p.page_no = 44;

insert into meta.button (page_id, region_id, seq, name, label, action, hot, target_page)
select p.id, (select r.id from meta.region r where r.page_id = p.id and r.title = b.region), b.seq, b.name, b.label, b.action, b.hot, b.target
  from meta.page p join meta.app a on a.id = p.app_id, (values
  ('Welcome to HR', 10, 'EMPLOYEES', 'See the employees', 'redirect', true, 2),
  ('Employees this month', 20, 'POLICY', 'Leave policy', 'da', false, null),
  ('Actions', 30, 'HELP', 'Help', 'da', false, null)
  ) as b (region, seq, name, label, action, hot, target)
 where a.alias = 'hr' and p.page_no = 44;

insert into meta.dynamic_action (page_id, seq, name, event, trigger_element, action, affected_region_id)
select p.id, d.seq, d.name, 'click', d.button, 'open_region', (select r.id from meta.region r where r.page_id = p.id and r.title = d.region)
  from meta.page p join meta.app a on a.id = p.app_id, (values
  (10, 'Open the leave policy', 'POLICY', 'Leave policy'),
  (20, 'Open the help', 'HELP', 'Help')
  ) as d (seq, name, button, region)
 where a.alias = 'hr' and p.page_no = 44;

insert into meta.nav_entry (app_id, parent_id, seq, label, icon, target_page)
select a.id, n.id, 50, 'Region templates', 'layers', 44
  from meta.app a join meta.nav_entry n on n.app_id = a.id and n.label = 'Administration' and n.parent_id is null
 where a.alias = 'hr';
