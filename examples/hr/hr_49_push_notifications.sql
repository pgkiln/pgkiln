-- =====================================================================
-- HR example, part 49: push notifications (migration 074)
--
-- The app may send push notifications; users turn them on per device under
-- My account → Notifications. A new leave request notifies the employee's
-- manager, a decision notifies the employee; each notification opens the
-- request (page 7). The in-app notifications of hr.sql stay as they are.
--
-- The triggers only send from the running application (meta.app_id() set):
-- inserts through the API or SQL Workshop don't. A notification that can't
-- be queued never stops the leave request.
-- =====================================================================

update meta.app set pwa = true, pwa_push = true where alias = 'hr';

create function hr.push_leave(p_user text, p_title text, p_body text, p_id int) returns void
language plpgsql set search_path = hr, pg_catalog as $$
begin
  if p_user is null or meta.app_id() is null or not meta.has_push_subscription(p_user) then
    return;
  end if;
  perform meta.send_push(
    p_user  => p_user,
    p_title => p_title,
    p_body  => p_body,
    p_page  => 7,
    p_items => jsonb_build_object('P7_ID', p_id),
    p_tag   => 'leave-' || p_id);
exception when others then
  raise warning 'hr.push_leave: %', sqlerrm;
end
$$;
revoke execute on function hr.push_leave(text, text, text, int) from public;

create function hr.push_leave_requested() returns trigger
language plpgsql security definer set search_path = hr, pg_catalog as $$
begin
  perform hr.push_leave(m.username,
                        format('Leave request from %s', initcap(e.ename)),
                        format('%s day(s) from %s', new.days, to_char(new.start_date, 'DD Mon YYYY')),
                        new.id)
     from hr.emp e join hr.emp m on m.empno = e.mgr
    where e.empno = new.empno;
  return new;
end
$$;

create function hr.push_leave_decided() returns trigger
language plpgsql security definer set search_path = hr, pg_catalog as $$
begin
  if new.status in ('APPROVED', 'REJECTED') then
    perform hr.push_leave(e.username,
                          format('Leave %s', lower(new.status)),
                          format('%s to %s, by %s', to_char(new.start_date, 'DD Mon'), to_char(new.end_date, 'DD Mon'), new.decided_by),
                          new.id)
       from hr.emp e
      where e.empno = new.empno;
  end if;
  return new;
end
$$;

create trigger leave_requested_push after insert on hr.leave_request
  for each row execute function hr.push_leave_requested();
create trigger leave_decided_push after update of status on hr.leave_request
  for each row when (old.status is distinct from new.status)
  execute function hr.push_leave_decided();
