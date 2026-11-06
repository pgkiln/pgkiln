-- =====================================================================
-- Sample app "Sample Calendar" (App Gallery → Sample Apps)
--
-- The calendar region: month, week, day and list views, all-day and timed
-- events, events over several days, create on click, drag and drop through
-- a PL/pgSQL function with its own rule, a calendar filtered by an item, and
-- dynamic actions on a day chosen and on another view.
-- The events are placed around today, so there is always something to see.
--
-- Installed by an administrator from the App Gallery, or with
--   psql "$DATABASE_URL" -1 -f examples/gallery/samples/sample-calendar.sql
-- then open /a/sample-calendar and sign in as demo / demo.
-- =====================================================================

create or replace function pg_temp.page_id(p_alias text, p_page int) returns int language sql stable as
  $$ select p.id from meta.page p join meta.app a on a.id = p.app_id where a.alias = p_alias and p.page_no = p_page $$;

-- 1. Schema and data ---------------------------------------------------------
create schema sample_calendar;

create table sample_calendar.event (
  id       int generated always as identity primary key,
  title    text not null,
  category text not null default 'Meeting' check (category in ('Meeting', 'Training', 'Travel', 'Holiday')),
  starts   timestamp not null,
  ends     timestamp,
  location text,
  notes    text,
  check (ends is null or ends >= starts)
);

-- this week's Monday as the anchor: meetings by the hour, all-day and multi-day events
insert into sample_calendar.event (title, category, starts, ends, location)
select e.title, e.category, w.monday + e.day_offset + e.start_at, case when e.end_at is null then null else w.monday + e.end_day + e.end_at end, e.location
  from (select date_trunc('week', current_date)::date as monday) w,
  (values
  ('Team stand-up', 'Meeting', 0, interval '9 hours', 0, interval '9 hours 15 minutes', 'Room 1'),
  ('Planning', 'Meeting', 0, interval '10 hours', 0, interval '11 hours 30 minutes', 'Room 2'),
  ('Customer call', 'Meeting', 1, interval '14 hours', 1, interval '15 hours', 'Online'),
  ('Team stand-up', 'Meeting', 2, interval '9 hours', 2, interval '9 hours 15 minutes', 'Room 1'),
  ('SQL course', 'Training', 2, interval '0 hours', 3, interval '0 hours', 'Training centre'),
  ('Trip to the trade fair', 'Travel', 7, interval '0 hours', 9, interval '0 hours', 'Utrecht'),
  ('Review', 'Meeting', 4, interval '13 hours', 4, interval '14 hours', 'Room 2'),
  ('Lunch and learn', 'Training', 8, interval '12 hours', 8, interval '13 hours', 'Canteen'),
  ('Retrospective', 'Meeting', 11, interval '15 hours', 11, interval '16 hours', 'Room 1'),
  ('Public holiday', 'Holiday', 14, interval '0 hours', null, null, null),
  ('Budget meeting', 'Meeting', -3, interval '10 hours', -3, interval '12 hours', 'Board room'),
  ('First aid course', 'Training', -7, interval '0 hours', -6, interval '0 hours', 'Training centre'),
  ('Quarter review', 'Meeting', 18, interval '9 hours', 18, interval '11 hours', 'Board room'),
  ('Holiday', 'Holiday', 21, interval '0 hours', 25, interval '0 hours', null)
  ) as e (title, category, day_offset, start_at, end_day, end_at, location);

-- drag and drop: the calendar calls this with the new start and end; holidays stay where they are
create function sample_calendar.move_event(p_id int, p_start timestamp, p_end timestamp) returns void
language plpgsql as $$
begin
  if exists (select 1 from sample_calendar.event where id = p_id and category = 'Holiday') then
    raise exception 'Holidays can''t be moved.';
  end if;
  update sample_calendar.event set starts = p_start, ends = p_end where id = p_id;
end
$$;

-- 2. The application's database role ----------------------------------------
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'app_sample_calendar') then create role app_sample_calendar nologin; end if;
end $$;
grant app_sample_calendar to pgkiln_runtime;
grant usage on schema sample_calendar to app_sample_calendar;
grant select, insert, update, delete on all tables in schema sample_calendar to app_sample_calendar;
grant execute on all functions in schema sample_calendar to app_sample_calendar;

