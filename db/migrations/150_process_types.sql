-- Sprint 157 (CD-4; APEX: page process types): declarative types for what APEX applications do in processes.
-- Each calls what pgkiln already has; its settings are in config (checked by the builder and again when it runs):
--
--   close_dialog         {"items": ["P5_ID"]}: closes the modal page after the submit, handing these items' values to
--                        the page below (items of the same name there are set before its Dialog Closed actions)
--   clear_session_state  {"items": [...], "pages": [3, 4], "all": false}: empties items, every P<n>_ item of the pages,
--                        or all page and application items (APEX: Clear Session State)
--   reset_pagination     the reports and grids of the page start on their first page after the submit
--   user_preferences     {"action": "set" | "reset", "preference": "NAME", "item": "P1_X"} (meta.set_preference)
--   server_geocoding     {"address_item": "P3_ADDRESS", "coordinates_item": "P3_LOCATION", "country": "nl"}: the
--                        installation's geocoder; the first place's "lat,lng" into the coordinates item
--   print_report         {"document": "NAME"}: a document template or report query, sent as the answer
--   human_task_create    {"definition": "LEAVE_APPROVAL", "detail_pk": "&P7_ID.", "parameters": {…}, "id_item": "P7_TASK_ID"}
--   human_task_manage    {"action": "approve" | "reject" | "complete" | "claim" | "release" | "delegate" | "cancel",
--                         "task": "&P8_TASK_ID.", "outcome": …, "to": …, "comment": …} (the task functions check who may)
--   form_init            APEX's Form – Initialization: the form region fetches its row by itself, so it does nothing;
--                        imported pages keep it visible

alter table meta.process drop constraint process_type_check;
alter table meta.process add constraint process_type_check check (type in (
  'ai_generate', 'chain', 'data_load', 'download', 'form_dml', 'grid_dml', 'invoke_api', 'sql', 'workflow', 'plugin', 'send_push', 'send_email',
  'close_dialog', 'clear_session_state', 'reset_pagination', 'user_preferences', 'server_geocoding', 'print_report',
  'human_task_create', 'human_task_manage', 'form_init'));
