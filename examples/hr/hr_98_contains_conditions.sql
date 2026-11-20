-- =====================================================================
-- HR example, part 98: conditions on one value of a multi-value item
-- (sprint 235, MG-9; migration 193; docs/guide/06-processing.md
-- "Server-side conditions", 07-dynamic-actions "Client-side conditions")
--
-- Page 50 "Project team" gets a checkbox group P50_NEEDS ("The team
-- also needs": desks, laptops, other). Its value is colon-separated
-- (DESK:OTHER), so equals or in_list would compare the whole value:
--   - client-side contains: ticking "Other" shows P50_NEEDS_OTHER
--     ("Describe what else") at once, and unticking hides it again;
--   - client-side not_contains: while Skills needed (a select many)
--     has no SQL, a tip says every HR project needs it;
--   - client-side contains_any: Testing or Accessibility among the
--     skills shows a note about the test lab;
--   - server-side item_contains: after Save, a "Laptop order" region
--     shows only when the needs include LAPTOP;
--   - server-side item_contains_any: a "Quality checklist" region
--     shows when the skills include TEST or A11Y.
-- =====================================================================

insert into meta.item (page_id, region_id, seq, name, label, type, lov, config, help)
select p.id, r.id, i.seq, i.name, i.label, i.type, i.lov, i.config::jsonb, i.help
  from meta.page p join meta.app a on a.id = p.app_id
  join meta.region r on r.page_id = p.id and r.title = 'Team', (values
  (40, 'P50_NEEDS', 'The team also needs', 'checkbox_group', 'STATIC:Desks;DESK,Laptops;LAPTOP,Other;OTHER', '{"wide": true}', null),
  (50, 'P50_NEEDS_OTHER', 'Describe what else', 'text', null, '{"wide": true}', 'Shown while "Other" is ticked.'),
  (60, 'P50_SQL_TIP', 'Tip', 'display', null, '{"wide": true}', null),
  (70, 'P50_LAB_NOTE', 'Test lab', 'display', null, '{"wide": true}', null)
  ) as i (seq, name, label, type, lov, config, help)
 where a.alias = 'hr' and p.page_no = 50
   and not exists (select 1 from meta.item x where x.page_id = p.id and x.name = i.name);

update meta.item i set default_value = d.v
  from meta.page p join meta.app a on a.id = p.app_id, (values
  ('P50_SQL_TIP', 'Every HR project works on the database: add SQL to the skills.'),
  ('P50_LAB_NOTE', 'Testing and accessibility work can book the test lab (room 2.14).')
  ) as d (name, v)
 where i.page_id = p.id and i.name = d.name and a.alias = 'hr' and p.page_no = 50;

-- client-side conditions on the first trigger item's values
insert into meta.dynamic_action (page_id, seq, name, event, trigger_element, condition_type, condition_value, action, affected_items)
select p.id, d.seq, d.name, 'change', d.trig, d.cond, d.val, 'show', d.items
  from meta.page p join meta.app a on a.id = p.app_id, (values
  (10, 'Other needs: describe them', 'P50_NEEDS', 'contains', 'OTHER', 'P50_NEEDS_OTHER'),
  (20, 'No SQL among the skills: the tip', 'P50_SKILLS', 'not_contains', 'SQL', 'P50_SQL_TIP'),
  (30, 'Testing or accessibility: the test lab', 'P50_SKILLS', 'contains_any', 'TEST, A11Y', 'P50_LAB_NOTE')
  ) as d (seq, name, trig, cond, val, items)
 where a.alias = 'hr' and p.page_no = 50
   and not exists (select 1 from meta.dynamic_action x where x.page_id = p.id and x.name = d.name);

-- server-side conditions: decided when the page is shown (after Save, from the session)
insert into meta.region (page_id, seq, title, type, columns, template, source, condition_type, condition, condition_value)
select p.id, r.seq, r.title, 'static', 8, 'standard', r.source, r.ctype, r.item, r.val
  from meta.page p join meta.app a on a.id = p.app_id, (values
  (50, 'Laptop order', '<p>Laptops are ordered through the IT service desk; allow two weeks.</p>', 'item_contains', 'P50_NEEDS', 'LAPTOP'),
  (60, 'Quality checklist', '<ul><li>Test plan agreed</li><li>Accessibility check (WCAG 2.2 AA) planned</li></ul>', 'item_contains_any', 'P50_SKILLS', 'TEST:A11Y')
  ) as r (seq, title, source, ctype, item, val)
 where a.alias = 'hr' and p.page_no = 50
   and not exists (select 1 from meta.region x where x.page_id = p.id and x.title = r.title);
