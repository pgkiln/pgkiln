-- =====================================================================
-- HR example, part 55: page groups (migration 089;
-- docs/guide/03-builder.md "Page groups")
--
-- The HR pages in four groups, shown and filtered in the App Builder's
-- page list (Shared Components → Page groups).
-- =====================================================================
insert into meta.page_group (app_id, name, description)
select a.id, g.name, g.description
  from meta.app a, (values
  ('Employees', 'Employees, departments and their reviews'),
  ('Leave', 'Leave requests, the calendar and the planner'),
  ('Administration', 'Pages for administrators'),
  ('Showcase', 'Pages that show one feature each')
  ) as g (name, description)
 where a.alias = 'hr';

update meta.page p set page_group = g.name
  from meta.app a, (values
  ('Employees', array[2, 3, 4, 5, 8, 11, 19, 20, 27]),
  ('Leave', array[6, 7, 12, 22, 24]),
  ('Administration', array[9, 10, 43, 44])
  ) as g (name, pages)
 where a.alias = 'hr' and p.app_id = a.id and p.page_no = any (g.pages);
