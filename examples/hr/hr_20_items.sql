-- =====================================================================
-- HR example, part 20: more item types (docs/guide/05-items.md)
--
-- Page 20 "Reviews": performance reviews with a date range (the review
-- period, stored as "from:to"), a star rating, skills as tags (a combobox:
-- free entry with suggestions, colon-separated), a summary in a rich text
-- editor (stored as sanitised HTML) and notes in Markdown. The open review
-- is shown as a QR code (computed by a load process), and an unbound
-- password item shows the show/hide button.
-- =====================================================================

create table hr.review (
  id         int generated always as identity primary key,
  empno      int not null references hr.emp on delete cascade,
  period     text not null check (period ~ '^\d{4}-\d{2}-\d{2}:\d{4}-\d{2}-\d{2}$'),
  rating     int  not null check (rating between 1 and 5),
  skills     text,
  summary    text,
  notes      text,
  created_by text not null default meta.app_user(),
  created_at timestamptz not null default now()
);
grant select, insert, update, delete on hr.review to hr_app;

insert into hr.review (empno, period, rating, skills, summary, notes, created_by) values
  (7698, '2026-01-01:2026-06-30', 4, 'Leadership:Sales:Planning',
   '<p>Blake led the sales team through a <strong>record half year</strong>.</p><ul><li>New regional accounts</li><li>Two new hires onboarded</li></ul>',
   E'## Goals\n\n- Mentor the new hires\n- Keep _customer visits_ up\n\nSee the [sales plan](https://example.com/plan).', 'king'),
  (7566, '2026-01-01:2026-06-30', 5, 'Leadership:SQL',
   '<p>Jones'' team shipped the reporting project <em>ahead of schedule</em>.</p>',
   E'**Strong year.** Consider for the architecture board.', 'king');

insert into meta.page (app_id, page_no, name, title, parent_page)
select id, 20, 'Reviews', 'Reviews', 1 from meta.app where alias = 'hr';

insert into meta.region (page_id, seq, title, type, columns, template, source, config)
select p.id, 10, 'Reviews', 'report', 12, 'standard',
$q$select r.id, e.ename as employee, replace(r.period, ':', ' – ') as period,
       repeat('★', r.rating) as rating, replace(coalesce(r.skills, ''), ':', ', ') as skills, r.created_by
  from hr.review r join hr.emp e using (empno)
 order by r.created_at desc$q$,
'{"page_size": 10, "link": {"column": "id", "page": 20, "items": {"P20_ID": "#id#"}}, "headings": {"id": "Review", "employee": "Employee", "period": "Period", "rating": "Rating", "skills": "Skills", "created_by": "By"}}'
  from meta.page p join meta.app a on a.id = p.app_id where a.alias = 'hr' and p.page_no = 20;

insert into meta.region (page_id, seq, title, type, columns, table_name, pk_column, pk_item, template)
select p.id, 20, 'Review', 'form', 8, 'hr.review', 'id', 'P20_ID', 'standard'
  from meta.page p join meta.app a on a.id = p.app_id where a.alias = 'hr' and p.page_no = 20;

insert into meta.region (page_id, seq, title, type, columns, template, source)
select p.id, 30, 'Share', 'static', 4, 'standard', '<p>Scan to read the review on a phone.</p>'
  from meta.page p join meta.app a on a.id = p.app_id where a.alias = 'hr' and p.page_no = 20;

insert into meta.item (page_id, region_id, seq, name, label, type, lov, source_column, required, help, config)
select p.id, r.id, i.seq, i.name, i.label, i.type, i.lov, i.col, i.req, i.help, i.config::jsonb
  from meta.page p join meta.app a on a.id = p.app_id join meta.region r on r.page_id = p.id and r.type = 'form', (values
  (10, 'P20_ID', null, 'hidden', null, 'id', false, null, '{}'),
  (20, 'P20_EMPNO', 'Employee', 'select', 'select initcap(ename), empno from hr.emp where active order by 1', 'empno', true, null, '{}'),
  (30, 'P20_PERIOD', 'Period', 'daterange', null, 'period', true, 'The first and last day the review covers.', '{}'),
  (40, 'P20_RATING', 'Rating', 'rating', null, 'rating', true, null, '{"max": 5}'),
  (50, 'P20_SKILLS', 'Skills', 'combobox',
   $l$select s, s from (select unnest(string_to_array(skills, ':')) as s from hr.review
                     union select unnest(array['Customer service', 'Leadership', 'Planning', 'PL/pgSQL', 'Sales', 'SQL'])) x order by 1$l$,
   'skills', false, 'Pick suggestions or type new skills.', '{}'),
  (60, 'P20_SUMMARY', 'Summary', 'richtext', null, 'summary', false, null, '{}'),
  (70, 'P20_NOTES', 'Notes', 'markdown', null, 'notes', false, null, '{"rows": 6}')
) i(seq, name, label, type, lov, col, req, help, config)
 where a.alias = 'hr' and p.page_no = 20;

