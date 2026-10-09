-- =====================================================================
-- HR example, part 47: plug-ins with their own code
-- (docs/guide/04-pages-and-regions.md, "Plug-ins with their own code")
--
-- Installs the four example plug-ins of examples/plugins/ (built from
-- their source directories with `pgkiln plugin build`; test/plugins.test.ts
-- checks this file matches them) and uses them on page 40 "Plug-ins":
--   - Team: a "Show more list" region plug-in (show_more);
--   - Note: an item plug-in with a character counter (char_counter);
--   - Copy note: a dynamic action plug-in (copy_value);
--   - Log the note: a process plug-in (log_event) that records the note in
--     pgkiln_plugins.event_log. Its install SQL runs here as the owner, with
--     grants for hr_app (in the builder a developer runs it on request).
-- =====================================================================

-- char-counter
select meta.import_plugin(a.id, $plugin${
  "format": "pgkiln-plugin/2",
  "type": "item",
  "name": "char_counter",
  "label": "Character counter",
  "version": "1.0.0",
  "help": "A text field that stops at a maximum length and shows how many characters are used. Without JavaScript it is a plain text field; add a validation if the limit matters on the server too.",
  "attributes": [
    {
      "name": "MAX",
      "label": "Maximum characters",
      "type": "number",
      "default": "100"
    }
  ],
  "files": [
    {
      "name": "char-counter.js",
      "content": "Ly8gQ2hhcmFjdGVyIGNvdW50ZXIgKGl0ZW0gcGx1Zy1pbik6IGxpbWl0cyB0aGUgZmllbGQgYW5kIHNob3dzICJ1c2VkIC8gbWF4aW11bSIuCnBna2lsbi5wbHVnaW5zLnJlZ2lzdGVyKCdjaGFyX2NvdW50ZXInLCAoeyBlbGVtZW50LCBhdHRyaWJ1dGVzIH0pID0+IHsKICBjb25zdCBpbnB1dCA9IGVsZW1lbnQucXVlcnlTZWxlY3RvcignaW5wdXQsIHRleHRhcmVhJyk7CiAgY29uc3QgbWF4ID0gTnVtYmVyKGF0dHJpYnV0ZXMuTUFYKSB8fCAwOwogIGlmICghaW5wdXQgfHwgbWF4IDw9IDApIHJldHVybjsKICBpbnB1dC5tYXhMZW5ndGggPSBtYXg7CiAgY29uc3Qgb3V0ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnc21hbGwnKTsKICBvdXQuY2xhc3NOYW1lID0gJ2hlbHAgY2hhci1jb3VudGVyJzsKICBvdXQuaWQgPSBgJHtpbnB1dC5pZH1fY291bnRgOwogIG91dC5zZXRBdHRyaWJ1dGUoJ2FyaWEtbGl2ZScsICdwb2xpdGUnKTsKICBpbnB1dC5zZXRBdHRyaWJ1dGUoJ2FyaWEtZGVzY3JpYmVkYnknLCBbaW5wdXQuZ2V0QXR0cmlidXRlKCdhcmlhLWRlc2NyaWJlZGJ5JyksIG91dC5pZF0uZmlsdGVyKEJvb2xlYW4pLmpvaW4oJyAnKSk7CiAgY29uc3Qgc2hvdyA9ICgpID0+IHsKICAgIG91dC50ZXh0Q29udGVudCA9IGAke2lucHV0LnZhbHVlLmxlbmd0aH0gLyAke21heH1gOwogICAgb3V0LmNsYXNzTGlzdC50b2dnbGUoJ2lzLWZ1bGwnLCBpbnB1dC52YWx1ZS5sZW5ndGggPj0gbWF4KTsKICB9OwogIGlucHV0LmFkZEV2ZW50TGlzdGVuZXIoJ2lucHV0Jywgc2hvdyk7CiAgaW5wdXQuYWZ0ZXIob3V0KTsKICBzaG93KCk7Cn0pOwo="
    },
    {
      "name": "char-counter.css",
      "content": "LyogQ2hhcmFjdGVyIGNvdW50ZXIgKGl0ZW0gcGx1Zy1pbikgKi8KLmNoYXItY291bnRlciB7IGRpc3BsYXk6IGJsb2NrOyB0ZXh0LWFsaWduOiBlbmQ7IGZvbnQtdmFyaWFudC1udW1lcmljOiB0YWJ1bGFyLW51bXM7IH0KLmNoYXItY291bnRlci5pcy1mdWxsIHsgZm9udC13ZWlnaHQ6IDYwMDsgfQo="
    }
  ]
}$plugin$::jsonb) from meta.app a where a.alias = 'hr';

