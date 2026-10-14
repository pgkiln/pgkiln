-- =====================================================================
-- HR example, part 59: dragging tasks on a Gantt chart
-- (docs/guide/04-pages-and-regions.md, chart regions)
--
-- The office move on page 32 "Project plan" (part 35) becomes editable for
-- managers: drag a task to new dates or drag its end; the arrow keys do the
-- same. The update runs as the application's role; a milestone (no end
-- date) keeps having none.
-- =====================================================================

grant update (starts, ends) on hr.project_task to hr_app;

update meta.region r
   set config = r.config || jsonb_build_object(
         'gantt_move', $q$update hr.project_task
   set starts = :NEW_START::date,
       ends = case when ends is null then null else :NEW_END::date end
 where id = :TASK_ID::int$q$,
         'gantt_move_authz', 'MANAGER')
  from meta.page p join meta.app a on a.id = p.app_id
 where p.id = r.page_id and a.alias = 'hr' and p.page_no = 32 and r.title = 'Office move';
