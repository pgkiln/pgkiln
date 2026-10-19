-- =====================================================================
-- HR example, part 66: Team Development (docs/guide/03-builder.md,
-- "Team Development")
--
-- What Builder → Team Development → Set up installs in the Default
-- workspace (the label groups Type and Priority, milestones 1.0 and 1.1,
-- a bug report template and a canned response), and one issue about the
-- HR application: "Salary rounding on page 12", a Bug of milestone 1.1,
-- assigned to admin. The Page Designer of page 12 shows it, and the
-- Workspace home counts it until it is closed. Issues are workspace data
-- (the workspace export), not part of the HR application's export.
-- =====================================================================

insert into meta.team_label_group (workspace_id, name, description, seq) values
  (1, 'Type', 'What kind of work the issue is.', 10),
  (1, 'Priority', 'How soon it should be done.', 20)
on conflict (workspace_id, lower(name)) do nothing;

insert into meta.team_label (workspace_id, group_id, name, color, description, seq)
select 1, g.id, l.name, l.color, l.description, l.seq
  from (values ('Type', 'Bug', 'red', 'Something does not work as it should.', 10),
               ('Type', 'Feature', 'blue', 'New functionality.', 20),
               ('Type', 'Task', 'teal', 'Work to do that is neither a bug nor a feature.', 30),
               ('Priority', 'High', 'orange', 'Do this first.', 10),
               ('Priority', 'Medium', 'yellow', 'Do this soon.', 20),
               ('Priority', 'Low', 'gray', 'Do this when there is time.', 30)) as l(grp, name, color, description, seq)
  join meta.team_label_group g on g.workspace_id = 1 and g.name = l.grp
on conflict (workspace_id, lower(name)) do nothing;

insert into meta.team_milestone (workspace_id, name, description, due_date) values
  (1, '1.0', 'The first release.', current_date + 30),
  (1, '1.1', 'The first update after the release.', current_date + 90)
on conflict (workspace_id, lower(name)) do nothing;

insert into meta.team_template (workspace_id, kind, name, title, body, labels, seq) values
  (1, 'issue', 'Bug report', 'Bug: ', E'## What happens\n\n\n## What should happen\n\n\n## Steps to reproduce\n\n1. \n2. \n', '{Bug}', 10),
  (1, 'response', 'Thanks, we will look at it', null, 'Thank you for reporting this. We will look at it and keep this issue up to date.', '{}', 10)
on conflict (workspace_id, kind, lower(name)) do nothing;

with issue as (
  insert into meta.team_issue (workspace_id, title, body, milestone_id, app_id, page_no, created_by)
  select 1, 'Salary rounding on page 12',
         E'The leave calendar shows daily salary costs rounded to whole euros; finance expects cents.\n\n'
         E'- Open **page 12** (Leave calendar)\n- Compare a day with the salary in `hr.emp`\n\n@admin can you have a look?',
         (select id from meta.team_milestone where workspace_id = 1 and name = '1.1'),
         a.id, 12, 'admin'
    from meta.app a
   where a.alias = 'hr'
     and not exists (select 1 from meta.team_issue i where i.workspace_id = 1 and i.title = 'Salary rounding on page 12')
  returning id
), labelled as (
  insert into meta.team_issue_label (issue_id, label_id)
  select issue.id, l.id from issue join meta.team_label l on l.workspace_id = 1 and l.name in ('Bug', 'Medium')
), assigned as (
  insert into meta.team_issue_assignee (issue_id, username)
  select issue.id, 'admin' from issue where exists (select 1 from meta.developer where username = 'admin')
)
insert into meta.team_issue_event (issue_id, username, action) select id, 'admin', 'created' from issue;
