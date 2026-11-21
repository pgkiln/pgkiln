-- =====================================================================
-- HR example, part 110: forms from a JSON schema (sprint 246, MG-19;
-- migration 203; docs/guide/04-pages-and-regions.md "json_form (JSON form)")
--
-- Page 74 "Inspections" (Administration): the inspection forms are rows of
-- hr.form_template, each a JSON schema an administrator keeps there, not
-- pages of the application. Choose a form and fill it in:
--   - the JSON form region "Inspection" draws the schema's fields: text,
--     a date, a time, a date and time, e-mail, URL, a select list and a
--     radio group (enum / oneOf), a checkbox group, yes/no, numbers with a
--     minimum and maximum, a text area, a group of fields and repeating
--     rows (follow-up actions: Add a row / Remove);
--   - Save posts the answers as one JSON value into P74_ANSWERS (a hidden
--     item), checked against the schema on the server first, and stores
--     them in hr.form_answer (one row per form and user);
--   - "Your saved answers" is the same region type with {"read_only": true}.
-- =====================================================================

create table hr.form_template (
  id     int generated always as identity primary key,
  name   text not null unique check (length(name) <= 100),
  schema jsonb not null
);

create table hr.form_answer (
  template_id int not null references hr.form_template (id),
  username    text not null,
  answers     jsonb not null,
  updated_at  timestamptz not null default now(),
  primary key (template_id, username)
);
grant select on hr.form_template to hr_app;
grant select, insert, update on hr.form_answer to hr_app;

insert into hr.form_template (name, schema) values
('Workplace inspection', $j${
  "title": "Workplace inspection",
  "description": "Walk through the room with this list. Fields marked * are required.",
  "type": "object",
  "x-order": ["location", "department", "inspected_on", "start_time", "inspector_email", "overall", "hazards", "score",
              "temperature", "fire_exits_clear", "contact", "notes", "manual_url", "signed_off_at", "actions"],
  "required": ["location", "inspected_on", "overall"],
  "properties": {
    "location": {"type": "string", "title": "Location", "maxLength": 100, "x-placeholder": "Building and room"},
    "department": {"type": "integer", "title": "Department",
                   "oneOf": [{"const": 10, "title": "Accounting"}, {"const": 20, "title": "Research"},
                             {"const": 30, "title": "Sales"}, {"const": 40, "title": "Operations"}]},
    "inspected_on": {"type": "string", "format": "date", "title": "Inspection date"},
    "start_time": {"type": "string", "format": "time", "title": "Start time"},
    "inspector_email": {"type": "string", "format": "email", "title": "Inspector's e-mail"},
    "overall": {"type": "string", "title": "Overall condition", "x-widget": "radio",
                "enum": ["good", "fair", "poor"], "x-enum-labels": ["Good", "Fair", "Poor"]},
    "hazards": {"type": "array", "title": "Hazards found", "uniqueItems": true,
                "items": {"type": "string", "enum": ["trip", "electrical", "fire", "chemical"],
                          "x-enum-labels": ["Trip hazard", "Electrical", "Fire", "Chemicals"]}},
    "score": {"type": "integer", "title": "Score (0–10)", "minimum": 0, "maximum": 10},
    "temperature": {"type": "number", "title": "Room temperature (°C)", "minimum": -10, "maximum": 50},
    "fire_exits_clear": {"type": "boolean", "title": "The fire exits are clear"},
    "contact": {"type": "object", "title": "Contact on site", "x-order": ["name", "phone"],
                "properties": {"name": {"type": "string", "title": "Name"}, "phone": {"type": "string", "title": "Phone", "maxLength": 30}}},
    "notes": {"type": "string", "title": "Notes", "x-widget": "textarea", "maxLength": 2000,
              "description": "Anything the next inspector should know."},
    "manual_url": {"type": "string", "format": "uri", "title": "Safety manual (link)"},
    "signed_off_at": {"type": "string", "format": "date-time", "title": "Signed off at"},
    "actions": {"type": "array", "title": "Follow-up actions", "maxItems": 20,
                "items": {"type": "object", "required": ["what"], "x-order": ["what", "owner", "due", "done"],
                          "properties": {"what": {"type": "string", "title": "What", "maxLength": 200},
                                         "owner": {"type": "string", "title": "Who"},
                                         "due": {"type": "string", "format": "date", "title": "Due"},
                                         "done": {"type": "boolean", "title": "Done"}}}}
  }
}$j$),
('Company car check', $j${
  "type": "object",
  "x-order": ["plate", "mileage", "tyres", "remarks"],
  "required": ["plate", "mileage"],
  "properties": {
    "plate": {"type": "string", "title": "Number plate", "maxLength": 12},
    "mileage": {"type": "integer", "title": "Mileage (km)", "minimum": 0},
    "tyres": {"type": "string", "title": "Tyres", "enum": ["ok", "worn", "replace"], "x-enum-labels": ["OK", "Worn", "Replace now"]},
    "remarks": {"type": "string", "title": "Remarks", "x-widget": "textarea"}
  }
}$j$);

