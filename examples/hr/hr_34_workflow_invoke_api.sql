-- =====================================================================
-- HR sample, part 34: a workflow that calls a web service (an invoke_api
-- step, see docs/guide/06-processing.md#invoke-api-steps)
--
-- The workflow DEPARTMENT_CHECK calls the REST data source DEPARTMENT
-- (part 23: GET departments/{deptno} of the HR example's own REST API) on
-- the server, puts the answer into the variables DNAME and LOCATION (and the
-- HTTP status into HTTP_STATUS), then notifies the user who started it.
-- Page 23 (Web services) gets a "Check in a workflow" button that starts it.
--
-- Like page 23, it needs the server to allow its own host, e.g. in .env
-- PGKILN_REST_PRIVATE_HOSTS=127.0.0.1:3100; otherwise the step faults with
-- the allow-list message, and an administrator (king) can retry it from the
-- workflow console on page 14 once the setting is there.
-- =====================================================================

-- a notification for the user the workflow runs for (its initiator): only ever for oneself
create function hr.notify_me(p_message text) returns boolean
language plpgsql security definer set search_path = hr, pg_catalog as $$
begin
  if meta.app_user() is null or meta.app_user() = 'nobody' then
    return false;
  end if;
  insert into hr.notification (username, message) values (meta.app_user(), left(p_message, 500));
  return true;
end
$$;
revoke all on function hr.notify_me(text) from public;
grant execute on function hr.notify_me(text) to hr_app;

insert into meta.workflow_definition (app_id, name, title, description, admin_role, steps)
select id, 'DEPARTMENT_CHECK', 'Department &DEPTNO. check',
       'Looks a department up through the HR REST API (an invoke_api step) and notifies the initiator.', 'admin',
       $s$[
  {"name": "LOOKUP", "type": "invoke_api", "source": "DEPARTMENT", "params": {"deptno": "&DEPTNO."},
   "variables": {"DNAME": "dname", "LOCATION": "location"}, "status_variable": "HTTP_STATUS", "timeout": 10},
  {"name": "FOUND", "type": "switch", "cases": [{"when": ":HTTP_STATUS::int = 200", "next": "NOTIFY"}], "otherwise": "MISSING"},
  {"name": "NOTIFY", "type": "sql", "next": "END",
   "code": "select hr.notify_me(format('Department %s is in %s (checked by a workflow through the HR API).', :DNAME, :LOCATION)) as notified"},
  {"name": "MISSING", "type": "sql",
   "code": "select hr.notify_me(format('The HR API does not know department %s (HTTP %s).', :DEPTNO, :HTTP_STATUS)) as notified"},
  {"name": "END", "type": "end"}
]$s$::jsonb
  from meta.app where alias = 'hr';

insert into meta.button (page_id, region_id, seq, name, label, action, hot)
select p.id, r.id, 20, 'CHECK_WF', 'Check in a workflow', 'submit', false
  from meta.page p join meta.app a on a.id = p.app_id join meta.region r on r.page_id = p.id and r.title = 'Look up a department'
 where a.alias = 'hr' and p.page_no = 23;

insert into meta.validation (page_id, seq, name, item_name, type, message, when_button)
select p.id, 20, 'Department chosen (workflow)', 'P23_DEPTNO', 'not_null', 'Choose a department.', 'CHECK_WF'
  from meta.page p join meta.app a on a.id = p.app_id where a.alias = 'hr' and p.page_no = 23;

insert into meta.process (page_id, seq, name, type, point, when_button, config, success_message)
select p.id, 20, 'Start the department check', 'workflow', 'submit', 'CHECK_WF',
       '{"action": "start", "definition": "DEPARTMENT_CHECK", "detail_pk": "&P23_DEPTNO.", "variables": {"DEPTNO": "&P23_DEPTNO."}}'::jsonb,
       'A workflow checks the department on the server: the answer comes as a notification.'
  from meta.page p join meta.app a on a.id = p.app_id where a.alias = 'hr' and p.page_no = 23;

insert into meta.translation (app_id, language, source, target)
select a.id, 'nl', t.source, t.target
  from meta.app a, (values
  ('Check in a workflow', 'Controleren in een workflow'),
  ('A workflow checks the department on the server: the answer comes as a notification.',
   'Een workflow controleert de afdeling op de server: het antwoord komt als melding.')
  ) as t (source, target)
 where a.alias = 'hr'
on conflict do nothing;
