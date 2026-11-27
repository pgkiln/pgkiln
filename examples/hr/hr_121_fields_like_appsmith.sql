-- =====================================================================
-- HR example, part 121: date-time fields in the date format, a file item
-- as a button, a read-only item as a greyed field, a required item for one
-- button (sprint 261; docs/guide/05-items.md "Item types", "Properties"
-- and "Template options"; docs/guide/16-files.md).
--
-- Page 24 "Planner": Starts and Ends show the date in the application's
-- date format with the date picker and the time in a field of its own (no
-- setting: every datetime item); the organizer is a greyed field that says
-- who it will be before the meeting exists.
-- Page 3 "Employee": the photo is chosen with a button.
-- Page 37 "Leave assistant": the first day is required for "Request leave"
-- only, not for "Summarise" or "Fill in the request".
-- =====================================================================

update meta.item i set template_options = array_append(coalesce(i.template_options, '{}'), 'to-readonly-field'),
       placeholder = 'You, when you add it'
  from meta.page p join meta.app a on a.id = p.app_id
 where i.page_id = p.id and a.alias = 'hr' and p.page_no = 24 and i.name = 'P24_ORGANIZER';

update meta.item i set config = coalesce(i.config, '{}') || '{"button": true}'
  from meta.page p join meta.app a on a.id = p.app_id
 where i.page_id = p.id and a.alias = 'hr' and p.page_no = 3 and i.name = 'P3_PHOTO';

update meta.item i set required = true, config = coalesce(i.config, '{}') || '{"required_when": ["REQUEST"]}'
  from meta.page p join meta.app a on a.id = p.app_id
 where i.page_id = p.id and a.alias = 'hr' and p.page_no = 37 and i.name = 'P37_START_DATE';
