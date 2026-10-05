-- =====================================================================
-- HR example, part 41: Generate text with AI (docs/guide/05-items-and-logic.md,
-- "Generate text with AI")
--
-- Page 37 "Leave assistant": paste an employee's message about leave.
--   - "Summarise" writes a one or two sentence summary for the manager
--     (a "Generate text with AI" process, text into P37_SUMMARY);
--   - "Fill in the request" reads the dates and the reason from the
--     message into P37_START_DATE, P37_END_DATE and P37_REASON (a
--     structured output: pgapex builds a strict JSON schema from the items);
--   - "Request leave" then files the leave request with hr.request_leave.
-- With JavaScript both AI buttons run through a dynamic action (AJAX, no
-- page submit); without it they submit the page and the processes run.
--
-- The example creates no AI service: an administrator adds one named
-- HR_ASSISTANT (Claude or OpenAI, with an API key, or the server's
-- ANTHROPIC_API_KEY / OPENAI_API_KEY) under App Builder → Workspace
-- utilities → AI services and allows the HR application to use it. Until
-- then the page says so (meta.ai_available) and hides the AI buttons.
-- The message is sent to the provider of that service.
-- =====================================================================

insert into meta.page (app_id, page_no, name, title, parent_page)
select id, 37, 'Leave assistant', 'Leave assistant', 1 from meta.app where alias = 'hr';

insert into meta.region (page_id, seq, title, type, columns, template, source, condition)
select p.id, r.seq, r.title, 'static', 12, r.template, r.source, r.cond
  from meta.page p join meta.app a on a.id = p.app_id, (values
  (10, 'No AI service yet', 'standard',
   '<p class="alert alert-info">No AI service is configured for this application yet. An administrator adds an AI service named <b>HR_ASSISTANT</b> (Claude or OpenAI, with an API key) under <i>App Builder → Workspace utilities → AI services</i> and allows the HR application to use it.</p>',
   'not meta.ai_available(''HR_ASSISTANT'')'),
  (20, 'Leave message', 'standard',
   '<p>Paste a message in which an employee asks for leave. <b>Summarise</b> writes a short summary for the manager; <b>Fill in the request</b> reads the dates and the reason from it. The message is sent to the AI service HR_ASSISTANT (its provider: Claude or OpenAI); check the answer before you use it.</p>',
   null),
  (30, 'Leave request', 'standard',
   '<p>Check the dates and the reason, then file the request in your name.</p>',
   null)
  ) as r (seq, title, template, source, cond)
 where a.alias = 'hr' and p.page_no = 37;

insert into meta.item (page_id, region_id, seq, name, label, type, help)
select p.id, r.id, i.seq, i.name, i.label, i.type, i.help
  from (values
  (10, 'Leave message', 'P37_MESSAGE', 'Message', 'textarea', 'For example: "Hi, I would like to take the week of 16 November off to help my parents move house. Thanks, Ann"'),
  (20, 'Leave message', 'P37_SUMMARY', 'Summary', 'textarea', 'Written by the AI service: check it.'),
  (30, 'Leave message', 'P37_TODAY', 'Today', 'hidden', null),
  (40, 'Leave request', 'P37_START_DATE', 'First day', 'date', null),
  (50, 'Leave request', 'P37_END_DATE', 'Last day', 'date', null),
  (60, 'Leave request', 'P37_REASON', 'Reason', 'text', null)
  ) as i (seq, region, name, label, type, help)
  join meta.page p on p.page_no = 37 join meta.app a on a.id = p.app_id and a.alias = 'hr'
  join meta.region r on r.page_id = p.id and r.title = i.region;

-- the model needs today's date to read "next Monday"
insert into meta.computation (page_id, seq, item_name, point, type, expression)
select p.id, 10, 'P37_TODAY', 'before_header', 'sql_query', $q$select to_char(current_date, 'YYYY-MM-DD (FMDay)')$q$
  from meta.page p join meta.app a on a.id = p.app_id where a.alias = 'hr' and p.page_no = 37;

