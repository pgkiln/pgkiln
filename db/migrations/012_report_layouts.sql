-- ---------------------------------------------------------------------
-- Report layouts (Shared Components → Report layouts)
--
-- How a report prints as PDF (Actions → Download PDF): paper size and
-- orientation, font size, margins, title/header/footer texts with &NAME.
-- substitutions, colors and a logo. A report picks a layout by name in its
-- region settings:
--   {"pdf": {"layout": "LETTERHEAD", "columns": ["ename", "job"], "widths": {"ename": 140}}}
-- Reports without one use the application's default layout, or the
-- built-in look when there is none.
-- ---------------------------------------------------------------------
create table meta.report_layout (
  id            serial primary key,
  app_id        int  not null references meta.app on delete cascade,
  name          text not null check (name ~ '^[A-Z][A-Z0-9_]{0,62}$'),
  is_default    boolean not null default false,
  paper         text not null default 'A4' check (paper in ('A3', 'A4', 'A5', 'LETTER', 'LEGAL')),
  orientation   text not null default 'auto' check (orientation in ('auto', 'portrait', 'landscape')),
  font_size     numeric(4,1) not null default 8.5 check (font_size between 5 and 16),
  margin_mm     int  not null default 13 check (margin_mm between 5 and 40),
  -- texts; &REPORT_TITLE., &APP_NAME., &APP_USER., &DATE., &TIMESTAMP., items (&P1_X.) and &APP_TEXT$NAME.
  title         text,          -- null = &REPORT_TITLE.
  header        text,          -- under the title; null = application, time and user
  footer        text,          -- bottom left of every page; null = the title. Page numbers are bottom right.
  show_filters  boolean not null default true,
  full_width    boolean not null default false,  -- stretch the table to the page width
  heading_color text not null default '#e8ecf2' check (heading_color ~ '^#[0-9a-fA-F]{6}$'),
  stripe_color  text          check (stripe_color ~ '^#[0-9a-fA-F]{6}$'),   -- null = no stripes
  text_color    text not null default '#111111' check (text_color ~ '^#[0-9a-fA-F]{6}$'),
  logo          bytea         check (octet_length(logo) <= 2 * 1024 * 1024),
  logo_mime     text          check (logo_mime in ('image/png', 'image/jpeg')),
  logo_width_mm int  not null default 30 check (logo_width_mm between 5 and 100),
  unique (app_id, name)
);
-- at most one default per application: making a layout the default
-- takes it from the previous one
create unique index report_layout_default on meta.report_layout (app_id) where is_default;
create function meta.report_layout_one_default() returns trigger
language plpgsql as $$
begin
  update meta.report_layout set is_default = false where app_id = new.app_id and is_default and id <> new.id;
  return new;
end
$$;
create trigger report_layout_one_default before insert or update of is_default on meta.report_layout
  for each row when (new.is_default) execute function meta.report_layout_one_default();

revoke all on meta.report_layout from public;
grant select on meta.report_layout to pgkiln_runtime;

-- Export and import include report layouts (the logo as base64).
alter function meta.export_app(text) rename to export_app_base;
alter function meta.import_app(jsonb, text) rename to import_app_base;

create function meta.export_app(p_alias text) returns jsonb
language sql stable as $$
  select meta.export_app_base(p_alias) || jsonb_build_object(
    'report_layouts', coalesce((
      select jsonb_agg(to_jsonb(x) - 'id' - 'app_id' - 'logo'
                       || jsonb_build_object('logo', encode(x.logo, 'base64')) order by x.name)
        from meta.report_layout x join meta.app a on a.id = x.app_id
       where a.alias = p_alias), '[]'))
$$;

create function meta.import_app(p_doc jsonb, p_alias text default null) returns int
language plpgsql as $$
declare
  v_app_id int := meta.import_app_base(p_doc, p_alias);
begin
  insert into meta.report_layout
  select (jsonb_populate_record(null::meta.report_layout, (e - 'logo') || jsonb_build_object(
            'id', nextval('meta.report_layout_id_seq'), 'app_id', v_app_id))).*
    from jsonb_array_elements(coalesce(p_doc->'report_layouts', '[]')) e;
  update meta.report_layout l
     set logo = decode(e->>'logo', 'base64')
    from jsonb_array_elements(coalesce(p_doc->'report_layouts', '[]')) e
   where l.app_id = v_app_id and l.name = e->>'name' and e->>'logo' is not null;
  return v_app_id;
end
$$;
