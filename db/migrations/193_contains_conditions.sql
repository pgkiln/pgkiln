-- Sprint 235 (MG-9): conditions on one value of a multi-value item. A checkbox group, multiselect, shuttle or
-- select many holds its values colon-separated (0:9, CLERK:ANALYST); equals and in_list compare that whole value.
--
-- Client-side conditions of dynamic actions (the first trigger item's value):
--   contains        the item's values include the condition value
--   not_contains    they don't
--   contains_any    they include one of the condition value's comma-separated values
-- Server-side condition types (meta.condition_ok; regions, items, buttons, processes, validations, computations,
-- branches, application computations, dynamic actions' server-side condition):
--   item_contains        expression: an item; value: one value (no colon)
--   item_contains_any    expression: an item; value: values separated by colons (A:B)
-- Neither runs SQL: the server splits the item's value on colons and compares.

alter table meta.dynamic_action drop constraint dynamic_action_condition_type_check;
alter table meta.dynamic_action add constraint dynamic_action_condition_type_check check (condition_type in (
  'equals', 'not_equals', 'in_list', 'is_null', 'is_not_null', 'greater', 'greater_equal', 'less', 'less_equal', 'not_in_list',
  'contains', 'not_contains', 'contains_any'));

-- the contains conditions need a value to look for
alter table meta.dynamic_action add constraint dynamic_action_contains_value_check check (
  condition_type is null or condition_type not in ('contains', 'not_contains', 'contains_any')
  or (coalesce(condition_value, '') ~ '[^,\s]' and length(condition_value) <= 4000));

-- condition_ok as in 147, with the two item_contains types
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
    when p_type in ('item_contains')
      then coalesce(p_expr, '') ~ '^[A-Z][A-Z0-9_]*$' and coalesce(trim(p_value), '') <> '' and length(p_value) <= 4000
           and strpos(p_value, ':') = 0
    when p_type in ('item_contains_any')
      then coalesce(p_expr, '') ~ '^[A-Z][A-Z0-9_]*$' and coalesce(p_value, '') ~ '[^:\s]' and length(p_value) <= 4000
    when p_type in ('request_in', 'request_not_in') then coalesce(p_value, '') ~ '^ *[A-Z][A-Z0-9_]* *(, *[A-Z][A-Z0-9_]* *)*$'
    when p_type in ('page_in', 'page_not_in') then coalesce(p_value, '') ~ '^ *[0-9]{1,9} *(, *[0-9]{1,9} *)*$'
    when p_type in ('language_in', 'language_not_in')
      then coalesce(p_value, '') ~ '^ *[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})? *(, *[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})? *)*$'
    when p_type in ('page_is_dialog', 'page_is_not_dialog', 'user_signed_in', 'user_public', 'always', 'never') then true
    else false
  end
$$;

comment on function meta.condition_ok(text, text, text) is 'Is a server-side condition well formed? The catalogue of condition types shared by every component (147, 193: item_contains, item_contains_any).';