-- 3. The application ----------------------------------------------------------
insert into meta.app (alias, name, home_page, authentication, db_role)
values ('sample-calendar', 'Sample Calendar', 1, 'app_users', 'app_sample_calendar');

insert into meta.app_user (app_id, username, password_hash, roles)
select id, 'demo', meta.hash_password('demo'), '{}' from meta.app where alias = 'sample-calendar';

insert into meta.page (app_id, page_no, name, title, parent_page)
select a.id, p.no, p.name, p.name, p.parent
  from meta.app a, (values
  (1, 'Sample Calendar', null), (2, 'Month', 1), (4, 'Week planner', 1), (5, 'Agenda', 1), (6, 'By category', 1), (7, 'Calendar events', 1)
  ) as p (no, name, parent)
 where a.alias = 'sample-calendar';

-- page 3: the event form, a modal dialog (the Form wizard), opened from the calendars
select meta.generate_page('sample-calendar', 'form', 'sample_calendar.event', 3,
  '{"label": "Event", "mode": "modal", "return_page": 2, "nav": false}');
update meta.page set parent_page = 2 where id = pg_temp.page_id('sample-calendar', 3);
update meta.item set type = 'select', lov = 'STATIC:Meeting,Training,Travel,Holiday'
 where page_id = pg_temp.page_id('sample-calendar', 3) and name = 'P3_CATEGORY';
update meta.item set help = 'Leave it empty for an event without an end (all day when the start is at midnight).'
 where page_id = pg_temp.page_id('sample-calendar', 3) and name = 'P3_ENDS';

insert into meta.nav_entry (app_id, seq, label, icon, target_page)
select a.id, n.seq, n.label, n.icon, n.page
  from meta.app a, (values
  (10, 'Home', 'home', 1), (20, 'Month', 'calendar', 2), (30, 'Week planner', 'clock', 4),
  (40, 'Agenda', 'list', 5), (50, 'By category', 'filter', 6), (60, 'Calendar events', 'bolt', 7)
  ) as n (seq, label, icon, page)
 where a.alias = 'sample-calendar';

insert into meta.list (app_id, name, type, description)
select id, 'CALENDAR_TOPICS', 'static', 'The pages of Sample Calendar' from meta.app where alias = 'sample-calendar';

insert into meta.list_entry (app_id, list_name, seq, label, icon, target_page, description)
select a.id, 'CALENDAR_TOPICS', e.seq, e.label, e.icon, e.page, e.description
  from meta.app a, (values
  (10, 'Month', 'calendar', 2, 'All four views; click a day to add an event, drag an event to move it.'),
  (20, 'Week planner', 'clock', 4, 'Week and day views from 7:00 to 19:00, opened on the week.'),
  (30, 'Agenda', 'list', 5, 'The list view only: a month of events per day.'),
  (40, 'By category', 'filter', 6, 'A calendar whose query uses a page item, refreshed when it changes.'),
  (50, 'Calendar events', 'bolt', 7, 'Dynamic actions on the calendar''s own events: a day chosen, another view or period.')
  ) as e (seq, label, icon, page, description)
 where a.alias = 'sample-calendar';

