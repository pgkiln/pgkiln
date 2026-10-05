-- =====================================================================
-- HR example, part 30: number format masks and time zones
-- (docs/guide/14-globalization.md, "Number formats" and "Time zones")
--
-- Page 29 "Formats and time zones":
--   * a report whose columns have format masks (currency, groups,
--     percent, leading zeros), shown with the language's separators
--     (?lang=nl shows 1.234,50);
--   * a metric card and a chart with masks;
--   * a number item with a mask (type 1.234,50 in Dutch) and a display
--     item the process fills;
--   * the time of the request in the user's time zone: the HR app has an
--     automatic time zone (the browser's, or the one chosen on My account).
-- =====================================================================

update meta.app set time_zone_auto = true, currency = 'EUR' where alias = 'hr';

insert into meta.page (app_id, page_no, name, title, parent_page)
select id, 29, 'Formats and time zones', 'Formats and time zones', 1 from meta.app where alias = 'hr';

insert into meta.region (page_id, seq, title, type, columns, template, source, config)
select p.id, r.seq, r.title, r.type, r.columns, 'standard', r.source, r.config::jsonb
  from meta.page p join meta.app a on a.id = p.app_id, (values
  (10, 'Payroll', 'cards', 4,
   'select ''Yearly payroll'' as title, 12 * sum(sal) as badge, ''chart'' as icon from hr.emp where active',
   '{"style": "metric", "formats": {"badge": "FML999G999G990"}}'),
  (20, 'Average salary by department', 'chart', 8,
   'select d.dname as department, round(avg(e.sal), 2) as "Average salary"
  from hr.dept d join hr.emp e using (deptno)
 group by d.dname order by 1',
   '{"kind": "bar", "format_mask": "FML999G990D00"}'),
  (30, 'Salaries', 'report', 12,
   'select empno, initcap(ename) as name, initcap(job) as job, sal as salary, 12 * sal as yearly,
       round(100.0 * coalesce(comm, 0) / nullif(sal, 0), 1) as commission, hiredate
  from hr.emp where active order by sal desc',
   '{"page_size": 5, "headings": {"empno": "Number", "yearly": "Per year", "commission": "Commission (% of salary)", "hiredate": "Hired"},
     "formats": {"empno": "00000", "salary": "FML999G990D00", "yearly": "999G999G990", "commission": "FM990D0%", "hiredate": "DD MON YYYY"}}'),
  (40, 'Convert an amount', 'static', 6,
   '<p>Type an amount in the notation of your language, e.g. <code>1,234.50</code> in English or <code>1.234,50</code> in Dutch. The item reads it back into a number; anything else is an error.</p>',
   '{}'),
  (50, 'Your time zone', 'report', 6,
   'select now() as now, current_setting(''TimeZone'') as time_zone,
       (select max(created_at) from hr.leave_request) as latest',
   '{"searchable": false, "sortable": false, "interactive": false, "saved_reports": false, "mobile": "reflow",
     "headings": {"now": "Time now", "time_zone": "Time zone", "latest": "Latest leave request"},
     "formats": {"now": "DD MON YYYY HH24:MI:SS"}}')
  ) as r (seq, title, type, columns, source, config)
 where a.alias = 'hr' and p.page_no = 29;

insert into meta.item (page_id, region_id, seq, name, label, type, config, help)
select p.id, r.id, i.seq, i.name, i.label, i.type, i.config::jsonb, i.help
  from meta.page p join meta.app a on a.id = p.app_id
  join meta.region r on r.page_id = p.id and r.title = 'Convert an amount', (values
  (10, 'P29_AMOUNT', 'Amount', 'number', '{"format_mask": "999G999G990D00"}', 'With two decimals and group separators.'),
  (20, 'P29_WITH_VAT', 'With 21% VAT', 'display', '{"format_mask": "FML999G999G990D00"}', null)
  ) as i (seq, name, label, type, config, help)
 where a.alias = 'hr' and p.page_no = 29;

insert into meta.button (page_id, region_id, seq, name, label, action, hot)
select p.id, r.id, 10, 'CONVERT', 'Add VAT', 'submit', true
  from meta.page p join meta.app a on a.id = p.app_id
  join meta.region r on r.page_id = p.id and r.title = 'Convert an amount'
 where a.alias = 'hr' and p.page_no = 29;

insert into meta.process (page_id, seq, name, type, point, code, when_button)
select p.id, 10, 'Add VAT', 'sql', 'submit', 'select round(:P29_AMOUNT::numeric * 1.21, 2) as p29_with_vat', 'CONVERT'
  from meta.page p join meta.app a on a.id = p.app_id
 where a.alias = 'hr' and p.page_no = 29;

insert into meta.nav_entry (app_id, seq, label, icon, target_page)
select id, 29, 'Formats and time zones', 'clock', 29 from meta.app where alias = 'hr';

insert into meta.translation (app_id, language, source, target)
select a.id, 'nl', t.source, t.target
  from meta.app a, (values
  ('Formats and time zones', 'Notaties en tijdzones'),
  ('Payroll', 'Loonsom'),
  ('Average salary by department', 'Gemiddeld salaris per afdeling'),
  ('Salaries', 'Salarissen'),
  ('Number', 'Nummer'),
  ('Commission (% of salary)', 'Commissie (% van het salaris)'),
  ('Hired', 'In dienst'),
  ('Per year', 'Per jaar'),
  ('Time now', 'Nu'),
  ('Time zone', 'Tijdzone'),
  ('Latest leave request', 'Laatste verlofaanvraag'),
  ('Convert an amount', 'Een bedrag omrekenen'),
  ('Amount', 'Bedrag'),
  ('With two decimals and group separators.', 'Met twee decimalen en scheidingstekens voor duizendtallen.'),
  ('With 21% VAT', 'Met 21% btw'),
  ('Add VAT', 'Btw erbij'),
  ('Your time zone', 'Uw tijdzone'),
  ('<p>Type an amount in the notation of your language, e.g. <code>1,234.50</code> in English or <code>1.234,50</code> in Dutch. The item reads it back into a number; anything else is an error.</p>',
   '<p>Typ een bedrag in de notatie van uw taal, bijvoorbeeld <code>1,234.50</code> in het Engels of <code>1.234,50</code> in het Nederlands. Het veld leest het terug als getal; iets anders geeft een foutmelding.</p>')
  ) as t(source, target)
 where a.alias = 'hr'
on conflict do nothing;
