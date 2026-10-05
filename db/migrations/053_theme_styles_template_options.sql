-- =====================================================================
-- 053: Theme Roller style variants and template options
--
-- Style variants (APEX: theme styles, "Enable End Users to Choose Theme
--   Style") are part of the application's definition and live in
--   meta.app.theme (jsonb), so they travel with export/import unchanged:
--     theme.styles       [{"name": "Ocean", "accent": "#0b7285", "header": "#0b3d49",
--                          "font": "serif", "font_size": "large", "radius": "small"}, …]
--     theme.style        the default style's name (absent: the base colours)
--     theme.style_choice true: users may pick one of the styles
--   Only values from fixed lists (hex colours, font/size/radius keys) become
--   CSS; the server checks them on save and again when it writes the CSS
--   (src/runtime/styles.ts). A user's choice is kept per application in
--   meta.account_style (installation data, never exported) and honoured only
--   while the style still exists.
--
-- Template options (APEX: template options) on regions and buttons: a list
--   of CSS class names from a fixed list per component type. The database
--   only checks the shape; the renderer keeps classes from its fixed list
--   and ignores the rest.
-- =====================================================================

create function meta.class_names_ok(p text[]) returns boolean
language sql immutable set search_path = pg_catalog as $$
  select cardinality(p) <= 12 and coalesce(bool_and(x ~ '^[a-z][a-z0-9-]{0,39}$'), true) from unnest(p) x
$$;

alter table meta.region add column template_options text[] not null default '{}' check (meta.class_names_ok(template_options));
alter table meta.button add column template_options text[] not null default '{}' check (meta.class_names_ok(template_options));

-- an export made before 053 has no template_options: meta.import_app() then
-- inserts NULL, which becomes the empty list (no need to redefine import_app)
create function meta.template_options_default() returns trigger
language plpgsql set search_path = pg_catalog as $$
begin
  new.template_options := coalesce(new.template_options, '{}');
  return new;
end $$;
create trigger region_template_options before insert or update on meta.region
  for each row execute function meta.template_options_default();
create trigger button_template_options before insert or update on meta.button
  for each row execute function meta.template_options_default();

comment on column meta.region.template_options is 'Template options: CSS classes from a fixed list (src/runtime/template-options.ts); others are ignored';
comment on column meta.button.template_options is 'Template options: CSS classes from a fixed list (src/runtime/template-options.ts); others are ignored';

-- a user's style variant per application
create table meta.account_style (
  account_id int  not null references meta.account on delete cascade,
  app_id     int  not null references meta.app on delete cascade,
  -- '' = the base colours ("Standard")
  style      text not null check (style = '' or style ~ '^[A-Za-z0-9][A-Za-z0-9 _-]{0,29}$'),
  primary key (account_id, app_id)
);
grant select, insert, update, delete on meta.account_style to pgapex_runtime;
