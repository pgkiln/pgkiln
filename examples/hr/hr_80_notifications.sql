-- =====================================================================
-- HR example, part 80: the notification bell and live badges (migration 154)
--
-- HR has had its own notifications since hr.sql: rows in hr.notification
-- (leave requested and decided, the workflows' and automations' messages),
-- listed under "My notifications" on the home page. This part puts them on
-- pgkiln's notification bell as well:
--
--   * Settings → User Interface: Notifications on, Live badges every 30 s
--   * hr.notification gets the page a notification opens (page, items) and
--     an icon; a trigger hands every new row to meta.notify(), so the bell
--     shows it and opening it goes to that page (a leave request opens the
--     request on page 7, the link signed for the recipient)
--   * "Mark all read" on the home page also marks the bell's notifications read
--   * badges from SQL (badge_query), refreshed in place by the live badges:
--     the navigation bar's "Leave requests" (pending requests you can see),
--     "My tasks" (tasks you can act on), the Shortcuts list's "Pending
--     requests" and the "Mark all read" button (your unread notifications)
--   * a timer dynamic action refreshes "My notifications" every 30 seconds
--
-- Sign in as jones, open the home page, and in another browser sign in as
-- scott (a clerk of jones's department) and ask for leave: jones's bell and
-- badges change without a reload.
-- =====================================================================

update meta.app set notifications = true, live_badges_s = 30 where alias = 'hr';

-- the page a notification opens, and its icon
alter table hr.notification add column page int, add column items jsonb, add column icon text;

-- the leave notifications open the request (page 7)
create or replace function hr.notify_leave_requested() returns trigger
language plpgsql security definer set search_path = hr, pg_catalog as $$
begin
  insert into hr.notification (username, message, page, items, icon)
  select m.username, format('%s requested %s day(s) of leave from %s.',
                            e.ename, new.days, to_char(new.start_date, 'DD Mon YYYY')),
         7, jsonb_build_object('P7_ID', new.id), 'calendar'
    from hr.emp e join hr.emp m on m.empno = e.mgr
   where e.empno = new.empno and m.username is not null;
  return new;
end
$$;

create or replace function hr.notify_leave_decided() returns trigger
language plpgsql security definer set search_path = hr, pg_catalog as $$
begin
  if new.status in ('APPROVED', 'REJECTED') then
    insert into hr.notification (username, message, page, items, icon)
    select e.username, format('Your leave from %s to %s was %s by %s.',
                              to_char(new.start_date, 'DD Mon'), to_char(new.end_date, 'DD Mon'),
                              lower(new.status), new.decided_by),
           7, jsonb_build_object('P7_ID', new.id), case new.status when 'APPROVED' then 'check' else 'x' end
      from hr.emp e
     where e.empno = new.empno and e.username is not null;
  end if;
  return new;
end
$$;

-- Every new hr.notification also goes on the bell. Only from the running
-- application (meta.app_id() is HR, notifications on); a row added through
-- the API or SQL Workshop stays in hr.notification only. The bell never
-- stops the change that wrote the notification.
create function hr.notification_to_bell() returns trigger
language plpgsql security definer set search_path = hr, pg_catalog as $$
begin
  if exists (select 1 from meta.app a where a.id = meta.app_id() and a.alias = 'hr' and a.notifications) then
    perform meta.notify(
      p_user  => new.username,
      p_title => left(new.message, 200),
      p_page  => new.page,
      p_items => coalesce(new.items, '{}'::jsonb),
      p_icon  => new.icon);
  end if;
  return new;
exception when others then
  raise warning 'hr.notification_to_bell: %', sqlerrm;
  return new;
end
$$;
revoke execute on function hr.notification_to_bell() from public;

create trigger notification_to_bell after insert on hr.notification
  for each row execute function hr.notification_to_bell();

-- "Mark all read" on the home page: the bell's notifications too
insert into meta.process (page_id, seq, name, type, code, when_button)
select p.id, 20, 'Mark the bell read', 'sql', 'select meta.mark_notifications_read()', 'MARK_READ'
  from meta.page p join meta.app a on a.id = p.app_id where a.alias = 'hr' and p.page_no = 1;

-- the button shows how many of your notifications are unread
update meta.button b set badge_query = 'select nullif(count(*), 0) from hr.notification where read_at is null'
  from meta.page p join meta.app a on a.id = p.app_id
 where b.page_id = p.id and a.alias = 'hr' and p.page_no = 1 and b.name = 'MARK_READ';

-- badges from SQL in the navigation bar and the Shortcuts list (row level
-- security applies: a manager counts their department's requests, an
-- employee their own)
insert into meta.list_entry (app_id, list_name, seq, label, icon, target_page, description, badge_query)
select a.id, 'HR_NAVBAR', e.seq, e.label, e.icon, e.page, e.description, e.badge_query
  from meta.app a, (values
  (20, 'Leave requests', 'calendar', 6, 'Pending leave requests you can see',
   'select nullif(count(*), 0) from hr.leave_request where status = ''PENDING'''),
  (30, 'My tasks', 'check', 14, 'Tasks you can act on',
   'select nullif(count(*), 0) from meta.tasks where app_id = meta.app_id() and may_act and state in (''unassigned'', ''assigned'')')
  ) as e (seq, label, icon, page, description, badge_query)
 where a.alias = 'hr';

update meta.list_entry l set badge_query = 'select count(*) from hr.leave_request where status = ''PENDING'''
  from meta.app a
 where l.app_id = a.id and a.alias = 'hr' and l.list_name = 'HR_SHORTCUTS' and l.label = 'Pending requests';

-- a timer dynamic action: "My notifications" refreshes every 30 seconds while the page is visible
insert into meta.dynamic_action (page_id, seq, name, event, trigger_element, action, affected_region_id)
select p.id, 50, 'Refresh my notifications', 'timer', '30', 'refresh_region', r.id
  from meta.page p join meta.app a on a.id = p.app_id join meta.region r on r.page_id = p.id and r.title = 'My notifications'
 where a.alias = 'hr' and p.page_no = 1;

-- Dutch labels for the new navigation bar entries (part 4's translations)
insert into meta.translation (app_id, language, source, target)
select a.id, 'nl', t.src, t.nl
  from meta.app a, (values ('Leave requests', 'Verlofaanvragen'), ('My tasks', 'Mijn taken')) as t (src, nl)
 where a.alias = 'hr'
on conflict do nothing;
