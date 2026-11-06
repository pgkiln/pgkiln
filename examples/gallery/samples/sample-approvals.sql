-- =====================================================================
-- Sample app "Sample Approvals" (App Gallery → Sample Apps)
--
-- Approvals, the task list and a workflow on purchase requests:
--   * a request is made on a form; creating it starts the PURCHASE workflow
--   * below 1,000 the workflow approves it by itself (an SQL step)
--   * from 1,000 it asks for approval: a PURCHASE_APPROVAL task for the
--     users with the role approver, decided under My tasks; the task's
--     action records the decision on the request
--   * the console lists the workflows with their diagram and history; the
--     request's form draws its workflow (a workflow_diagram region)
--   * on the request's form the approver claims or releases the task, and
--     who asked can ask again after a rejection (the declarative process
--     types human_task_manage and human_task_create)
--   * the notification bell: a request of 1,000 or more notifies the
--     approver (a send_notification process), a decision notifies who asked
--     (meta.notify in the decision); opening one goes to the request
--   * the navigation menu is a list whose entries have badges from SQL
--     (your pending requests, the tasks waiting for you), refreshed every
--     15 seconds by the live badges; a timer dynamic action refreshes
--     "Waiting for me"
--
-- Two accounts: demo / demo asks, approver / approver decides (nobody
-- approves their own request).
--
-- Installed by an administrator from the App Gallery, or with
--   psql "$DATABASE_URL" -1 -f examples/gallery/samples/sample-approvals.sql
-- then open /a/sample-approvals and sign in as demo / demo.
-- =====================================================================

create or replace function pg_temp.page_id(p_alias text, p_page int) returns int language sql stable as
  $$ select p.id from meta.page p join meta.app a on a.id = p.app_id where a.alias = p_alias and p.page_no = p_page $$;

-- 1. Schema and data ---------------------------------------------------------
create schema sample_approvals;

create table sample_approvals.purchase (
  id           int generated always as identity primary key,
  title        text not null,
  supplier     text,
  amount       numeric(10, 2) not null check (amount > 0),
  status       text not null default 'PENDING' check (status in ('PENDING', 'APPROVED', 'REJECTED')),
  requested_by text,
  requested_at timestamptz not null default now(),
  decided_by   text,
  note         text
);

-- who asked, and that a new request is pending, come from the session, not the form
create function sample_approvals.purchase_defaults() returns trigger language plpgsql as $$
begin
  new.requested_by := coalesce(meta.app_user(), current_user);
  new.status := 'PENDING';
  new.decided_by := null;
  return new;
end
$$;
create trigger purchase_defaults before insert on sample_approvals.purchase
  for each row execute function sample_approvals.purchase_defaults();

-- the decision, from the approval task's action (by the approver) or the workflow's SQL step
-- (which runs as the user who started the workflow, so it says who decided: 'workflow')
create function sample_approvals.decide(p_id int, p_outcome text, p_note text, p_by text default null) returns void language plpgsql as $$
declare
  p sample_approvals.purchase;
begin
  update sample_approvals.purchase
     set status = case lower(p_outcome) when 'approved' then 'APPROVED' when 'rejected' then 'REJECTED' else status end,
         decided_by = coalesce(p_by, meta.app_user()), note = nullif(p_note, '')
   where id = p_id and status = 'PENDING'
  returning * into p;
  -- the bell of who asked: the decision, opening the request (page 3); a notification
  -- that can't be added (notifications turned off) never stops the decision
  if p.status in ('APPROVED', 'REJECTED') and p.requested_by is not null and meta.app_id() is not null then
    begin
      perform meta.notify(p.requested_by, format('Purchase %s: %s', lower(p.status), p.title),
                          coalesce(p.note, format('Decided by %s', p.decided_by)),
                          3, jsonb_build_object('P3_ID', p.id), case p.status when 'APPROVED' then 'check' else 'x' end);
    exception when others then
      raise warning 'sample_approvals.decide: no notification: %', sqlerrm;
    end;
  end if;
end
$$;

insert into sample_approvals.purchase (title, supplier, amount) values
  ('Printer toner', 'Office Supplies Ltd', 89.50), ('Standing desks (4)', 'ErgoWorks', 2400.00), ('Team lunch', 'De Kantine', 160.00);
update sample_approvals.purchase set status = 'APPROVED', requested_by = 'demo', decided_by = 'workflow', note = 'Below 1,000: approved automatically' where title in ('Printer toner', 'Team lunch');
update sample_approvals.purchase set status = 'APPROVED', requested_by = 'demo', decided_by = 'approver', note = 'Within the budget' where title = 'Standing desks (4)';

