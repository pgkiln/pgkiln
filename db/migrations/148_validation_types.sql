-- Sprint 155 (CD-1; APEX: Validation types): declarative validation types, an authorization scheme, Always execute and
-- an error display location. Validations had three types (not_null, sql, regex); now APEX's list:
--
--   sql                 expression: a boolean SQL expression that must be true (APEX: Expression)
--   exists / not_exists expression: a query that must return a row / no row (Rows returned / No rows returned)
--   function_body       expression: a PL/pgSQL body returning boolean (Function Body returning Boolean)
--   function_error      expression: a PL/pgSQL body returning the error text, or null when valid (… returning Error Text)
--   not_null, not_null_or_zero, not_zero, no_spaces, alphanumeric, numeric, valid_date, valid_timestamp
--                       the associated item (Item is NOT NULL / NOT NULL or zero / NOT zero / contains no spaces /
--                       is alphanumeric / is numeric / is a valid date / is a valid timestamp)
--   equals, not_equals  the item's value is / isn't the expression (Item = Value / Item != Value)
--   in_list, not_in_list the item's value is / isn't one of the expression's values, colon separated (Item is (NOT) contained in Value)
--   chars_only, chars_any, chars_none
--                       the item's value contains only / at least one of / none of the expression's characters
--   regex               the item's value matches the expression (POSIX, checked in PostgreSQL)
--
-- Format checks pass an empty item (add not_null for a required one), as in APEX. display_location: where the error
-- shows: inline with the item and in the page's notification (inline_and_notification), inline only (null, as
-- before: the notification says "correct the errors below"), or in the notification only.

alter table meta.validation drop constraint validation_type_check;
alter table meta.validation
  add constraint validation_type_check check (type in (
    'sql', 'exists', 'not_exists', 'function_body', 'function_error',
    'not_null', 'not_null_or_zero', 'not_zero', 'no_spaces', 'alphanumeric', 'numeric', 'valid_date', 'valid_timestamp',
    'equals', 'not_equals', 'in_list', 'not_in_list', 'chars_only', 'chars_any', 'chars_none', 'regex')),
  -- the types that test an item need one; the others need their expression (a value may be empty for equals)
  add constraint validation_type_fields check (
    (type in ('sql', 'exists', 'not_exists', 'function_body', 'function_error') and coalesce(trim(expression), '') <> '')
    or (type in ('not_null', 'not_null_or_zero', 'not_zero', 'no_spaces', 'alphanumeric', 'numeric', 'valid_date', 'valid_timestamp', 'equals', 'not_equals')
        and coalesce(item_name, '') ~ '^[A-Z][A-Z0-9_]*$')
    or (type in ('in_list', 'not_in_list', 'chars_only', 'chars_any', 'chars_none', 'regex')
        and coalesce(item_name, '') ~ '^[A-Z][A-Z0-9_]*$' and coalesce(expression, '') <> '')
    -- (before 148 an sql validation could be saved without an expression: it passed; keep those rows valid)
    or (type = 'sql' and expression is null)
    or (type = 'regex' and item_name is null)
    or (type = 'not_null' and item_name is null)
  ),
  add column authz text,
  add column always_execute boolean not null default false,
  add column display_location text check (display_location in ('inline_and_notification', 'inline', 'notification'));

comment on column meta.validation.always_execute is 'Runs for a DELETE request too (148), like APEX''s Always Execute: other validations without When button pressed are skipped for DELETE.';
comment on column meta.validation.display_location is 'Where the error shows (148): inline_and_notification, inline (null: inline, with a "correct the errors below" notice) or notification.';
