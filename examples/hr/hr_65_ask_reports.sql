-- =====================================================================
-- HR example, part 65: "Ask in your own words" without an AI service
-- (docs/guide/04-pages-and-regions.md, "Ask in your own words")
--
-- Page 2 "Employees": the interactive report gets a question box with the
-- built-in phrases ("ai_filter": {} names no AI service). Try
--   sum of salary by department where job is clerk
--   salary over 2500, sort by hire date, newest first
--   only clerks hired after 1981
--   bonus is 10% of salary
--   highlight salary over 4000 in red
-- Each answer becomes the report's own settings (filters, sort, group by,
-- computed columns, …), shown as chips with Edit and Remove under the box;
-- Undo goes back a step. Page 38's staff list uses the HR_ASSISTANT AI
-- service when an administrator has added it, else the same phrases.
-- =====================================================================

update meta.region r
   set config = r.config || '{"ai_filter": {"placeholder": "e.g. sum of salary by department where job is clerk"}}'
  from meta.page p, meta.app a
 where r.page_id = p.id and p.app_id = a.id and a.alias = 'hr' and p.page_no = 2 and r.type = 'report';
