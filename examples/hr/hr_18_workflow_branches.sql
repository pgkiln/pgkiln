-- =====================================================================
-- HR example, part 18: parallel branches and versions of a workflow (docs/guide/06-processing.md)
--
-- ONBOARDING (part 11) gets a version 2: the manager prepares the workplace WHILE the
-- administrator gives access (for a salary of 2500 or more), instead of one after the other.
--   SPLIT   parallel: the branches PREPARE and IT run side by side
--   PREPARE the manager prepares the workplace (a task)        ─┐
--   IT      a salary of 2500 or more needs access …             │ branches
--   ACCESS  … which an administrator gives (a task)            ─┘
--   READY   join: goes on when both branches are done
--   WELCOME the manager gets a notification (SQL)
-- A cancelled PREPARE task ends the onboarding (it has no "cancelled" outcome); a cancelled
-- ACCESS task doesn't (its "next" is for every outcome): access can be given later.
-- Version 1 stays in the definition's history; onboardings that were already running finish
-- with version 1. Shared Components → Workflows → ONBOARDING shows both versions.
-- =====================================================================
select meta.new_workflow_version(d.id, '2')
  from meta.workflow_definition d join meta.app a on a.id = d.app_id
 where a.alias = 'hr' and d.name = 'ONBOARDING';

update meta.workflow_definition d
   set dev_steps = $s$[
  {"name": "SPLIT", "type": "parallel", "branches": ["PREPARE", "IT"], "join": "READY"},
  {"name": "IT", "type": "switch", "cases": [{"when": ":SAL::numeric >= 2500", "next": "ACCESS"}], "otherwise": "READY"},
  {"name": "ACCESS", "type": "task", "task": "ONBOARD_ACCESS", "next": "READY"},
  {"name": "PREPARE", "type": "task", "task": "ONBOARD_PREPARE", "next": {"completed": "READY"},
   "owners": "select m.username from hr.emp e join hr.emp m on m.empno = e.mgr where e.empno = :DETAIL_PK::int and m.username is not null"},
  {"name": "READY", "type": "join", "wait_for": "all"},
  {"name": "WELCOME", "type": "sql", "code": "select hr.onboarding_done(:DETAIL_PK::int) as welcomed_at"},
  {"name": "END", "type": "end"}
]$s$::jsonb,
       description = 'From a new employee record to a prepared workplace; the workplace and access are arranged in parallel.'
  from meta.app a
 where a.id = d.app_id and a.alias = 'hr' and d.name = 'ONBOARDING';

select meta.activate_workflow_version(d.id)
  from meta.workflow_definition d join meta.app a on a.id = d.app_id
 where a.alias = 'hr' and d.name = 'ONBOARDING';
