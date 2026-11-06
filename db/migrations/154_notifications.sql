-- =====================================================================
-- 154: in-app notifications, list entry badges from SQL, live badges
-- (APEX: navigation menu badges, a notification bell in the header,
-- badges refreshed by dynamic actions and JavaScript)
--
-- meta.notification keeps notifications for the users of an application.
-- Application code adds them with meta.notify(user, title, body, page,
-- items, icon, push) or the declarative process send_notification. With
-- meta.app.notifications on, signed-in users get a bell in the header: the
-- number of unread notifications and the newest ones; opening one marks it
-- read and goes to its page (a link signed for the recipient, as push
-- notifications are). The page /a/<alias>/notifications lists them all.
--
-- meta.list_entry.badge_query: a SELECT whose first value is the entry's
-- badge (as meta.button.badge_query, 029), run as the application's role.
--
-- meta.app.live_badges_s: every so many seconds (10 to 3600) the open page
-- asks the server for its badges again (navigation menu and bar, buttons,
-- the bell) and updates them in place; not while the tab is hidden.
--
-- The dynamic action event timer runs actions every so many seconds (the
-- trigger: a number of seconds, 5 to 3600), e.g. refresh_region.
--
-- Notifications are installation data, not part of the application's export.
-- A user keeps the newest 500; read ones go after 90 days.
-- =====================================================================

alter table meta.app add column notifications boolean not null default false;
comment on column meta.app.notifications is 'In-app notifications (154): a bell in the header for signed-in users (meta.notify, send_notification)';
alter table meta.app add column live_badges_s int check (live_badges_s between 10 and 3600);
comment on column meta.app.live_badges_s is 'Live badges (154): the page refreshes its badges and the bell every so many seconds (null: never)';

-- an export made before 154 has no notifications key: import_app inserts NULL (see 054)
create function meta.app_notifications_default() returns trigger
language plpgsql set search_path = pg_catalog as $$
begin
  new.notifications := coalesce(new.notifications, false);
  return new;
end $$;
create trigger app_notifications_default before insert or update on meta.app
  for each row execute function meta.app_notifications_default();

alter table meta.list_entry add column badge_query text;
comment on column meta.list_entry.badge_query is 'A SELECT whose first value is the badge (154); wins over badge';

alter table meta.process drop constraint process_type_check;
alter table meta.process add constraint process_type_check check (type in (
  'ai_generate', 'chain', 'data_load', 'download', 'form_dml', 'grid_dml', 'invoke_api', 'sql', 'workflow', 'plugin', 'send_push', 'send_email',
  'close_dialog', 'clear_session_state', 'reset_pagination', 'user_preferences', 'server_geocoding', 'print_report',
  'human_task_create', 'human_task_manage', 'form_init', 'send_notification'));

alter table meta.dynamic_action drop constraint dynamic_action_event_check;
alter table meta.dynamic_action add constraint dynamic_action_event_check check (event in (
  'change', 'click', 'load', 'dialog_closed', 'after_refresh', 'selection_change', 'focus', 'blur', 'key_release', 'before_submit', 'custom', 'menu_entry',
  'double_click', 'key_down', 'key_press', 'mouse_enter', 'mouse_leave', 'select', 'resize', 'scroll', 'page_unload', 'before_refresh', 'facets_change',
  'grid_row_init', 'grid_save', 'calendar_date_select', 'calendar_view_change', 'map_object_click', 'map_change', 'tree_selection_change', 'timer'));

create table meta.notification (
  id          bigserial primary key,
  app_id      int  not null references meta.app on delete cascade,
  username    text not null check (username ~ '^[^\s:]{1,100}$'),
  title       text not null check (length(title) between 1 and 200),
  body        text check (length(body) <= 1000),
  -- a page of the application with items, signed for the recipient (as meta.send_push)
  url         text check (url ~ '^/a/[a-z0-9_-]+/[0-9]+(\?[^\s<>"''`\\]*)?$'),
  icon        text check (icon ~ '^[a-z0-9-]{1,40}$'),
  created_by  text,
  created_at  timestamptz not null default now(),
  read_at     timestamptz
);
create index notification_user on meta.notification (app_id, lower(username), id desc);
create index notification_unread on meta.notification (app_id, lower(username)) where read_at is null;
revoke all on meta.notification from public;
-- the runtime shows a user their own and marks them read (src/runtime/notifications.ts)
grant select, update (read_at), delete on meta.notification to pgkiln_runtime;
comment on table meta.notification is 'In-app notifications of application users (154): meta.notify; not exported';

-- (090) an isolated workspace's logins see their own applications' rows only
alter table meta.notification enable row level security;
create policy workspace on meta.notification
  using ((select meta.isolation_off()) or app_id in (select meta.visible_apps()))
  with check ((select meta.isolation_off()) or app_id in (select meta.visible_apps()));

