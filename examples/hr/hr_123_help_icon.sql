-- =====================================================================
-- HR example, part 123: help text as a tooltip of a ? after the label
-- (sprint 263; docs/guide/05-items.md "Attributes").
--
-- Page 3 "Employee": Salary's help (a trigger keeps salaries below the
-- president's) shows while the pointer is on its label or the field has
-- focus, instead of under the field.
-- =====================================================================

update meta.item i set config = coalesce(i.config, '{}') || '{"help_icon": true}'
  from meta.page p join meta.app a on a.id = p.app_id
 where i.page_id = p.id and a.alias = 'hr' and p.page_no = 3 and i.name = 'P3_SAL';
