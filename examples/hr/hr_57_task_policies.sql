-- =====================================================================
-- HR example, part 57: what happens to overdue tasks, and vacation rules
-- (docs/guide/06-processing.md, approvals)
--
--   - a leave request nobody decided on within its 2 days escalates once to
--     the administrators (role admin), with priority 1; overdue again, it
--     expires;
--   - access requests of the onboarding workflow are renewed twice, then
--     expire (the workflow then ends: its step has no "expired" branch).
-- Managers set a vacation rule on the task list (page 14): while they are
-- away, the user they name decides on their leave requests.
-- =====================================================================

update meta.task_definition d
   set expiration = x.expiration, max_renewals = x.max_renewals, escalate_role = x.escalate_role
  from meta.app a, (values ('LEAVE_APPROVAL', 'escalate', null::int, 'admin'),
                           ('ONBOARD_ACCESS', 'renew', 2, null)) x(name, expiration, max_renewals, escalate_role)
 where a.alias = 'hr' and d.app_id = a.id and d.name = x.name;