insert into meta.region (page_id, seq, title, type, columns, template, source, config, static_id)
select pg_temp.page_id('sample-calendar', r.page), r.seq, r.title, r.type, r.cols, r.template, r.source, r.config::jsonb, r.sid
  from (values
  -- 1 Home
  (1, 10, 'Sample Calendar', 'static', 12, 'hero',
   '<p>A calendar region shows the rows of a SELECT with a <code>start_date</code>, an optional <code>end_date</code> and a <code>title</code>. Dates are all-day events, timestamps events with a time. Every view is a plain link, so the calendar works without JavaScript and can be bookmarked.</p>',
   '{"icon": "calendar"}', null),
  (1, 20, 'Topics', 'list', 12, 'plain', null, '{"list": "CALENDAR_TOPICS", "template": "cards"}', null),
  (1, 30, 'Today and tomorrow', 'calendar', 12, 'standard',
   E'select starts as start_date, ends as end_date, title, id\n  from sample_calendar.event\n where starts < current_date + 2 and coalesce(ends, starts) >= current_date',
   '{"views": ["list"], "link": {"page": 3, "items": {"P3_ID": "#id#"}}}', null),

  -- 2 Month
  (2, 5, 'About this page', 'static', 12, 'plain',
   '<p class="lead">The attribute <code>link</code> opens an event in the form; <code>create</code> adds a <strong>+</strong> to every day and hour that opens the form with <code>#start#</code> and <code>#end#</code> filled in; <code>move</code> lets you drag events to another day or hour. The move runs <code>sample_calendar.move_event</code>, which refuses to move a holiday: try it.</p>',
   '{}', null),
  (2, 10, 'Events', 'calendar', 12, 'standard',
   E'select starts as start_date, ends as end_date, title || coalesce('' ('' || location || '')'', '''') as title, id\n  from sample_calendar.event',
   '{"views": ["month", "week", "day", "list"], "link": {"page": 3, "items": {"P3_ID": "#id#"}},
     "create": {"page": 3, "items": {"P3_STARTS": "#start#", "P3_ENDS": "#end#"}},
     "move": "select sample_calendar.move_event(:EVENT_ID::int, :NEW_START::timestamp, :NEW_END::timestamp)"}', 'events'),

  -- 4 Week planner
  (4, 5, 'About this page', 'static', 12, 'plain',
   '<p class="lead">With <code>"views": ["week", "day"]</code> and <code>"view": "week"</code> the calendar opens on the week; <code>day_start</code> and <code>day_end</code> set its hours (widened when an event needs it). On a phone the week becomes an agenda list.</p>',
   '{}', null),
  (4, 10, 'This week', 'calendar', 12, 'standard',
   E'select starts as start_date, ends as end_date, title, id\n  from sample_calendar.event where category in (''Meeting'', ''Training'')',
   '{"views": ["week", "day"], "view": "week", "day_start": 7, "day_end": 19, "link": {"page": 3, "items": {"P3_ID": "#id#"}},
     "create": {"page": 3, "items": {"P3_STARTS": "#start#", "P3_ENDS": "#end#"}}}', null),

  -- 5 Agenda
  (5, 5, 'About this page', 'static', 12, 'plain',
   '<p class="lead">The <code>list</code> view alone: the month''s events per day, with ‹ and › to move by a month.</p>',
   '{}', null),
  (5, 10, 'Agenda', 'calendar', 12, 'standard',
   E'select starts as start_date, ends as end_date, category || '': '' || title as title, id\n  from sample_calendar.event',
   '{"views": ["list"], "link": {"page": 3, "items": {"P3_ID": "#id#"}}}', null),

  -- 6 By category
  (6, 5, 'About this page', 'static', 12, 'plain',
   '<p class="lead">The query uses the page item <code>:P6_CATEGORY</code>. A dynamic action refreshes the calendar when the item changes (without JavaScript, the item submits the page).</p>',
   '{}', null),
  (6, 10, 'Filter', 'static', 12, 'standard', null, '{}', 'filter'),
  (6, 20, 'Events of the category', 'calendar', 12, 'standard',
   E'select starts as start_date, ends as end_date, title, id\n  from sample_calendar.event\n where :P6_CATEGORY is null or category = :P6_CATEGORY',
   '{"views": ["month", "list"], "link": {"page": 3, "items": {"P3_ID": "#id#"}}}', 'category-calendar'),

  -- 7 Calendar events
  (7, 5, 'About this page', 'static', 12, 'plain',
   '<p class="lead">Dynamic actions can listen to the calendar itself (the trigger is its static id <code>planner</code>). <strong>Date Select</strong> (<code>calendar_date_select</code>) runs when you click an empty day or hour: a <em>Set Value</em> without SQL puts the chosen date into <code>P7_DAY</code> and the report beside it is refreshed with that day''s events. This calendar has no <code>create</code> link, so a click only chooses (with one, a <em>Cancel Event</em> on this event would keep the form closed). <strong>View Change</strong> (<code>calendar_view_change</code>) runs on the page that comes back from another view or period: the view (<code>month</code>, <code>week</code>, <code>day</code> or <code>list</code>) goes into <code>P7_VIEW</code>, and the day view adds a hint.</p>',
   '{}', null),
  (7, 10, 'Planner', 'calendar', 8, 'standard',
   E'select starts as start_date, ends as end_date, title, id\n  from sample_calendar.event',
   '{"views": ["month", "week", "day", "list"], "link": {"page": 3, "items": {"P3_ID": "#id#"}}}', 'planner'),
  (7, 20, 'Chosen day', 'static', 4, 'standard', null, '{}', 'chosen'),
  (7, 30, 'Events of the day', 'classic_report', 4, 'standard',
   E'select to_char(starts, ''HH24:MI'') as "Time", title as "Event", category as "Category"\n  from sample_calendar.event\n where :P7_DAY is not null\n   and starts::date <= left(:P7_DAY, 10)::date and coalesce(ends, starts)::date >= left(:P7_DAY, 10)::date\n order by starts',
   '{"empty": "Click a day in the calendar."}', 'day-events')
  ) as r (page, seq, title, type, cols, template, source, config, sid);

insert into meta.item (page_id, region_id, seq, name, label, type, lov, config)
select pg_temp.page_id('sample-calendar', 6), r.id, 10, 'P6_CATEGORY', 'Category', 'radio',
       'STATIC:Meeting,Training,Travel,Holiday', '{"warn_unsaved": false}'
  from meta.region r where r.page_id = pg_temp.page_id('sample-calendar', 6) and r.static_id = 'filter';

insert into meta.dynamic_action (page_id, seq, name, event, trigger_element, action, affected_region_id, items_to_submit)
select pg_temp.page_id('sample-calendar', 6), 10, 'Refresh the calendar', 'change', 'P6_CATEGORY', 'refresh_region', r.id, 'P6_CATEGORY'
  from meta.region r where r.page_id = pg_temp.page_id('sample-calendar', 6) and r.static_id = 'category-calendar';

-- page 7: dynamic actions on the calendar's own events (trigger: its static id)
insert into meta.item (page_id, region_id, seq, name, label, type, help, config)
select pg_temp.page_id('sample-calendar', 7), r.id, i.seq, i.name, i.label, i.type, i.help, '{"warn_unsaved": false}'
  from meta.region r, (values
  (10, 'P7_DAY', 'Chosen day', 'text', 'Set by the calendar_date_select dynamic action: YYYY-MM-DD, or YYYY-MM-DDTHH:MM for an hour.'),
  (20, 'P7_VIEW', 'Calendar view', 'display', 'Set by the calendar_view_change dynamic action.')
  ) as i (seq, name, label, type, help)
 where r.page_id = pg_temp.page_id('sample-calendar', 7) and r.static_id = 'chosen';

insert into meta.dynamic_action (page_id, seq, name, event, trigger_element, condition_type, condition_value, action,
                                 affected_items, affected_region_id, items_to_submit, message)
select pg_temp.page_id('sample-calendar', 7), d.seq, d.name, d.event, 'planner', d.ctype, d.cvalue, d.action, d.items,
       (select id from meta.region where page_id = pg_temp.page_id('sample-calendar', 7) and static_id = d.region), d.submit, d.message
  from (values
  (10, 'The chosen day into P7_DAY', 'calendar_date_select', null, null, 'set_value', 'P7_DAY', null, null, null),
  (20, 'Its events', 'calendar_date_select', null, null, 'refresh_region', null, 'day-events', 'P7_DAY', null),
  (40, 'The view into P7_VIEW', 'calendar_view_change', null, null, 'set_value', 'P7_VIEW', null, null, null),
  (50, 'A hint for the day view', 'calendar_view_change', 'equals', 'day', 'show_success', null, null, null,
   'The day view: click an hour to see the events of that day.')
  ) as d (seq, name, event, ctype, cvalue, action, items, region, submit, message);
