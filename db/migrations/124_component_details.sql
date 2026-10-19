-- =====================================================================
-- 124: component details of APEX 26.1 (sprint 115, WS-11)
--
-- Dynamic actions:
--   * event "menu_entry" (APEX: Menu entry chosen): a menu button's entry
--     {"label": "…", "action": "NAME"} runs the dynamic actions of event
--     menu_entry whose trigger names the entry (NAME) or the menu button
--     (any of its entries; the entry's name is the value a client-side
--     condition tests).
--   * actions "wait_popup" and "remove_wait_popup" (APEX: Show / Remove
--     Wait Popup): a modal "please wait" overlay (Message is its text)
--     until remove_wait_popup or the next page; e.g. before_submit →
--     wait_popup around a long process, or wait_popup, execute_sql,
--     remove_wait_popup around an Ajax callback.
-- Menu entries: exactly one of "page", "request" or "action" (new).
-- No new tables or columns: the button's menu jsonb and the dynamic
-- action's event/action travel with export_app / import_app unchanged.
-- =====================================================================

alter table meta.dynamic_action drop constraint dynamic_action_event_check;
alter table meta.dynamic_action add constraint dynamic_action_event_check check (event in (
  'change', 'click', 'load', 'dialog_closed', 'after_refresh', 'selection_change', 'focus', 'blur', 'key_release', 'before_submit', 'custom',
  'menu_entry'));

alter table meta.dynamic_action drop constraint dynamic_action_action_check;
alter table meta.dynamic_action add constraint dynamic_action_action_check check (action in (
  'show', 'hide', 'enable', 'disable', 'set_value', 'execute_sql', 'refresh_region', 'refresh_item', 'alert', 'submit',
  'set_focus', 'add_class', 'remove_class', 'show_success', 'show_error', 'clear_errors', 'ai_generate', 'execute_javascript', 'plugin',
  'push_subscribe', 'confirm', 'close_dialog', 'cancel_dialog', 'clear', 'open_region', 'close_region', 'download', 'print',
  'current_position', 'share', 'wait_popup', 'remove_wait_popup'));

-- A menu entry: {"label": "…", "page": 3, "items": {"P3_ID": "&P2_ID."}} (a link),
-- {"label": "…", "request": "ARCHIVE"} (submits the page with that request) or
-- {"label": "…", "action": "EXPORT"} (runs the dynamic actions of event menu_entry);
-- optional "confirm", "authz" and "icon". At most 20 entries.
create or replace function meta.button_menu_ok(p_menu jsonb) returns boolean
language sql immutable set search_path = meta, pg_catalog as $$
  select jsonb_typeof(p_menu) = 'array' and jsonb_array_length(p_menu) <= 20
     and not exists (
       select 1 from jsonb_array_elements(p_menu) e
        where jsonb_typeof(e) <> 'object'
           or jsonb_typeof(e->'label') is distinct from 'string' or length(e->>'label') not between 1 and 100
           or (e ? 'page')::int + (e ? 'request')::int + (e ? 'action')::int <> 1
           or (e ? 'page' and (jsonb_typeof(e->'page') <> 'number' or (e->>'page')::numeric <= 0 or (e->>'page')::numeric <> floor((e->>'page')::numeric)))
           or (e ? 'request' and coalesce(e->>'request', '') !~ '^[A-Z][A-Z0-9_]*$')
           or (e ? 'action' and (jsonb_typeof(e->'action') <> 'string' or e->>'action' !~ '^[A-Z][A-Z0-9_]{0,59}$'))
           or (e ? 'items' and jsonb_typeof(e->'items') <> 'object')
           or (e ? 'confirm' and jsonb_typeof(e->'confirm') <> 'string')
           or (e ? 'icon' and coalesce(e->>'icon', '') !~ '^[a-z][a-z0-9-]{0,40}$')
           or (e ? 'authz' and coalesce(e->>'authz', '') !~ '^!?[A-Z][A-Z0-9_]*$'))
$$;