insert into meta.button (page_id, region_id, seq, name, label, action, hot, condition)
select p.id, r.id, b.seq, b.name, b.label, 'submit', b.hot, b.cond
  from (values
  (10, 'Leave message', 'SUMMARISE', 'Summarise', false, 'meta.ai_available(''HR_ASSISTANT'')'),
  (20, 'Leave message', 'READ', 'Fill in the request', true, 'meta.ai_available(''HR_ASSISTANT'')'),
  (30, 'Leave request', 'REQUEST', 'Request leave', false, null)
  ) as b (seq, region, name, label, hot, cond)
  join meta.page p on p.page_no = 37 join meta.app a on a.id = p.app_id and a.alias = 'hr'
  join meta.region r on r.page_id = p.id and r.title = b.region;

insert into meta.process (page_id, seq, name, type, point, code, config, when_button, success_message)
select p.id, x.seq, x.name, x.type, 'submit', x.code, x.config::jsonb, x.btn, x.message
  from (values
  (10, 'Summarise', 'ai_generate', null,
   $j${"service": "HR_ASSISTANT",
       "system": "You help an HR department. Summarise the employee's message about leave for their manager in one or two plain sentences: who, when and why. Do not add anything the message does not say.",
       "prompt": "&P37_MESSAGE.",
       "output_item": "P37_SUMMARY",
       "max_tokens": 1000}$j$, 'SUMMARISE', 'Summary written: check it before you use it.'),
  (20, 'Fill in the request', 'ai_generate', null,
   $j${"service": "HR_ASSISTANT",
       "system": "You read leave requests for an HR department. Today is &P37_TODAY.. Give the first and the last day of the leave the employee asks for, and the reason in a few words.",
       "prompt": "&P37_MESSAGE.",
       "output_items": ["P37_START_DATE", "P37_END_DATE", "P37_REASON"],
       "max_tokens": 1000}$j$, 'READ', 'Dates and reason filled in: check them, then choose Request leave.'),
  (30, 'Request leave', 'sql',
   'select hr.request_leave(:P37_START_DATE::date, :P37_END_DATE::date, :P37_REASON)', '{}', 'REQUEST', 'Leave request submitted; your manager has been notified.')
  ) as x (seq, name, type, code, config, btn, message)
  join meta.page p on p.page_no = 37 join meta.app a on a.id = p.app_id and a.alias = 'hr';

-- with JavaScript: the AI processes run without a page submit
insert into meta.dynamic_action (page_id, seq, name, event, trigger_element, action, code)
select p.id, d.seq, d.name, 'click', d.btn, 'ai_generate', d.process
  from (values
  (10, 'Summarise without submit', 'SUMMARISE', 'Summarise'),
  (20, 'Fill in without submit', 'READ', 'Fill in the request')
  ) as d (seq, name, btn, process)
  join meta.page p on p.page_no = 37 join meta.app a on a.id = p.app_id and a.alias = 'hr';

insert into meta.nav_entry (app_id, seq, label, icon, target_page)
select id, 29, 'Leave assistant', 'bolt', 37 from meta.app where alias = 'hr';

insert into meta.translation (app_id, language, source, target)
select a.id, 'nl', t.source, t.target
  from meta.app a, (values
  ('Leave assistant', 'Verlofassistent'),
  ('No AI service yet', 'Nog geen AI-dienst'),
  ('Leave message', 'Verlofbericht'),
  ('Leave request', 'Verlofaanvraag'),
  ('Message', 'Bericht'),
  ('Summary', 'Samenvatting'),
  ('First day', 'Eerste dag'),
  ('Last day', 'Laatste dag'),
  ('Reason', 'Reden'),
  ('Summarise', 'Samenvatten'),
  ('Fill in the request', 'Aanvraag invullen'),
  ('Request leave', 'Verlof aanvragen')
  ) as t (source, target)
 where a.alias = 'hr'
on conflict do nothing;
