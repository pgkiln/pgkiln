-- =====================================================================
-- 085: page behaviour (sprint 52)
--
-- Dynamic actions (APEX: events and actions that were missing):
--   events  after_refresh (a region was refreshed or loaded; trigger: region
--           ids or static ids), selection_change (rows selected in a report
--           or grid; trigger: region ids or static ids), focus and blur (Get /
--           Lose Focus of items), key_release (items), before_submit (the page
--           is about to be submitted; a declined Confirm stops it), custom
--           (trigger: event names, raised with pgkiln.trigger(name, value))
--   actions confirm (a question; No stops the actions after it), close_dialog
--           (close the modal page and refresh its parent), cancel_dialog,
--           clear (empty the affected items), open_region / close_region,
--           download (runs a download process of the page by name), print,
--           current_position (latitude,longitude into the affected item),
--           share (the device's share sheet, or the link copied)
--   The actions of one event and trigger now run one after the other, in
--   sequence order (APEX: the true actions of a dynamic action).
--
-- Ajax callbacks (APEX: On Demand processes, apex.server.process): page and
-- application processes with point "ajax" run only when JavaScript calls
-- them by name: POST /a/<alias>/<page>/ajax/<name> (src/runtime/ajax.ts).
--
-- meta.app.error_function (APEX: Error Handling Function): a function of the
-- application, function(jsonb) returns jsonb, that may rewrite every error
-- message shown to users (src/runtime/context.ts publicError).
--
-- meta.app.session_warning_seconds (APEX: Session timeout warning): seconds
-- before the session ends that the page warns and offers to stay signed in
-- (0: no warning).
-- =====================================================================

alter table meta.dynamic_action drop constraint dynamic_action_event_check;
alter table meta.dynamic_action add constraint dynamic_action_event_check check (event in (
  'change', 'click', 'load', 'dialog_closed', 'after_refresh', 'selection_change', 'focus', 'blur', 'key_release', 'before_submit', 'custom'));

alter table meta.dynamic_action drop constraint dynamic_action_action_check;
alter table meta.dynamic_action add constraint dynamic_action_action_check check (action in (
  'show', 'hide', 'enable', 'disable', 'set_value', 'execute_sql', 'refresh_region', 'refresh_item', 'alert', 'submit',
  'set_focus', 'add_class', 'remove_class', 'show_success', 'show_error', 'clear_errors', 'ai_generate', 'execute_javascript', 'plugin',
  'push_subscribe', 'confirm', 'close_dialog', 'cancel_dialog', 'clear', 'open_region', 'close_region', 'download', 'print',
  'current_position', 'share'));

alter table meta.process drop constraint process_point_check;
alter table meta.process add constraint process_point_check check (point in ('submit', 'load', 'ajax'));
alter table meta.app_process drop constraint app_process_point_check;
alter table meta.app_process add constraint app_process_point_check check (point in ('after_login', 'before_page', 'ajax'));

alter table meta.app
  -- schema.function: called as the application's role with a jsonb error, returns jsonb (or null)
  add column error_function text check (error_function ~ '^[A-Za-z_][A-Za-z0-9_$]{0,62}\.[A-Za-z_][A-Za-z0-9_$]{0,62}$'),
  add column session_warning_seconds int not null default 120 check (session_warning_seconds between 0 and 3600);

-- an export made before 085 has no session warning: NULL becomes 120
create function meta.app_session_warning_default() returns trigger
language plpgsql set search_path = pg_catalog as $$
begin
  new.session_warning_seconds := coalesce(new.session_warning_seconds, 120);
  return new;
end $$;
create trigger app_session_warning before insert or update on meta.app
  for each row execute function meta.app_session_warning_default();

comment on column meta.app.error_function is 'schema.function(jsonb) returns jsonb that rewrites error messages (085)';
comment on column meta.app.session_warning_seconds is 'Warn this many seconds before the session ends; 0: no warning (085)';
