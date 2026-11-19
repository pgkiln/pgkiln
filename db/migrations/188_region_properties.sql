-- =====================================================================
-- 188: a region's other property groups (sprint 230, AX-9, AX-10, AX-11; APEX's region in the Page Designer)
--
-- Layout (AX-9)
--   new_row             Start New Row: the region begins a new row of the 12-column grid (null: it flows, as before)
--   grid_column         Column 1-12: the column the region starts in (null: Automatic)
--   row_css_classes     Row CSS Classes: on the row this region starts (with new_row)
--   column_css_classes  Column CSS Classes and
--   column_attributes   Column Attributes: on the region's grid cell (the region's element in pgkiln's grid)
-- Appearance (AX-10)
--   css_classes         CSS Classes, free (APEX's u-*, t-* or your own)
--   icon                an icon (Lucide or Font APEX name) on the templates that show one
--   render_components   Render Components: the region's items above or below its content (null: below)
-- Accessibility, Advanced, Header and Footer, Read Only, Customization, Comments (AX-11)
--   use_landmark        Use Landmark (null: yes)
--   landmark_type       Landmark Type (null: the template's: a titled region)
--   landmark_label      Landmark Label (null: the title)
--   dom_id              HTML DOM ID: the id of the region's content (its element stays R<id>, which pgkiln's scripts use)
--   custom_attributes   Custom Attributes (data-*, aria-*, role, title, lang, dir, tabindex, translate; never on* or style)
--   title_no_translate  Exclude Title from Translation
--   header_text         Header Text and
--   footer_text         Footer Text: HTML above and below the content, &ITEM. escaped (as static content)
--   readonly_type,      Read Only: a server-side condition (meta.condition_ok); when it holds, the region's items
--   readonly_expr,      and its sub regions' items are read-only, and a grid has no Save
--   readonly_value
--   customization       Customization: 'shown' or 'hidden' (by default): users may hide or show the region on
--                       the page's Customize link (meta.user_preference); null: not customizable
--   customization_name  Customized Option Name (null: the title)
--   comments            Comments: developer notes
-- Every column may be null, so an export made before 188 imports unchanged (meta.import_app's
-- jsonb_populate_record leaves a missing key null).
--
-- meta.region_audit: Audit Information (created and last updated, on and by). Builder state of this installation,
-- like meta.page_change: not exported; an import --replace keeps a region's creation (src/cli/replace.ts).
-- =====================================================================

alter table meta.region
  add column new_row            boolean,
  add column grid_column        int  check (grid_column between 1 and 12),
  add column row_css_classes    text check (row_css_classes ~ '^\s*-?[A-Za-z_][A-Za-z0-9_-]*(\s+-?[A-Za-z_][A-Za-z0-9_-]*)*\s*$' and length(row_css_classes) <= 500),
  add column column_css_classes text check (column_css_classes ~ '^\s*-?[A-Za-z_][A-Za-z0-9_-]*(\s+-?[A-Za-z_][A-Za-z0-9_-]*)*\s*$' and length(column_css_classes) <= 500),
  add column column_attributes  text check (length(column_attributes) <= 2000),
  add column css_classes        text check (css_classes ~ '^\s*-?[A-Za-z_][A-Za-z0-9_-]*(\s+-?[A-Za-z_][A-Za-z0-9_-]*)*\s*$' and length(css_classes) <= 500),
  add column icon               text check (icon ~ '^[A-Za-z0-9][A-Za-z0-9 _-]{0,99}$'),
  add column render_components  text check (render_components in ('above', 'below')),
  add column use_landmark       boolean,
  add column landmark_type      text check (landmark_type in ('region', 'banner', 'complementary', 'contentinfo', 'main', 'navigation', 'search')),
  add column landmark_label     text check (length(landmark_label) <= 200),
  add column dom_id             text check (dom_id ~ '^[A-Za-z][A-Za-z0-9_-]{0,99}$'),
  add column custom_attributes  text check (length(custom_attributes) <= 2000),
  add column title_no_translate boolean,
  add column header_text        text check (length(header_text) <= 20000),
  add column footer_text        text check (length(footer_text) <= 20000),
  add column readonly_type      text,
  add column readonly_expr      text,
  add column readonly_value     text,
  add column customization      text check (customization in ('shown', 'hidden')),
  add column customization_name text check (length(customization_name) <= 200),
  add column comments           text check (length(comments) <= 20000);

alter table meta.region add constraint region_readonly_ok check (meta.condition_ok(readonly_type, readonly_expr, readonly_value));

comment on column meta.region.new_row is 'Start New Row (188): the region begins a new row of the grid; null or false: it flows after the one before';
comment on column meta.region.grid_column is 'Column (188): the grid column (1-12) the region starts in; null: Automatic';
comment on column meta.region.row_css_classes is 'Row CSS Classes (188): on the row a region with new_row starts';
comment on column meta.region.column_css_classes is 'Column CSS Classes (188): on the region''s grid cell (its element)';
comment on column meta.region.column_attributes is 'Column Attributes (188): attributes of the region''s grid cell, checked as custom_attributes';
comment on column meta.region.css_classes is 'CSS Classes (188, Appearance)';
comment on column meta.region.icon is 'Icon (188, Appearance): shown by the templates that show one (standard, collapsible, hero, title bar, inline dialog and drawer)';
comment on column meta.region.render_components is 'Render Components (188): the region''s items above or below its content; null: below';
comment on column meta.region.use_landmark is 'Use Landmark (188): false leaves the region out of the page''s landmarks; null: yes';
comment on column meta.region.landmark_type is 'Landmark Type (188): the ARIA role of the region; null: the template''s (a titled region)';
comment on column meta.region.landmark_label is 'Landmark Label (188): the region''s accessible name (&ITEM. substitutions); null: its title';
comment on column meta.region.dom_id is 'HTML DOM ID (188): the id of the region''s content (the region element''s own id stays R<id>)';
comment on column meta.region.custom_attributes is 'Custom Attributes (188): name="value" pairs on the region''s element; only data-*, aria-*, role, title, lang, dir, tabindex and translate are used';
comment on column meta.region.title_no_translate is 'Exclude Title from Translation (188)';
comment on column meta.region.header_text is 'Header Text (188): HTML above the region''s content, &ITEM. substitutions escaped';
comment on column meta.region.footer_text is 'Footer Text (188): HTML below the region''s content, &ITEM. substitutions escaped';
comment on column meta.region.readonly_type is 'Read Only (188): a server-side condition type; when the condition holds the region''s items are read-only';
comment on column meta.region.customization is 'Customization (188): shown / hidden by default and listed on the page''s Customize link; null: not customizable';
comment on column meta.region.customization_name is 'Customized Option Name (188): the region''s name on the Customize link; null: its title';
comment on column meta.region.comments is 'Comments (188): developer notes';

-- ---------------------------------------------------------------- Audit Information
create table meta.region_audit (
  region_id  int primary key references meta.region on delete cascade,
  created_on timestamptz not null default now(),
  created_by text check (length(created_by) between 1 and 200),
  updated_on timestamptz not null default now(),
  updated_by text check (length(updated_by) between 1 and 200)
);
comment on table meta.region_audit is 'builder: when and by whom a region was created and last changed (Audit Information; 188)';
revoke all on meta.region_audit from public;

-- the developer, when the builder set one for the transaction (pgkiln.developer); else null, and the builder's
-- request fills it in afterwards (src/builder/region-props.ts stampRegionAudit)
create function meta.region_audit_note() returns trigger
language plpgsql security definer set search_path = meta, pg_catalog as $$
declare
  v_by text := nullif(left(current_setting('pgkiln.developer', true), 200), '');
begin
  insert into meta.region_audit (region_id, created_by, updated_by) values (new.id, v_by, v_by)
  on conflict (region_id) do update set updated_on = now(), updated_by = excluded.updated_by;
  return null;
end
$$;
revoke all on function meta.region_audit_note() from public;

create trigger region_audit after insert or update on meta.region
  for each row execute function meta.region_audit_note();