-- 2. The application's database role ----------------------------------------
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'app_sample_approvals') then create role app_sample_approvals nologin; end if;
end $$;
grant app_sample_approvals to pgkiln_runtime;
grant usage on schema sample_approvals to app_sample_approvals;
grant select, insert, update, delete on sample_approvals.purchase to app_sample_approvals;
grant execute on function sample_approvals.decide(int, text, text, text) to app_sample_approvals;

-- 3. The application ----------------------------------------------------------
insert into meta.app (alias, name, home_page, authentication, db_role, notifications, live_badges_s, nav_list)
values ('sample-approvals', 'Sample Approvals', 1, 'app_users', 'app_sample_approvals', true, 15, 'APPROVAL_MENU');

insert into meta.app_user (app_id, username, password_hash, roles)
select a.id, u.name, meta.hash_password(u.name), u.roles
  from meta.app a, (values ('demo', '{}'::text[]), ('approver', '{approver}'::text[])) as u (name, roles)
 where a.alias = 'sample-approvals';

insert into meta.task_definition (app_id, name, type, subject, owner_roles, admin_role, priority, due_in, details_page, details_item, action_code)
select id, 'PURCHASE_APPROVAL', 'approval', 'Purchase: &TITLE. (&AMOUNT.)', '{approver}'::text[], 'approver', 2, '3 days', 3, 'P3_ID',
       'select sample_approvals.decide(:DETAIL_PK::int, :OUTCOME, :COMMENT)'
  from meta.app where alias = 'sample-approvals';

insert into meta.workflow_definition (app_id, name, title, description, admin_role, steps)
select id, 'PURCHASE', 'Purchase: &TITLE.', 'A purchase request: approved by itself below 1,000, otherwise by an approver.', 'approver',
$s$[
  {"name": "AMOUNT_CHECK", "type": "switch", "cases": [{"when": ":AMOUNT::numeric >= 1000", "next": "APPROVE"}], "otherwise": "AUTO_APPROVE"},
  {"name": "AUTO_APPROVE", "type": "sql", "code": "select sample_approvals.decide(:DETAIL_PK::int, 'approved', 'Below 1,000: approved automatically', 'workflow')", "next": "END"},
  {"name": "APPROVE", "type": "task", "task": "PURCHASE_APPROVAL"},
  {"name": "END", "type": "end"}
]$s$::jsonb
  from meta.app where alias = 'sample-approvals';

insert into meta.page (app_id, page_no, name, title, parent_page)
select a.id, p.no, p.name, p.name, p.parent
  from meta.app a, (values (1, 'Sample Approvals', null), (4, 'My tasks', 1), (5, 'Workflows', 1)) as p (no, name, parent)
 where a.alias = 'sample-approvals';

-- page 2 and its form, page 3: the Report and form wizard on the requests
select meta.generate_page('sample-approvals', 'report_form', 'sample_approvals.purchase', 2, '{"label": "Purchases", "form_page": 3, "nav": false}');
update meta.page set parent_page = 1 where app_id = (select id from meta.app where alias = 'sample-approvals') and page_no = 2;
update meta.region set source = 'select id, title, supplier, amount, status, requested_by, decided_by, note from sample_approvals.purchase order by id desc',
       config = config || '{"formats": {"amount": "999G999G990D00"}}'
 where page_id = pg_temp.page_id('sample-approvals', 2) and type = 'report';
-- the form asks only what the requester decides; the rest is shown, not edited
update meta.item set type = 'display'
 where page_id = pg_temp.page_id('sample-approvals', 3) and name in ('P3_STATUS', 'P3_REQUESTED_BY', 'P3_REQUESTED_AT', 'P3_DECIDED_BY', 'P3_NOTE');

-- creating a request starts the workflow, after the row is inserted (P3_ID is then known)
insert into meta.process (page_id, seq, name, type, code, when_button)
select pg_temp.page_id('sample-approvals', 3), 15, 'Start the approval', 'sql',
       $c$select meta.start_workflow('PURCHASE', :P3_ID, jsonb_build_object('TITLE', :P3_TITLE, 'AMOUNT', :P3_AMOUNT))$c$, 'CREATE';

-- from 1,000 the approver gets a notification on the bell (the declarative process type
-- send_notification; an application with several approvers would call meta.notify for each)
insert into meta.process (page_id, seq, name, type, when_button, condition_type, condition_expr, config)
select pg_temp.page_id('sample-approvals', 3), 16, 'Tell the approver', 'send_notification', 'CREATE',
       'sql', ':P3_AMOUNT::numeric >= 1000',
       '{"to": "approver", "title": "Purchase to approve: &P3_TITLE.", "body": "&P3_AMOUNT. from &P3_SUPPLIER., asked by &APP_USER.", "page": 4, "icon": "check"}'::jsonb;

insert into meta.list (app_id, name, type, description)
select id, l.name, 'static', l.description from meta.app, (values
  ('APPROVAL_TOPICS', 'The pages of Sample Approvals'),
  ('APPROVAL_MENU', 'The navigation menu, with badges from SQL')) as l (name, description)
 where alias = 'sample-approvals';

