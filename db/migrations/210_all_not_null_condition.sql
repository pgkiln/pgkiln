-- Sprint 264: a dynamic action's client-side condition on several items. Found comparing migrated Appsmith applications:
-- a button stays grey until the fields it needs are filled in (Appsmith: isDisabled {{!Input.text || !Select.value}}).
--
--   all_not_null    every trigger item has a value (the condition value is not used)
--
-- With an enable / disable / show / hide action, affected_items may also name buttons of the page (by their name).

alter table meta.dynamic_action drop constraint dynamic_action_condition_type_check;
alter table meta.dynamic_action add constraint dynamic_action_condition_type_check check (condition_type in (
  'equals', 'not_equals', 'in_list', 'is_null', 'is_not_null', 'greater', 'greater_equal', 'less', 'less_equal', 'not_in_list',
  'contains', 'not_contains', 'contains_any', 'all_not_null'));
