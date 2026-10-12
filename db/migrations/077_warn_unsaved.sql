-- =====================================================================
-- 077: warn on unsaved changes (APEX: the page attribute "Warn on Unsaved
-- Changes" and the item attribute "Warn on Unsaved Changes: Ignore")
--
-- With meta.page.warn_unsaved the browser asks before the user leaves the
-- page (a link, a redirect button, closing or reloading the tab) while an
-- item of the page form has a changed value. Submitting the page doesn't
-- ask. An item is left out with {"warn_unsaved": false} in its attributes.
-- Off for existing pages; the create page wizards switch it on for forms.
-- =====================================================================

alter table meta.page add column warn_unsaved boolean not null default false;

-- an export made before 077 has no warn_unsaved: NULL becomes false
create function meta.page_warn_unsaved_default() returns trigger
language plpgsql set search_path = pg_catalog as $$
begin
  new.warn_unsaved := coalesce(new.warn_unsaved, false);
  return new;
end $$;
create trigger page_warn_unsaved before insert or update on meta.page
  for each row execute function meta.page_warn_unsaved_default();

comment on column meta.page.warn_unsaved is 'Ask before leaving the page while items have unsaved changes (077)';

-- The create page wizards switch it on for the form pages they make (APEX's default
-- for new pages): meta.wizard_form (047) is wrapped.
alter function meta.wizard_form(meta.app, regclass, int, text, int, boolean, text[]) rename to wizard_form_047;
create function meta.wizard_form(
  p_app meta.app, p_table regclass, p_page int, p_label text, p_return int, p_modal boolean, p_columns text[] default null
) returns int
language plpgsql as $$
declare
  v_page int := meta.wizard_form_047(p_app, p_table, p_page, p_label, p_return, p_modal, p_columns);
begin
  update meta.page set warn_unsaved = true where id = v_page;
  return v_page;
end
$$;
