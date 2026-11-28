-- =====================================================================
-- HR example, part 124: a button grey until the fields it needs are
-- filled in (sprint 264; docs/guide/07-dynamic-actions.md, client-side
-- condition all_not_null and buttons as affected items).
--
-- Page 37 "Leave assistant": Request leave is enabled once First day and
-- Last day have a value (the server still checks the first day).
-- =====================================================================

insert into meta.dynamic_action (page_id, seq, name, event, trigger_element, condition_type, action, affected_items)
select p.id, 900, 'Request leave once both days are filled in', 'change', 'P37_START_DATE,P37_END_DATE', 'all_not_null', 'enable', 'REQUEST'
  from meta.page p join meta.app a on a.id = p.app_id
 where a.alias = 'hr' and p.page_no = 37;