-- show-more
select meta.import_plugin(a.id, $plugin${
  "format": "pgkiln-plugin/2",
  "type": "region",
  "name": "show_more",
  "label": "Show more list",
  "version": "1.0.0",
  "help": "A list of the region's rows (columns LABEL and, optionally, DETAIL) that shows the first few and a button for the rest. Without JavaScript every row shows.",
  "attributes": [
    {
      "name": "VISIBLE",
      "label": "Rows shown at first",
      "type": "number",
      "default": "5"
    },
    {
      "name": "BUTTON",
      "label": "Button text",
      "type": "text",
      "default": "Show all"
    }
  ],
  "template_component": {
    "static_id": "show_more",
    "name": "Show more list",
    "css_classes": [
      "tc-divided"
    ],
    "template": "<div class=\"show-more-item\"><span class=\"tc-title\">#LABEL#</span>{if ?DETAIL/} <span class=\"tc-meta\">#DETAIL#</span>{endif/}</div>",
    "wrapper": null
  },
  "files": [
    {
      "name": "show-more.js",
      "content": "Ly8gU2hvdyBtb3JlIGxpc3QgKHJlZ2lvbiBwbHVnLWluKTogaGlkZXMgcm93cyBhZnRlciB0aGUgZmlyc3QgVklTSUJMRSBiZWhpbmQgYSBidXR0b24uCnBna2lsbi5wbHVnaW5zLnJlZ2lzdGVyKCdzaG93X21vcmUnLCAoeyBlbGVtZW50LCBhdHRyaWJ1dGVzIH0pID0+IHsKICBjb25zdCByb3dzID0gWy4uLmVsZW1lbnQucXVlcnlTZWxlY3RvckFsbCgnLnNob3ctbW9yZS1pdGVtJyldOwogIGNvbnN0IHZpc2libGUgPSBNYXRoLm1heCgxLCBOdW1iZXIoYXR0cmlidXRlcy5WSVNJQkxFKSB8fCA1KTsKICBpZiAocm93cy5sZW5ndGggPD0gdmlzaWJsZSkgcmV0dXJuOwogIHJvd3Muc2xpY2UodmlzaWJsZSkuZm9yRWFjaCgocm93KSA9PiAocm93LmhpZGRlbiA9IHRydWUpKTsKICBjb25zdCBidXR0b24gPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCdidXR0b24nKTsKICBidXR0b24udHlwZSA9ICdidXR0b24nOwogIGJ1dHRvbi5jbGFzc05hbWUgPSAnYnRuIHNob3ctbW9yZS1idXR0b24nOwogIGJ1dHRvbi50ZXh0Q29udGVudCA9IGAke2F0dHJpYnV0ZXMuQlVUVE9OIHx8ICdTaG93IGFsbCd9ICgke3Jvd3MubGVuZ3RofSlgOwogIGJ1dHRvbi5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsICgpID0+IHsKICAgIHJvd3MuZm9yRWFjaCgocm93KSA9PiAocm93LmhpZGRlbiA9IGZhbHNlKSk7CiAgICBidXR0b24ucmVtb3ZlKCk7CiAgICAvLyB0aGUgZmlyc3Qgcm93IHRoYXQgd2FzIGhpZGRlbiB0YWtlcyB0aGUgZm9jdXMsIHNvIGtleWJvYXJkIHVzZXJzIGNhcnJ5IG9uIHRoZXJlCiAgICByb3dzW3Zpc2libGVdLnRhYkluZGV4ID0gLTE7CiAgICByb3dzW3Zpc2libGVdLmZvY3VzKCk7CiAgfSk7CiAgZWxlbWVudC5hcHBlbmQoYnV0dG9uKTsKfSk7Cg=="
    }
  ]
}$plugin$::jsonb) from meta.app a where a.alias = 'hr';

