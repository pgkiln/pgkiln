-- Sprint 154 (CD-2; APEX: Server-side Condition): one catalogue of server-side condition types for every
-- component. Processes, computations, branches and application computations had eight types (migration 029);
-- regions, buttons, items, validations and dynamic actions only a SQL expression or nothing. Now all of them
-- choose from the same list (meta.condition_ok checks each type's expression and value):
--
--   sql, exists, not_exists, function_body     expression: a boolean expression / a query / a PL/pgSQL body
--   item_null, item_not_null, item_zero, item_not_zero, item_null_or_zero, item_not_null_or_zero
--                                              expression: an item name
--   item_equals, item_not_equals               expression: an item; value: the value
--   item_equals_item, item_not_equals_item     expression: an item; value: the other item's name
--   item_in_list, item_not_in_list             expression: an item; value: a colon-separated list (A:B:C)
--   request_in, request_not_in                 value: button names, comma separated
--   page_in, page_not_in                       value: page numbers, comma separated
--   page_is_dialog, page_is_not_dialog, user_signed_in, user_public, always, never
--   language_in, language_not_in               value: language codes, comma separated (de, pt-br)
--
-- The simple types are decided by the server without a query; only sql, exists, not_exists and function_body run
-- SQL, as the application's role.
--
-- Regions and buttons keep their `condition` column as the expression: without a condition type it is SQL, as
-- before, so existing applications and exports keep working. Items and validations get condition_type /
-- condition_expr / condition_value like processes; dynamic actions get server_condition_type / _expr / _value
-- (their condition_type is the client-side condition).

create or replace function meta.condition_ok(p_type text, p_expr text, p_value text) returns boolean
language sql immutable set search_path = meta, pg_catalog as $$
  select case
    when p_type is null then true
    when p_type in ('sql', 'exists', 'not_exists', 'function_body') then coalesce(trim(p_expr), '') <> ''
    when p_type in ('item_null', 'item_not_null', 'item_zero', 'item_not_zero', 'item_null_or_zero', 'item_not_null_or_zero',
                    'item_equals', 'item_not_equals') then coalesce(p_expr, '') ~ '^[A-Z][A-Z0-9_]*$'
    when p_type in ('item_equals_item', 'item_not_equals_item')
      then coalesce(p_expr, '') ~ '^[A-Z][A-Z0-9_]*$' and coalesce(p_value, '') ~ '^ *[A-Z][A-Z0-9_]* *$'
    when p_type in ('item_in_list', 'item_not_in_list')
      then coalesce(p_expr, '') ~ '^[A-Z][A-Z0-9_]*$' and coalesce(p_value, '') <> '' and length(p_value) <= 4000
    when p_type in ('request_in', 'request_not_in') then coalesce(p_value, '') ~ '^ *[A-Z][A-Z0-9_]* *(, *[A-Z][A-Z0-9_]* *)*$'
    when p_type in ('page_in', 'page_not_in') then coalesce(p_value, '') ~ '^ *[0-9]{1,9} *(, *[0-9]{1,9} *)*$'
    when p_type in ('language_in', 'language_not_in')
      then coalesce(p_value, '') ~ '^ *[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})? *(, *[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})? *)*$'
    when p_type in ('page_is_dialog', 'page_is_not_dialog', 'user_signed_in', 'user_public', 'always', 'never') then true
    else false
  end
$$;

-- the eight-value lists of 029, 039 and 102 give way to condition_ok, which knows every type
alter table meta.computation drop constraint computation_condition_type_check;
alter table meta.branch drop constraint branch_condition_type_check;
alter table meta.process drop constraint process_condition_type_check;
alter table meta.app_computation drop constraint app_computation_condition_type_check;

-- regions and buttons: `condition` is the expression (SQL when no type is set)
alter table meta.region
  add column condition_type  text,
  add column condition_value text,
  add constraint region_condition_ok check (meta.condition_ok(coalesce(condition_type, case when coalesce(trim(condition), '') <> '' then 'sql' end), condition, condition_value));
alter table meta.button
  add column condition_type  text,
  add column condition_value text,
  add constraint button_condition_ok check (meta.condition_ok(coalesce(condition_type, case when coalesce(trim(condition), '') <> '' then 'sql' end), condition, condition_value));

-- items (not rendered, not accepted on submit when false) and validations (skipped when false)
alter table meta.item
  add column condition_type  text,
  add column condition_expr  text,
  add column condition_value text,
  add constraint item_condition_ok check (meta.condition_ok(condition_type, condition_expr, condition_value));
alter table meta.validation
  add column condition_type  text,
  add column condition_expr  text,
  add column condition_value text,
  add constraint validation_condition_ok check (meta.condition_ok(condition_type, condition_expr, condition_value));

-- dynamic actions: a server-side condition decides whether the action is on the page at all
alter table meta.dynamic_action
  add column server_condition_type  text,
  add column server_condition_expr  text,
  add column server_condition_value text,
  add constraint dynamic_action_server_condition_ok check (meta.condition_ok(server_condition_type, server_condition_expr, server_condition_value));

comment on function meta.condition_ok(text, text, text) is 'Is a server-side condition well formed? The catalogue of condition types shared by every component (147).';