-- the navigation menu (app.nav_list): badges from SQL, refreshed by the live badges
insert into meta.list_entry (app_id, list_name, seq, label, icon, target_page, badge_query)
select a.id, 'APPROVAL_MENU', e.seq, e.label, e.icon, e.page, e.badge_query
  from meta.app a, (values
  (10, 'Home', 'home', 1, null),
  (20, 'Purchases', 'list', 2, 'select nullif(count(*), 0) from sample_approvals.purchase where status = ''PENDING'' and requested_by = meta.app_user()'),
  (30, 'My tasks', 'check', 4, 'select nullif(count(*), 0) from meta.tasks where app_id = meta.app_id() and may_act and state in (''unassigned'', ''assigned'')'),
  (40, 'Workflows', 'route', 5, null)
  ) as e (seq, label, icon, page, badge_query)
 where a.alias = 'sample-approvals';

insert into meta.list_entry (app_id, list_name, seq, label, icon, target_page, description)
select a.id, 'APPROVAL_TOPICS', e.seq, e.label, e.icon, e.page, e.description
  from meta.app a, (values
  (10, 'Purchases', 'list', 2, 'Ask for a purchase: creating it starts the PURCHASE workflow.'),
  (20, 'My tasks', 'check', 4, 'Approve or reject what waits for you, and follow what you asked for.'),
  (30, 'Workflows', 'route', 5, 'The workflows you started, with their diagram, current step and history.')
  ) as e (seq, label, icon, page, description)
 where a.alias = 'sample-approvals';

insert into meta.region (page_id, seq, title, type, columns, template, source, config)
select pg_temp.page_id('sample-approvals', r.page), r.seq, r.title, r.type, 12, r.template, r.source, r.config::jsonb
  from (values
  (1, 10, 'Sample Approvals', 'static', 'hero',
   '<p>Signed in as <strong>demo</strong>, ask for a purchase under <em>Purchases</em>. Below 1,000 the workflow approves it at once; from 1,000 it creates an approval task for the role <code>approver</code>. Sign in as <strong>approver</strong> / approver and decide under <em>My tasks</em>: the task''s action writes the decision on the request, and the workflow ends.</p><p>The bell in the header shows notifications: the approver gets one for each request of 1,000 or more (a <code>send_notification</code> process), and who asked gets the decision (<code>meta.notify</code>). The menu''s badges come from SQL and refresh every 15 seconds without a reload: keep both accounts open in two browsers and watch them change.</p>',
   '{"icon": "check"}'),
  (1, 20, 'Topics', 'list', 'plain', null, '{"list": "APPROVAL_TOPICS", "template": "cards"}'),
  (2, 5, 'About this page', 'static', 'plain',
   '<p class="lead">The form''s Create button runs the wizard''s row process, then <code>select meta.start_workflow(''PURCHASE'', :P3_ID, …)</code>. A trigger fills in who asked and the status from the session, so the form can''t set them.</p><p>Open a request: below the form a <code>workflow_diagram</code> region draws its workflow, the steps it went through and where it is now. While its approval task is open, the approver gets <strong>Claim task</strong> (and then <strong>Release task</strong>): processes of type <code>human_task_manage</code>. After a rejection, who asked gets <strong>Ask again</strong>: the request, changed or not, is pending again and a process of type <code>human_task_create</code> creates a new <code>PURCHASE_APPROVAL</code> task, outside the workflow, which has ended.</p>', '{}'),
  (4, 5, 'About this page', 'static', 'plain',
   '<p class="lead">Regions of type <code>tasks</code>: what waits for the signed-in user (as owner, here the role <code>approver</code>), and what they asked for. Approve and Reject run the task definition''s action with <code>:DETAIL_PK</code>, <code>:OUTCOME</code> and <code>:COMMENT</code>.</p>', '{}'),
  (4, 10, 'Waiting for me', 'tasks', 'standard', null, '{"empty": "Nothing waits for you. Sign in as approver to decide on requests of 1,000 or more."}'),
  (4, 20, 'Requested by me', 'tasks', 'collapsible', null, '{"context": "initiated", "completed": true, "empty": "You have not asked for anything that needs approval."}'),
  (5, 5, 'About this page', 'static', 'plain',
   '<p class="lead">A region of type <code>workflows</code>: the workflows the user started, or with <code>"context": "admin"</code> those they administer (here: approver). Open one for its diagram, current step and history; the initiator and administrators can terminate it.</p>', '{}'),
  (5, 10, 'Workflows I started', 'workflows', 'standard', null, '{"completed": true}'),
  (5, 20, 'All purchase workflows (approvers)', 'workflows', 'collapsible', null, '{"context": "admin", "completed": true}')
  ) as r (page, seq, title, type, template, source, config);