-- copy-value
select meta.import_plugin(a.id, $plugin${
  "format": "pgkiln-plugin/2",
  "type": "dynamic_action",
  "name": "copy_value",
  "label": "Copy to clipboard",
  "version": "1.0.0",
  "help": "Copies the first affected item's value to the clipboard and shows a success message.",
  "attributes": [
    {
      "name": "MESSAGE",
      "label": "Message",
      "type": "text",
      "default": "Copied."
    }
  ],
  "files": [
    {
      "name": "copy-value.js",
      "content": "Ly8gQ29weSB0byBjbGlwYm9hcmQgKGR5bmFtaWMgYWN0aW9uIHBsdWctaW4pLgpwZ2tpbG4ucGx1Z2lucy5yZWdpc3RlcignY29weV92YWx1ZScsIGFzeW5jIChkYSkgPT4gewogIGNvbnN0IG5hbWUgPSBkYS5pdGVtc1swXTsKICBpZiAoIW5hbWUpIHJldHVybjsKICBhd2FpdCBuYXZpZ2F0b3IuY2xpcGJvYXJkLndyaXRlVGV4dChTdHJpbmcocGdraWxuLmdldFZhbHVlKG5hbWUpID8/ICcnKSk7CiAgcGdraWxuLnNob3dTdWNjZXNzKGRhLmF0dHJpYnV0ZXMuTUVTU0FHRSB8fCAnQ29waWVkLicpOwp9KTsK"
    }
  ]
}$plugin$::jsonb) from meta.app a where a.alias = 'hr';

-- log-event
select meta.import_plugin(a.id, $plugin${
  "format": "pgkiln-plugin/2",
  "type": "process",
  "name": "log_event",
  "label": "Log an event",
  "version": "1.0.0",
  "help": "Records an event (name and detail, with the user and time) in pgkiln_plugins.event_log and shows MESSAGE. Run the install SQL once; the application's role needs CREATE on the database for it (or run it in the SQL Workshop and grant the role access).",
  "attributes": [
    {
      "name": "EVENT",
      "label": "Event",
      "type": "text",
      "default": "event"
    },
    {
      "name": "DETAIL",
      "label": "Detail (may use &ITEM.)",
      "type": "text"
    },
    {
      "name": "MESSAGE",
      "label": "Message",
      "type": "text"
    }
  ],
  "sql_function": "pgkiln_plugins.log_event",
  "files": [],
  "install_sql": "-- Log an event (process plug-in): the table and the function the process calls.\ncreate schema if not exists pgkiln_plugins;\n\ncreate table if not exists pgkiln_plugins.event_log (\n  id       bigint generated always as identity primary key,\n  at       timestamptz not null default now(),\n  app_user text,\n  event    text not null,\n  detail   text\n);\n\ncreate or replace function pgkiln_plugins.log_event(p_attributes jsonb) returns text\nlanguage plpgsql as $$\nbegin\n  insert into pgkiln_plugins.event_log (app_user, event, detail)\n  values (meta.app_user(), coalesce(nullif(p_attributes->>'EVENT', ''), 'event'), nullif(p_attributes->>'DETAIL', ''));\n  return nullif(p_attributes->>'MESSAGE', '');\nend\n$$;\n"
}$plugin$::jsonb) from meta.app a where a.alias = 'hr';

-- the process plug-in's install SQL
-- Log an event (process plug-in): the table and the function the process calls.
create schema if not exists pgkiln_plugins;

create table if not exists pgkiln_plugins.event_log (
  id       bigint generated always as identity primary key,
  at       timestamptz not null default now(),
  app_user text,
  event    text not null,
  detail   text
);