insert into meta.page (app_id, page_no, name, title, parent_page)
select id, 74, 'Inspections', 'Inspections', 1 from meta.app where alias = 'hr';

-- the form chosen (the first one at first), as the regions' sources use it
insert into meta.region (page_id, seq, title, type, columns, template, source, static_id, config)
select p.id, r.seq, r.title, r.type, 12, 'standard', r.source, r.static_id, r.config::jsonb
  from meta.page p join meta.app a on a.id = p.app_id, (values
  (10, 'Form', 'static', '<p>The forms are JSON schemas in the table hr.form_template: a new form is a new row, not a new page.</p>', 'jf-choose', '{}'),
  (20, 'Inspection', 'json_form',
   $s$select t.schema, a.answers as value
  from hr.form_template t
  left join hr.form_answer a on a.template_id = t.id and a.username = :APP_USER
 where t.id = coalesce(nullif(:P74_TEMPLATE, '')::int, (select min(id) from hr.form_template))$s$,
   'jf-form', '{"item": "P74_ANSWERS", "empty_rows": 2}'),
  (30, 'Your saved answers', 'json_form',
   $s$select t.schema, a.answers as value
  from hr.form_template t
  join hr.form_answer a on a.template_id = t.id and a.username = :APP_USER
 where t.id = coalesce(nullif(:P74_TEMPLATE, '')::int, (select min(id) from hr.form_template))$s$,
   'jf-saved', '{"read_only": true}')
  ) as r (seq, title, type, source, static_id, config)
 where a.alias = 'hr' and p.page_no = 74;

-- the saved answers show once there are some
update meta.region r set condition_type = 'exists',
       condition = $c$select 1 from hr.form_answer a
 where a.username = :APP_USER and a.template_id = coalesce(nullif(:P74_TEMPLATE, '')::int, (select min(id) from hr.form_template))$c$
  from meta.page p join meta.app a on a.id = p.app_id
 where r.page_id = p.id and a.alias = 'hr' and p.page_no = 74 and r.static_id = 'jf-saved';

insert into meta.item (page_id, region_id, seq, name, label, type, lov, config)
select p.id, r.id, i.seq, i.name, i.label, i.type, i.lov, i.config::jsonb
  from (values
  (10, 'P74_TEMPLATE', 'Form', 'select', 'select name as d, id as r from hr.form_template order by id', 'jf-choose', '{"submit_on_change": true, "null_label": false}'),
  (20, 'P74_ANSWERS', null, 'hidden', null, 'jf-form', '{}')
  ) as i (seq, name, label, type, lov, region, config)
  join meta.page p on p.page_no = 74
  join meta.app a on a.id = p.app_id and a.alias = 'hr'
  join meta.region r on r.page_id = p.id and r.static_id = i.region;

insert into meta.button (page_id, region_id, seq, name, label, action, hot)
select p.id, r.id, 10, 'SAVE', 'Save', 'submit', true
  from meta.page p join meta.app a on a.id = p.app_id and a.alias = 'hr'
  join meta.region r on r.page_id = p.id and r.static_id = 'jf-form'
 where p.page_no = 74;

insert into meta.process (page_id, seq, name, type, point, code, when_button, success_message)
select p.id, 10, 'Store the answers', 'sql', 'submit',
       $c$insert into hr.form_answer (template_id, username, answers)
values (coalesce(nullif(:P74_TEMPLATE, '')::int, (select min(id) from hr.form_template)), :APP_USER, :P74_ANSWERS::jsonb)
on conflict (template_id, username) do update set answers = excluded.answers, updated_at = now()$c$,
       'SAVE', 'Your answers are saved.'
  from meta.page p join meta.app a on a.id = p.app_id
 where a.alias = 'hr' and p.page_no = 74;

insert into meta.nav_entry (app_id, parent_id, seq, label, icon, target_page)
select a.id, n.id, 74, 'Inspections', 'check', 74
  from meta.app a join meta.nav_entry n on n.app_id = a.id and n.label = 'Administration' and n.parent_id is null
 where a.alias = 'hr';

insert into meta.translation (app_id, language, source, target)
select a.id, 'nl', t.source, t.target
  from meta.app a, (values
  ('Inspections', 'Inspecties'),
  ('Inspection', 'Inspectie'),
  ('Your saved answers', 'Je opgeslagen antwoorden'),
  ('Your answers are saved.', 'Je antwoorden zijn opgeslagen.')
  ) as t (source, target)
 where a.alias = 'hr'
on conflict do nothing;
