-- =====================================================================
-- HR example, part 64: an AI agent with tools (sprint 111;
-- docs/guide/03-builder.md, "AI agents"; APEX 26.1: AI Agents)
--
-- Shared Components → AI Agents:
--   - Tools:
--       top_earners    (sql)        employees by salary, highest first,
--                                   optionally of one department: a query
--                                   run as hr_app (row level security
--                                   applies) in a read-only transaction
--       open_employee  (navigate)   a link to the employee form (page 3)
--                                   with P3_EMPNO: pgkiln offers it only
--                                   to users who may open page 3
--                                   (MANAGER) and builds the checksum
--       give_raise     (function)   hr.give_raise(p_empno, p_pct): changes
--                                   data, only offered to managers
--       note           (javascript) shows a message in the browser after
--                                   the answer (the custom event
--                                   "hr_agent_note" on page 46)
--   - Agent HR_AGENT: the AI service HR_ASSISTANT, a system prompt, low
--     reasoning effort, the four tools, at most 4 steps per question.
--
-- Page 46 "HR agent": an AI assistant region that names the agent. Ask
-- e.g. "Who in Sales earns most?": the agent calls top_earners and offers
-- "Open BLAKE's record", a link to page 3 with a valid checksum.
--
-- Like parts 41 and 42 the example creates no AI service: an administrator
-- adds one named HR_ASSISTANT under App Builder → Workspace utilities → AI
-- services (Claude, OpenAI, Gemini or an OpenAI-compatible endpoint) and
-- allows the HR application to use it.
-- =====================================================================

update meta.app set
  ai_tools = $j$[
    {"name": "top_earners", "type": "sql",
     "description": "Active employees with their job, department and salary, highest salary first; optionally only one department (case-insensitive name, e.g. SALES).",
     "sql": "select empno, ename, job, dname, sal from hr.staff_v where active and (:DNAME is null or dname ilike :DNAME) order by sal desc, ename",
     "parameters": {"DNAME": {"type": "string", "optional": true, "description": "A department name, e.g. SALES."}},
     "max_rows": 20, "timeout_s": 10},
    {"name": "open_employee", "type": "navigate",
     "description": "Offer the user a link to an employee's record (the employee form). Use the employee number (empno) as P3_EMPNO and a label such as \"Open BLAKE's record\".",
     "pages": [3]},
    {"name": "give_raise", "type": "function",
     "description": "Raise an employee's salary by a percentage. Only when the user clearly asks for it; repeat the employee and the percentage first.",
     "function": "hr.give_raise",
     "parameters": {"P_EMPNO": {"type": "integer", "description": "The employee number (empno)."},
                    "P_PCT": {"type": "number", "description": "The raise in percent, e.g. 5."}},
     "authz": "MANAGER"},
    {"name": "note", "type": "javascript", "action": "hr_agent_note",
     "description": "Show the user a short confirmation message in the page, e.g. after a raise.",
     "parameters": {"TEXT": {"type": "string", "description": "The message."}}}
  ]$j$::jsonb,
  ai_agents = $j$[
    {"name": "HR_AGENT", "description": "Answers questions about salaries and opens employee records",
     "service": "HR_ASSISTANT",
     "system": "You are the HR agent of a small company, talking with &APP_USER.. Answer questions about employees, departments and salaries with the top_earners tool. When you name one employee, offer a link to their record with open_employee (the empno as P3_EMPNO). Be brief.",
     "effort": "low", "tools": ["top_earners", "open_employee", "give_raise", "note"], "max_steps": 4, "max_tokens": 2000}
  ]$j$::jsonb
 where alias = 'hr';

insert into meta.page (app_id, page_no, name, title, parent_page)
select id, 46, 'HR agent', 'HR agent', 1 from meta.app where alias = 'hr';

insert into meta.region (page_id, seq, title, type, columns, template, source, condition, config)
select p.id, r.seq, r.title, r.type, r.cols, 'standard', r.source, r.cond, r.config::jsonb
  from meta.page p join meta.app a on a.id = p.app_id, (values
  (10, 'No AI service yet', 'static', 12,
   '<p class="alert alert-info">No AI service is configured for this application yet. An administrator adds an AI service named <b>HR_ASSISTANT</b> under <i>App Builder → Workspace utilities → AI services</i> and allows the HR application to use it.</p>',
   'not meta.ai_available(''HR_ASSISTANT'')', '{}'),
  (20, 'Ask the HR agent', 'ai_assistant', 8, null, 'meta.ai_available(''HR_ASSISTANT'')',
   $j${"agent": "HR_AGENT",
       "welcome": "Hello! Ask me who earns what, e.g. who in Sales earns most. I can open an employee's record for you.",
       "placeholder": "e.g. Who in Sales earns most?",
       "max_turns": 20,
       "error_message": "The HR agent could not answer just now. Please try again later."}$j$)
  ) as r (seq, title, type, cols, source, cond, config)
 where a.alias = 'hr' and p.page_no = 46;

-- the javascript tool "note": a custom event the agent raises after its answer
insert into meta.dynamic_action (page_id, seq, name, event, trigger_element, action, message)
select p.id, 10, 'Agent note', 'custom', 'hr_agent_note', 'show_success', 'The HR agent did what you asked.'
  from meta.page p join meta.app a on a.id = p.app_id where a.alias = 'hr' and p.page_no = 46;

insert into meta.nav_entry (app_id, seq, label, icon, target_page)
select id, 30, 'HR agent', 'users', 46 from meta.app where alias = 'hr';

insert into meta.translation (app_id, language, source, target)
select a.id, 'nl', t.source, t.target
  from meta.app a, (values
  ('HR agent', 'HR-agent'),
  ('Ask the HR agent', 'Vraag het de HR-agent'),
  ('Hello! Ask me who earns what, e.g. who in Sales earns most. I can open an employee''s record for you.',
   'Hallo! Vraag me wie wat verdient, bijv. wie in Sales het meest verdient. Ik kan ook de gegevens van een medewerker voor je openen.'),
  ('e.g. Who in Sales earns most?', 'bijv. Wie verdient het meest in Sales?')
  ) as t (source, target)
 where a.alias = 'hr'
on conflict do nothing;
