-- =====================================================================
-- HR example, part 74: an application's Utilities (sprint 138, AP-5;
-- migration 138; docs/guide/03-builder.md "Utilities")
--
-- UI defaults (App Builder → Utilities → UI defaults, or Workspace
-- utilities → UI defaults) for hr.leave_request: the page wizards and the
-- Create Application wizard label its "days" column "Working days" and
-- show it with a number format mask, and a generated form item for
-- "reason" gets a help text. Pages that exist already don't change: create
-- a form on hr.leave_request (Create Page → Form) to see them.
--
-- The rest of the Utilities page needs no example data: Database object
-- dependencies, Change history (recorded from the next change on),
-- Upgrade application and the application checksum work on the HR
-- application as it is.
-- =====================================================================

insert into meta.ui_default (schema_name, table_name, column_name, label, format_mask, help, alignment, updated_by)
values
  ('hr', 'leave_request', 'days', 'Working days', '990', 'Working days the leave takes, without weekends and public holidays.', 'end', 'admin'),
  ('hr', 'leave_request', 'reason', null, null, 'Optional: what the leave is for. Your manager sees it when deciding.', null, 'admin')
on conflict (schema_name, table_name, column_name) do nothing;
