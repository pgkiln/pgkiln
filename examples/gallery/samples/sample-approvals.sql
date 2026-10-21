-- =====================================================================
-- Sample app "Sample Approvals" (App Gallery → Sample Apps)
--
-- Approvals, the task list and a workflow on purchase requests:
--   * a request is made on a form; creating it starts the PURCHASE workflow
--   * below 1,000 the workflow approves it by itself (an SQL step)
--   * from 1,000 it asks for approval: a PURCHASE_APPROVAL task for the
--     users with the role approver, decided under My tasks; the task's
--     action records the decision on the request
--   * the console lists the workflows with their diagram and history
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
begin
  update sample_approvals.purchase
     set status = case lower(p_outcome) when 'approved' then 'APPROVED' when 'rejected' then 'REJECTED' else status end,
         decided_by = coalesce(p_by, meta.app_user()), note = nullif(p_note, '')
   where id = p_id and status = 'PENDING';
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
insert into meta.app (alias, name, home_page, authentication, db_role)
values ('sample-approvals', 'Sample Approvals', 1, 'app_users', 'app_sample_approvals');

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

insert into meta.nav_entry (app_id, seq, label, icon, target_page)
select a.id, n.seq, n.label, n.icon, n.page
  from meta.app a, (values (10, 'Home', 'home', 1), (20, 'Purchases', 'list', 2), (30, 'My tasks', 'check', 4), (40, 'Workflows', 'route', 5)) as n (seq, label, icon, page)
 where a.alias = 'sample-approvals';

insert into meta.list (app_id, name, type, description)
select id, 'APPROVAL_TOPICS', 'static', 'The pages of Sample Approvals' from meta.app where alias = 'sample-approvals';

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
   '<p>Signed in as <strong>demo</strong>, ask for a purchase under <em>Purchases</em>. Below 1,000 the workflow approves it at once; from 1,000 it creates an approval task for the role <code>approver</code>. Sign in as <strong>approver</strong> / approver and decide under <em>My tasks</em>: the task''s action writes the decision on the request, and the workflow ends.</p>',
   '{"icon": "check"}'),
  (1, 20, 'Topics', 'list', 'plain', null, '{"list": "APPROVAL_TOPICS", "template": "cards"}'),
  (2, 5, 'About this page', 'static', 'plain',
   '<p class="lead">The form''s Create button runs the wizard''s row process, then <code>select meta.start_workflow(''PURCHASE'', :P3_ID, …)</code>. A trigger fills in who asked and the status from the session, so the form can''t set them.</p>', '{}'),
  (4, 5, 'About this page', 'static', 'plain',
   '<p class="lead">Regions of type <code>tasks</code>: what waits for the signed-in user (as owner, here the role <code>approver</code>), and what they asked for. Approve and Reject run the task definition''s action with <code>:DETAIL_PK</code>, <code>:OUTCOME</code> and <code>:COMMENT</code>.</p>', '{}'),
  (4, 10, 'Waiting for me', 'tasks', 'standard', null, '{"empty": "Nothing waits for you. Sign in as approver to decide on requests of 1,000 or more."}'),
  (4, 20, 'Requested by me', 'tasks', 'collapsible', null, '{"context": "initiated", "completed": true, "empty": "You have not asked for anything that needs approval."}'),
  (5, 5, 'About this page', 'static', 'plain',
   '<p class="lead">A region of type <code>workflows</code>: the workflows the user started, or with <code>"context": "admin"</code> those they administer (here: approver). Open one for its diagram, current step and history; the initiator and administrators can terminate it.</p>', '{}'),
  (5, 10, 'Workflows I started', 'workflows', 'standard', null, '{"completed": true}'),
  (5, 20, 'All purchase workflows (approvers)', 'workflows', 'collapsible', null, '{"context": "admin", "completed": true}')
  ) as r (page, seq, title, type, template, source, config);
