-- =====================================================================
-- HR example, part 113: back to the calling page, a dialog that sends
-- the page below elsewhere, item values in button labels (sprint 249,
-- MG-22, MG-23, MG-27; migration 205; docs/guide/06-processing.md
-- "Branches", 04-pages-and-regions.md "Modal dialog pages",
-- 06-processing.md "Buttons" (label)).
--
-- Employees (page 2) and Departments (page 4) get a button "Find an
-- employee" that opens page 76, a modal dialog with a select list.
--   - "Open the profile" closes the dialog and sends the page below to
--     Employee profiles (page 51) with that employee: the branch is
--     "In the page below" (in_page_below), so P51_EMPNO goes along with
--     its checksum, as for any page branch.
--   - Page 51 has a button "Back to page &APP_PREVIOUS_PAGE.": its label
--     shows the page the user came from (button labels take &ITEM.
--     substitutions), and its branch has target type "item" with the item
--     APP_PREVIOUS_PAGE: one branch goes back to Employees or Departments,
--     whichever opened the dialog, as that page was (its search and report
--     page). The button shows only when there is a previous page.
-- =====================================================================

insert into meta.page (app_id, page_no, name, title, parent_page, mode)
select id, 76, 'Find an employee', 'Find an employee', 2, 'modal' from meta.app where alias = 'hr';

insert into meta.region (page_id, seq, title, type, columns, template, source, static_id)
select p.id, 10, 'Employee', 'static', 12, 'plain',
       '<p>Choose an employee: <b>Open the profile</b> closes this dialog and shows the profile in the page below.</p>', 'find-employee'
  from meta.page p join meta.app a on a.id = p.app_id
 where a.alias = 'hr' and p.page_no = 76;

insert into meta.item (page_id, region_id, seq, name, label, type, lov, required, placeholder)
select p.id, r.id, 10, 'P76_EMPNO', 'Employee', 'select',
       'select initcap(ename) as d, empno as r from hr.emp where active order by ename', true, 'Choose an employee'
  from meta.page p join meta.app a on a.id = p.app_id join meta.region r on r.page_id = p.id and r.static_id = 'find-employee'
 where a.alias = 'hr' and p.page_no = 76;

insert into meta.button (page_id, region_id, seq, name, label, action, target_page, hot)
select p.id, r.id, b.seq, b.name, b.label, b.action, b.target, b.hot
  from meta.page p join meta.app a on a.id = p.app_id join meta.region r on r.page_id = p.id and r.static_id = 'find-employee',
       (values (10, 'CANCEL', 'Cancel', 'redirect', 2, false),
               (20, 'OPEN', 'Open the profile', 'submit', null, true)) as b (seq, name, label, action, target, hot)
 where a.alias = 'hr' and p.page_no = 76;

-- (MG-23) the dialog closes and the page below goes to page 51 with the employee (signed)
insert into meta.branch (page_id, seq, name, point, when_button, target_type, target_page, target_items, in_page_below)
select p.id, 10, 'To the profile, in the page below', 'after_processing', 'OPEN', 'page', 51, '{"P51_EMPNO": "&P76_EMPNO."}', true
  from meta.page p join meta.app a on a.id = p.app_id
 where a.alias = 'hr' and p.page_no = 76;

-- the dialog opens from Employees and from Departments
insert into meta.button (page_id, region_id, seq, name, label, action, target_page)
select p.id, (select r.id from meta.region r where r.page_id = p.id and r.title = x.region), 50, 'FIND', 'Find an employee', 'redirect', 76
  from meta.page p join meta.app a on a.id = p.app_id
  join (values (2, 'Employees'), (4, 'Departments')) as x (page_no, region) on x.page_no = p.page_no
 where a.alias = 'hr';

-- (MG-22, MG-27) back to the page the user came from; the label names it
insert into meta.button (page_id, region_id, seq, name, label, action, condition)
select p.id, (select r.id from meta.region r where r.page_id = p.id and r.title = 'Employees'), 90, 'BACK', 'Back to page &APP_PREVIOUS_PAGE.', 'submit',
       ':APP_PREVIOUS_PAGE is not null'
  from meta.page p join meta.app a on a.id = p.app_id
 where a.alias = 'hr' and p.page_no = 51;

insert into meta.branch (page_id, seq, name, point, when_button, target_type, target_item)
select p.id, 10, 'Back to the calling page', 'after_processing', 'BACK', 'item', 'APP_PREVIOUS_PAGE'
  from meta.page p join meta.app a on a.id = p.app_id
 where a.alias = 'hr' and p.page_no = 51;