create or replace function pgkiln_plugins.log_event(p_attributes jsonb) returns text
language plpgsql as $$
begin
  insert into pgkiln_plugins.event_log (app_user, event, detail)
  values (meta.app_user(), coalesce(nullif(p_attributes->>'EVENT', ''), 'event'), nullif(p_attributes->>'DETAIL', ''));
  return nullif(p_attributes->>'MESSAGE', '');
end
$$;

grant usage on schema pgkiln_plugins to hr_app;
grant select, insert on pgkiln_plugins.event_log to hr_app;
grant execute on function pgkiln_plugins.log_event(jsonb) to hr_app;

insert into meta.page (app_id, page_no, name, title, parent_page)
select id, 40, 'Plug-ins', 'Plug-ins', 1 from meta.app where alias = 'hr';

insert into meta.region (page_id, seq, title, type, columns, template, source, config)
select p.id, r.seq, r.title, r.type, r.columns, 'standard', r.source, r.config::jsonb
  from meta.page p join meta.app a on a.id = p.app_id,
  (values
  (10, 'Team', 'plugin', 6,
   $q$select initcap(ename) as label, initcap(job) as detail from hr.emp where active order by ename$q$,
   $j${"plugin": "show_more", "display": "each", "attributes": {"VISIBLE": "4", "BUTTON": "Show everyone"}}$j$),
  (20, 'Note', 'static', 6,
   $h$<p>A note of at most 140 characters (an item plug-in counts them). <b>Log the note</b> runs a process plug-in; <b>Copy note</b> a dynamic action plug-in.</p>$h$,
   '{}')
  ) as r (seq, title, type, columns, source, config)
 where a.alias = 'hr' and p.page_no = 40;

insert into meta.item (page_id, region_id, seq, name, label, type, config)
select p.id, r.id, 10, 'P40_NOTE', 'Note', 'plugin', '{"plugin": "char_counter", "attributes": {"MAX": "140"}, "wide": true}'
  from meta.page p join meta.app a on a.id = p.app_id join meta.region r on r.page_id = p.id and r.title = 'Note'
 where a.alias = 'hr' and p.page_no = 40;

insert into meta.button (page_id, region_id, seq, name, label, action, hot)
select p.id, r.id, b.seq, b.name, b.label, b.action, b.hot
  from meta.page p join meta.app a on a.id = p.app_id join meta.region r on r.page_id = p.id and r.title = 'Note',
  (values (10, 'COPY', 'Copy note', 'da', false), (20, 'LOG', 'Log the note', 'submit', true)) as b (seq, name, label, action, hot)
 where a.alias = 'hr' and p.page_no = 40;

insert into meta.dynamic_action (page_id, seq, name, event, trigger_element, action, affected_items, code, config)
select p.id, 10, 'Copy the note', 'click', 'COPY', 'plugin', 'P40_NOTE', 'copy_value', '{"attributes": {"MESSAGE": "Note copied."}}'
  from meta.page p join meta.app a on a.id = p.app_id
 where a.alias = 'hr' and p.page_no = 40;

insert into meta.process (page_id, seq, name, type, point, when_button, config)
select p.id, 10, 'Log the note', 'plugin', 'submit', 'LOG',
       '{"plugin": "log_event", "attributes": {"EVENT": "hr_note", "DETAIL": "&P40_NOTE.", "MESSAGE": "Note logged."}}'
  from meta.page p join meta.app a on a.id = p.app_id
 where a.alias = 'hr' and p.page_no = 40;

insert into meta.nav_entry (app_id, seq, label, icon, target_page)
select id, 32, 'Plug-ins', 'layers', 40 from meta.app where alias = 'hr';

insert into meta.translation (app_id, language, source, target)
select a.id, 'nl', t.source, t.target
  from meta.app a, (values
  ('Plug-ins', 'Plug-ins'),
  ('Note', 'Notitie'),
  ('Copy note', 'Notitie kopiëren'),
  ('Log the note', 'Notitie vastleggen')
  ) as t (source, target)
 where a.alias = 'hr'
on conflict do nothing;
