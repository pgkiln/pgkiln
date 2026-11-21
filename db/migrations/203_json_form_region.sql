-- Sprint 246 (MG-19): the JSON form region (json_form), a form drawn from a JSON schema.
--
-- Source: a SELECT returning one row, run as the application's role: the JSON schema (a column named "schema",
-- else the first) and the current answers (a column named "value", else the second). The schema's properties
-- become fields (text, textarea, number, integer, date, time, date and time, e-mail, URL, select list, radio group,
-- checkbox group, yes/no, repeating rows, groups) in the order of x-order. config {"item": "P3_ANSWERS"}: the page
-- item the answers post into as one JSON value, checked on the server against the schema (required, enum, types,
-- minimum/maximum, lengths, number of items) before any process runs; {"read_only": true} shows the answers only;
-- {"empty_rows": n} the empty rows a repeating field shows without JavaScript (2).
--
-- The region's columns are those of any region: nothing new is stored, so export and import carry it as they are.

alter table meta.region drop constraint region_type_check;
alter table meta.region add constraint region_type_check check (type in (
  'report', 'form', 'chart', 'cards', 'static', 'grid', 'calendar', 'dynamic', 'facets', 'tasks', 'workflows', 'map', 'tree',
  'template_component', 'smart_filters', 'display_selector', 'list', 'data_reporter', 'ai_assistant', 'plugin', 'url', 'search', 'login',
  'form_designer', 'classic_report', 'breadcrumb', 'help_text', 'workflow_diagram', 'json_form'));