-- a timer dynamic action: "Waiting for me" refreshes every 30 seconds while the page is visible
insert into meta.dynamic_action (page_id, seq, name, event, trigger_element, action, affected_region_id)
select pg_temp.page_id('sample-approvals', 4), 10, 'Refresh what waits', 'timer', '30', 'refresh_region', r.id
  from meta.region r where r.page_id = pg_temp.page_id('sample-approvals', 4) and r.title = 'Waiting for me';

-- page 3, the request's form (also the task's details page): its open approval task and its workflow,
-- computed when the page is shown
insert into meta.item (page_id, region_id, seq, name, type)
select r.page_id, r.id, i.seq, i.name, 'hidden'
  from meta.region r, (values (200, 'P3_TASK_ID'), (210, 'P3_WORKFLOW_ID')) as i (seq, name)
 where r.page_id = pg_temp.page_id('sample-approvals', 3) and r.type = 'form';

insert into meta.computation (page_id, seq, item_name, point, type, expression)
values
  (pg_temp.page_id('sample-approvals', 3), 10, 'P3_TASK_ID', 'before_header', 'sql_query',
   $q$select id::text from meta.tasks where app_id = meta.app_id() and definition = 'PURCHASE_APPROVAL' and detail_pk = :P3_ID and state in ('unassigned', 'assigned') order by id desc limit 1$q$),
  (pg_temp.page_id('sample-approvals', 3), 20, 'P3_WORKFLOW_ID', 'before_header', 'sql_query',
   $q$select id::text from meta.workflows where app_id = meta.app_id() and name = 'PURCHASE' and detail_pk = :P3_ID order by id desc limit 1$q$);

-- the workflow of the request: a Workflow Diagram region (shown to who started it and its administrators)
insert into meta.region (page_id, seq, title, type, columns, template, config, condition_type, condition)
values (pg_temp.page_id('sample-approvals', 3), 20, 'Its workflow', 'workflow_diagram', 12, 'standard',
        '{"instance_item": "P3_WORKFLOW_ID", "empty": "You can''t see this request''s workflow: only who asked and the approvers can."}',
        'item_not_null', 'P3_WORKFLOW_ID');

-- the open task: Claim (a potential owner, while nobody has it) and Release (its owner);
-- after a rejection who asked can Ask again: the request (as changed on the form) pending again, and a new approval task
insert into meta.button (page_id, region_id, seq, name, label, action, condition_type, condition)
select r.page_id, r.id, b.seq, b.name, b.label, 'submit', 'exists', b.cond
  from meta.region r, (values
  (50, 'CLAIM', 'Claim task', $c$select 1 from meta.tasks where id = nullif(:P3_TASK_ID, '')::bigint and may_claim$c$),
  (60, 'RELEASE', 'Release task', $c$select 1 from meta.tasks where id = nullif(:P3_TASK_ID, '')::bigint and may_release$c$),
  (70, 'ASK_AGAIN', 'Ask again', $c$select 1 from sample_approvals.purchase where id = :P3_ID::int and status = 'REJECTED' and requested_by = meta.app_user()$c$)
  ) as b (seq, name, label, cond)
 where r.page_id = pg_temp.page_id('sample-approvals', 3) and r.type = 'form';

insert into meta.process (page_id, seq, name, type, code, when_button, config, success_message)
values
  (pg_temp.page_id('sample-approvals', 3), 30, 'Claim the task', 'human_task_manage', null, 'CLAIM',
   '{"action": "claim", "task": "&P3_TASK_ID."}', 'The task is yours: approve or reject it under My tasks.'),
  (pg_temp.page_id('sample-approvals', 3), 40, 'Release the task', 'human_task_manage', null, 'RELEASE',
   '{"action": "release", "task": "&P3_TASK_ID.", "comment": "Released from the request''s page"}', 'The task is back with every approver.'),
  (pg_temp.page_id('sample-approvals', 3), 50, 'Pending again', 'sql',
   $c$update sample_approvals.purchase
   set title = :P3_TITLE, supplier = :P3_SUPPLIER, amount = :P3_AMOUNT::numeric, status = 'PENDING', decided_by = null, note = null
 where id = :P3_ID::int and status = 'REJECTED' and requested_by = meta.app_user()$c$, 'ASK_AGAIN', '{}', null),
  (pg_temp.page_id('sample-approvals', 3), 51, 'Ask for approval again', 'human_task_create', null, 'ASK_AGAIN',
   '{"definition": "PURCHASE_APPROVAL", "detail_pk": "&P3_ID.", "parameters": {"TITLE": "&P3_TITLE.", "AMOUNT": "&P3_AMOUNT."}, "id_item": "P3_TASK_ID"}',
   'Asked again: the approvers have a new task.');
