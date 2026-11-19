-- =====================================================================
-- HR example, part 95: the Global Page (sprint 229, AX-8; APEX: page 0,
-- page type Global Page; docs/guide/04-pages-and-regions.md "The Global
-- Page")
--
-- Page 0 is part of every page of HR. For managers it adds a notice in
-- the banner position: the number of leave requests that wait for a
-- decision (a computation on page 0 counts them into P0_PENDING_LEAVE),
-- a Review button to Leave requests, and Dismiss, two dynamic actions
-- that set P0_LEAVE_NOTICE_SEEN on the server and hide the notice. The
-- notice is not shown on Leave requests (6) and Leave request (7)
-- themselves, nor once dismissed in the session.
-- =====================================================================
insert into meta.page (app_id, page_no, name, title, requires_auth, mode, alias)
select a.id, 0, 'Global Page', 'Global Page', true, 'normal', 'global-page'
  from meta.app a
 where a.alias = 'hr'
   and not exists (select 1 from meta.page p where p.app_id = a.id and p.page_no = 0);

insert into meta.region (page_id, seq, title, type, columns, template, template_options, position, source, authz, condition, static_id)
select p.id, 5, 'Leave requests waiting', 'static', 12, 'standard', '{to-accent,to-compact}', 'banner',
       '<p>&P0_PENDING_LEAVE. leave request(s) wait for a decision.</p>', 'MANAGER',
       $c$coalesce(:P0_PENDING_LEAVE, '0') <> '0' and :P0_LEAVE_NOTICE_SEEN is null and :APP_PAGE_ID not in ('6', '7')$c$,
       'leave-notice'
  from meta.page p join meta.app a on a.id = p.app_id
 where a.alias = 'hr' and p.page_no = 0
   and not exists (select 1 from meta.region x where x.page_id = p.id and x.title = 'Leave requests waiting');

insert into meta.item (page_id, region_id, seq, name, label, type)
select p.id, null, i.seq, i.name, i.label, 'hidden'
  from meta.page p join meta.app a on a.id = p.app_id, (values
  (10, 'P0_PENDING_LEAVE', 'Pending leave requests'),
  (20, 'P0_LEAVE_NOTICE_SEEN', 'Leave notice dismissed')
  ) as i (seq, name, label)
 where a.alias = 'hr' and p.page_no = 0
   and not exists (select 1 from meta.item x where x.page_id = p.id and x.name = i.name);

insert into meta.computation (page_id, seq, item_name, point, type, expression, authz)
select p.id, 10, 'P0_PENDING_LEAVE', 'before_header', 'sql_query',
       $q$select count(*) from hr.leave_request where status = 'PENDING'$q$, 'MANAGER'
  from meta.page p join meta.app a on a.id = p.app_id
 where a.alias = 'hr' and p.page_no = 0
   and not exists (select 1 from meta.computation x where x.page_id = p.id and x.item_name = 'P0_PENDING_LEAVE');

insert into meta.button (page_id, region_id, seq, name, label, action, target_page, hot)
select p.id, r.id, b.seq, b.name, b.label, b.action, b.target, b.hot
  from meta.page p join meta.app a on a.id = p.app_id
  join meta.region r on r.page_id = p.id and r.title = 'Leave requests waiting', (values
  (10, 'P0_REVIEW_LEAVE', 'Review', 'redirect', 6, true),
  (20, 'P0_DISMISS_LEAVE', 'Dismiss', 'da', null::int, false)
  ) as b (seq, name, label, action, target, hot)
 where a.alias = 'hr' and p.page_no = 0
   and not exists (select 1 from meta.button x where x.page_id = p.id and x.name = b.name);

insert into meta.dynamic_action (page_id, seq, name, event, trigger_element, action, code, affected_items, affected_region_id)
select p.id, d.seq, d.name, 'click', 'P0_DISMISS_LEAVE', d.action, d.code, d.items, case when d.action = 'hide' then r.id end
  from meta.page p join meta.app a on a.id = p.app_id
  join meta.region r on r.page_id = p.id and r.title = 'Leave requests waiting', (values
  (10, 'Dismiss the leave notice: remember', 'execute_sql', $q$select 'Y' as p0_leave_notice_seen$q$, 'P0_LEAVE_NOTICE_SEEN'),
  (20, 'Dismiss the leave notice: hide', 'hide', null, null)
  ) as d (seq, name, action, code, items)
 where a.alias = 'hr' and p.page_no = 0
   and not exists (select 1 from meta.dynamic_action x where x.page_id = p.id and x.name = d.name);

insert into meta.translation (app_id, language, source, target)
select a.id, 'nl', t.source, t.target
  from meta.app a, (values
  ('Global Page', 'Globale pagina'),
  ('Leave requests waiting', 'Verlofaanvragen wachten'),
  ('<p>&P0_PENDING_LEAVE. leave request(s) wait for a decision.</p>', '<p>&P0_PENDING_LEAVE. verlofaanvraag/-aanvragen wachten op een besluit.</p>'),
  ('Review', 'Bekijken'),
  ('Dismiss', 'Sluiten')
  ) as t (source, target)
 where a.alias = 'hr'
on conflict do nothing;