insert into meta.item (page_id, region_id, seq, name, label, type, help, config)
select p.id, r.id, i.seq, i.name, i.label, i.type, i.help, i.config::jsonb
  from meta.page p join meta.app a on a.id = p.app_id join meta.region r on r.page_id = p.id and r.title = 'Share', (values
  (10, 'P20_SHARE', 'This review', 'qrcode', null, '{"ecc": "M", "size": 180}'),
  (20, 'P20_PIN', 'Sign-off code', 'password', 'Not saved: shows the password item''s show/hide button.', '{"reveal": true}')
) i(seq, name, label, type, help, config)
 where a.alias = 'hr' and p.page_no = 20;

insert into meta.button (page_id, region_id, seq, name, label, action, target_page, target_items, condition, hot, confirm)
select p.id, r.id, b.seq, b.name, b.label, b.action, b.target, b.items::jsonb, b.cond, b.hot, b.confirm
  from meta.page p join meta.app a on a.id = p.app_id join meta.region r on r.page_id = p.id and r.type = 'form', (values
  (10, 'NEW', 'New review', 'redirect', 20, '{"P20_ID": ""}', ':P20_ID is not null', false, null),
  (20, 'DELETE', 'Delete', 'submit', null, '{}', ':P20_ID is not null', false, 'Delete this review?'),
  (30, 'SAVE', 'Apply changes', 'submit', null, '{}', ':P20_ID is not null', true, null),
  (40, 'CREATE', 'Create', 'submit', null, '{}', ':P20_ID is null', true, null)
) b(seq, name, label, action, target, items, cond, hot, confirm)
 where a.alias = 'hr' and p.page_no = 20;

insert into meta.process (page_id, seq, name, type, region_id, point, code)
select p.id, x.seq, x.name, x.type, case when x.type = 'form_dml' then r.id end, x.point, x.code
  from meta.page p join meta.app a on a.id = p.app_id join meta.region r on r.page_id = p.id and r.type = 'form', (values
  (10, 'Process form Review', 'form_dml', 'submit', null),
  (20, 'Text for the QR code', 'sql', 'load',
   $c$select case when :P20_ID is not null then
         'HR review ' || :P20_ID || ': ' || (select initcap(ename) from hr.emp where empno = :P20_EMPNO::int)
         || ', ' || replace(:P20_PERIOD, ':', ' – ') || ', ' || :P20_RATING || '/5' end as p20_share$c$)
) x(seq, name, type, point, code)
 where a.alias = 'hr' and p.page_no = 20;

insert into meta.nav_entry (app_id, parent_id, seq, label, icon, target_page)
select a.id, n.id, 30, 'Reviews', 'check', 20
  from meta.app a join meta.nav_entry n on n.app_id = a.id and n.label = 'Employees' and n.parent_id is null
 where a.alias = 'hr';

insert into meta.translation (app_id, language, source, target)
select a.id, 'nl', t.source, t.target
  from meta.app a, (values
  ('Reviews', 'Beoordelingen'),
  ('Review', 'Beoordeling'),
  ('Period', 'Periode'),
  ('Rating', 'Waardering'),
  ('Skills', 'Vaardigheden'),
  ('Summary', 'Samenvatting'),
  ('Notes', 'Notities'),
  ('By', 'Door'),
  ('Share', 'Delen'),
  ('This review', 'Deze beoordeling'),
  ('Sign-off code', 'Aftekencode'),
  ('New review', 'Nieuwe beoordeling'),
  ('Apply changes', 'Wijzigingen opslaan'),
  ('Delete this review?', 'Deze beoordeling verwijderen?'),
  ('The first and last day the review covers.', 'De eerste en laatste dag van de beoordeelde periode.'),
  ('Pick suggestions or type new skills.', 'Kies een suggestie of typ nieuwe vaardigheden.'),
  ('Scan to read the review on a phone.', 'Scan om de beoordeling op een telefoon te lezen.'),
  ('Not saved: shows the password item''s show/hide button.', 'Wordt niet opgeslagen: toont de knop tonen/verbergen van een wachtwoorditem.')
  ) as t (source, target)
 where a.alias = 'hr'
on conflict do nothing;
