-- Sprint 140 (AP-4): item and region types that were still missing from the Page Designer's gallery.
--
-- Items:   shuttle      two lists (available, chosen) with move and order buttons; a <select multiple> without JavaScript
--          select_one   a searchable single pick from a list of values; a <select> without JavaScript
--          select_many  a searchable multi pick with chips; a <select multiple> without JavaScript
--          (shuttle and select_many store their values colon-separated, like multiselect)
-- Regions: classic_report  a report without the Actions menu and the interactive features (report templates, pagination types)
--          breadcrumb      the page's breadcrumb trail (for the Breadcrumb bar position)
--          help_text       the page's help text (meta.page.help, new here)

alter table meta.item drop constraint item_type_check;
alter table meta.item add constraint item_type_check check (type in (
  'text', 'textarea', 'number', 'date', 'datetime', 'select', 'radio', 'checkbox', 'switch', 'hidden', 'display', 'password',
  'checkbox_group', 'multiselect', 'popup_lov', 'email', 'tel', 'url', 'color', 'file', 'location', 'richtext', 'markdown',
  'rating', 'combobox', 'daterange', 'qrcode', 'plugin', 'image', 'address',
  'shuttle', 'select_one', 'select_many'));

alter table meta.region drop constraint region_type_check;
alter table meta.region add constraint region_type_check
  check (type in ('report', 'form', 'chart', 'cards', 'static', 'grid', 'calendar', 'dynamic', 'facets', 'tasks', 'workflows', 'map', 'tree',
                  'template_component', 'smart_filters', 'display_selector', 'list', 'data_reporter', 'ai_assistant', 'plugin', 'url', 'search',
                  'login', 'form_designer', 'classic_report', 'breadcrumb', 'help_text'));

-- (APEX: Page → Help → Help Text) Markdown with &ITEM. substitutions, shown by a help_text region of the page.
-- Nullable, so exports of older versions import as they are (export_app and import_app copy every page column).
alter table meta.page add column help text check (help is null or length(help) <= 20000);
comment on column meta.page.help is 'The page''s help text (Markdown, &ITEM. substitutions), shown by a region of type help_text.';
