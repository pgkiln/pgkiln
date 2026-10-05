-- =====================================================================
-- 066: template options on items (APEX: item template options)
--
-- Like regions and buttons (053): a list of CSS class names from a fixed
-- list (src/runtime/template-options.ts ITEM_OPTIONS); the database only
-- checks the shape and the renderer ignores unknown classes. An export made
-- before 066 has no template_options on its items: the 053 trigger function
-- turns the NULL that meta.import_app() inserts into the empty list.
-- (Report columns keep theirs in the region's config: column_options.)
-- =====================================================================

alter table meta.item add column template_options text[] not null default '{}' check (meta.class_names_ok(template_options));

create trigger item_template_options before insert or update on meta.item
  for each row execute function meta.template_options_default();

comment on column meta.item.template_options is 'Template options: CSS classes from a fixed list (src/runtime/template-options.ts); others are ignored';