-- ---------------------------------------------------------------- the API

-- Add a notification for p_user of the current application; returns its id.
-- p_page/p_items: the page it opens (signed for p_user). p_icon: an icon name.
-- p_push: also send it to the user's devices when push notifications are on.
create function meta.notify(
  p_user  text,
  p_title text,
  p_body  text    default null,
  p_page  int     default null,
  p_items jsonb   default '{}',
  p_icon  text    default null,
  p_push  boolean default false
) returns bigint
language plpgsql volatile security definer set search_path = meta, pg_catalog as $$
declare
  v_app   int := meta.app_id();
  v_alias text;
  v_on    boolean;
  v_push  boolean;
  v_url   text;
  v_id    bigint;
begin
  if v_app is null then
    raise exception 'meta.notify: no current application (call it from application code)';
  end if;
  select alias, notifications, pwa and pwa_push into v_alias, v_on, v_push from meta.app where id = v_app;
  if not coalesce(v_on, false) then
    raise exception 'meta.notify: notifications are off for this application (Settings → User Interface → Notifications)';
  end if;
  if p_user is null or p_user !~ '^[^\s:]{1,100}$' then
    raise exception 'meta.notify: the user name is required (at most 100 characters, no spaces)';
  end if;
  if p_title is null or length(btrim(p_title)) not between 1 and 200 then
    raise exception 'meta.notify: the title is required (at most 200 characters)';
  end if;
  if length(p_body) > 1000 then
    raise exception 'meta.notify: the body has at most 1000 characters';
  end if;
  if p_icon is not null and p_icon !~ '^[a-z0-9-]{1,40}$' then
    raise exception 'meta.notify: the icon is an icon name (lower case letters, digits and -)';
  end if;
  if p_items is not null and p_items <> '{}'::jsonb and (jsonb_typeof(p_items) <> 'object' or p_page is null) then
    raise exception 'meta.notify: the items are a JSON object of item names and values, with a page';
  end if;
  if p_page is not null then
    if not exists (select 1 from meta.page where app_id = v_app and page_no = p_page) then
      raise exception 'meta.notify: page % does not exist in this application', p_page;
    end if;
    v_url := format('/a/%s/%s', v_alias, p_page)
      || case when coalesce(p_items, '{}'::jsonb) = '{}'::jsonb then '' else
           '?' || (select string_agg(upper(key) || '=' || meta.url_encode(coalesce(value #>> '{}', '')), '&' order by upper(key) collate "C")
                     from jsonb_each(p_items))
           || '&cs=' || meta.url_checksum(v_app, p_page, p_user, p_items) end;
  end if;
  insert into meta.notification (app_id, username, title, body, url, icon, created_by)
  values (v_app, p_user, btrim(p_title), nullif(p_body, ''), v_url, p_icon, meta.app_user())
  returning id into v_id;
  -- a user keeps the newest 500
  delete from meta.notification where id in (
    select id from meta.notification where app_id = v_app and lower(username) = lower(p_user) order by id desc offset 500);
  -- now and then: read notifications older than 90 days
  if random() < 0.02 then
    delete from meta.notification where app_id = v_app and read_at < now() - interval '90 days';
  end if;
  if p_push and coalesce(v_push, false) then
    perform meta.send_push(p_user, btrim(p_title), nullif(p_body, ''), p_page, coalesce(p_items, '{}'::jsonb), 'n' || v_id);
  end if;
  return v_id;
end
$$;

-- The number of unread notifications of p_user (default: the current user), e.g. as a badge_query.
create function meta.unread_notifications(p_user text default null) returns int
language sql stable security definer set search_path = meta, pg_catalog as $$
  select count(*)::int from meta.notification
   where app_id = meta.app_id() and lower(username) = lower(coalesce(p_user, meta.app_user())) and read_at is null
$$;

-- Mark the current user's notification p_id read, or all of them (p_id null); returns how many.
create function meta.mark_notifications_read(p_id bigint default null) returns int
language plpgsql volatile security definer set search_path = meta, pg_catalog as $$
declare
  n int;
begin
  update meta.notification set read_at = now()
   where app_id = meta.app_id() and lower(username) = lower(meta.app_user()) and read_at is null
     and (p_id is null or id = p_id);
  get diagnostics n = row_count;
  return n;
end
$$;

-- The current user's notifications in the current application (for a report of your own).
create view meta.my_notifications with (security_barrier) as
  select id, title, body, url, icon, created_at, read_at, read_at is null as unread
    from meta.notification
   where app_id = meta.app_id() and lower(username) = lower(meta.app_user());
comment on view meta.my_notifications is 'The current user''s notifications in the current application (154), newest first by id';

grant execute on function meta.notify(text, text, text, int, jsonb, text, boolean), meta.unread_notifications(text),
  meta.mark_notifications_read(bigint) to public;
grant select on meta.my_notifications to public;
