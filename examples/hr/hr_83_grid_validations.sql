-- =====================================================================
-- HR example, part 83: column validations in an interactive grid
-- (docs/guide/04-pages-and-regions.md, sprint 174)
--
-- The Staff grid of page 27 checks each row that is added or changed:
-- a salary must be more than zero, and a commission may not be more than
-- the salary. A row that fails is not saved; the message shows in its
-- cell and in the notification.
-- =====================================================================
update meta.region r
   set config = jsonb_set(jsonb_set(r.config,
         '{columns,sal}', coalesce(r.config #> '{columns,sal}', '{}') ||
           '{"validation": ":SAL::numeric > 0", "validation_message": "The salary must be more than zero."}'::jsonb),
         '{columns,comm}', coalesce(r.config #> '{columns,comm}', '{}') ||
           '{"validation": ":COMM is null or :COMM::numeric <= :SAL::numeric", "validation_message": "The commission cannot be more than the salary."}'::jsonb)
  from meta.page p join meta.app a on a.id = p.app_id
 where r.page_id = p.id and a.alias = 'hr' and p.page_no = 27 and r.type = 'grid' and r.title = 'Staff';
