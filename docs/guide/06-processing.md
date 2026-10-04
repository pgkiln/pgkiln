# 6. Buttons, validations, processes and page logic

## Buttons

| Property | Meaning |
|---|---|
| `name` | The **request** (`SAVE`, `CREATE`, `APPROVE`, …); uppercase. Processes and validations can run "when button pressed" |
| `label` | Button text |
| `action` | `submit`: submit the page with this request. `redirect`: go to `target_page` without submitting. `da`: do nothing except trigger [dynamic actions](07-dynamic-actions.md). `document`: download a document template. `menu`: a [menu](#menu-buttons-and-badges) of links and submit requests |
| `target_page` | For `redirect`: where to go. For `submit`: where to go **after** success when no [branch](#branches) applies; empty = stay on the page |
| `target_items` | For `redirect`: items to set on the target page, e.g. `{"P3_ID": "&P2_ID."}` |
| `condition` | SQL expression; the button only exists when it is true |
| `authz` | Authorization scheme |
| `hot` | Primary styling. The first visible hot submit button is also the one **Enter** presses |
| `confirm` | A confirmation question before the action (e.g. "Delete this record?") |
| `region_id`, `seq` | Placement: region header (reports, cards, …), region footer (forms, static) or page bottom |
| `menu` | For `menu`: the entries (JSON), see below |
| `badge`, `badge_query` | A small count or label on the button, see below |
| `build_option` | Only part of the application while the [build option](#build-options) is included |

The **condition and authorization are checked again when the button is pressed**: a request for a
button that isn't visible to this user in this state is refused (403) and logged. So a condition
like `:P3_ID is null` on *Create* really does prevent creating from an existing record.

In a modal dialog, a `redirect` button whose target is not a modal page (typically *Cancel*)
simply closes the dialog.

### Menu buttons and badges

A button with action `menu` opens a dropdown (an HTML `<details>` element, so it works without
JavaScript). `menu` is a JSON array of at most 20 entries; each is either a **link** to a page of
the application or a **submit request**:

```json
[{"label": "Leave requests", "page": 6, "icon": "list"},
 {"label": "Details", "page": 3, "items": {"P3_EMPNO": "&P22_EMPNO."}},
 {"label": "Start over", "request": "RESET", "confirm": "Clear the form?", "authz": "ADMIN"}]
```

| Key | Meaning |
|---|---|
| `label` | The entry's text (1–100 characters) |
| `page`, `items` | A link: the page and the items to set (signed with a checksum, like any link) |
| `request` | A submit: the page is submitted with this request, as if a button of that name was pressed. Validations, processes and branches with `when_button` see it |
| `confirm` | A confirmation question first |
| `authz` | The entry only exists for users who pass this authorization scheme |
| `icon` | An [icon](09-reference.md#icons) name |

A request entry is allowed on submit only when the menu button itself is visible to the user and
the entry's authorization passes; a request that is also the name of a real button on the page
follows that button's condition and authorization instead.

A **badge** is a short value shown on the button (a count of open items, "new", …). `badge` is
text with `&ITEM.` substitutions (an empty result shows no badge); `badge_query` is a SELECT whose
first column of the first row is shown, and wins when both are set. The query runs as the
application's database role with bind variables, like any region source.

## What happens on submit

```
POST ──> CSRF check ──> page authorization ──> "before page" app processes
     ──> visibility (with the state as rendered) ──> button allowed?
     ──> copy posted values of editable items into session state
     ──> computations (after_submit)       ── error ──> roll back, re-show page with message
     ──> validations (not for DELETE)      ── error ──> re-show page with messages (422)
     ──> processes, in sequence            ── error ──> roll back, re-show page with message
     ──> branches (after_processing): the first that applies
     ──> COMMIT ──> success message ──> redirect to the branch's target,
                                        else to the button's target page, else to the page
```

When the page is shown (GET), the order is: `before_header` branches (one that applies redirects
at once), form fetch, `before_header` computations, `load` processes, rendering.

Everything from the first validation to the last process runs in **one transaction**: if a later
process fails, earlier inserts and updates are rolled back too.

## Validations

| `type` | Passes when |
|---|---|
| `not_null` | the associated item has a value |
| `sql` | `expression` (a SQL boolean expression, binds allowed) is true |
| `regex` | the item's value matches `expression` (a POSIX regular expression, checked in Postgres) |

Plus: every **required** editable item must have a value.

| Property | Meaning |
|---|---|
| `item_name` | The message is shown next to this item (otherwise at the top of the page) |
| `message` | The error message |
| `when_button` | Only validate for this request |

Example: commission only for salesmen.

```sql
:P3_COMM is null or :P3_COMM::numeric = 0 or :P3_JOB = 'SALESMAN'
```

Validations in the application are for **usability**. Rules that must always hold belong in the
database (constraints, triggers, functions), where they also protect other access paths. The
two combine well; see error handling below.

## Processes

| `type` | What it does |
|---|---|
| `form_dml` | Insert/update/delete the row of a **form region** (see [forms](04-pages-and-regions.md#form)) |
| `grid_dml` | Save the changes of an **interactive grid** region; runs on the grid's Save button |
| `sql` | Run `code`: one or more SQL statements with bind variables |
| `data_load` | Load the CSV/XLSX file of a file item into a table ([chapter 16](16-files.md#data-loading-in-an-application)) |

| Property | Meaning |
|---|---|
| `point` | `submit` (after validations) or `load` (when the page is shown, after form fetch) |
| `when_button` | Only for this request (empty = every submit with a button) |
| `region_id` | The form or grid region, for `form_dml` / `grid_dml` |
| `config` | Settings of a `data_load` process (JSON) |
| `success_message` | Shown after the redirect; messages of several processes are joined |
| `authz` | Skipped when the user isn't authorized |
| `seq` | Order |

### Calling PL/pgSQL

Keep business logic in database functions and call them from a process:

```sql
select hr.request_leave(:P7_START_DATE::date, :P7_END_DATE::date, :P7_REASON) as p7_id
```

If the last statement returns a row, each column **named like an item** (page item or
application item) sets that item. Here the new request id lands in `P7_ID`. Casting binds
(`::date`, `::int`) selects the right function signature.

Procedures work too (`call my_proc(:P1_X)`), as do several statements separated by `;`. For
`DO` blocks, read items with `meta.v('P1_X')`.

### Error handling

In PL/pgSQL, raise errors with messages written for the end user:

```sql
if p_end < p_start then
  raise exception 'The end date must be on or after the start date.'
    using column = 'end_date';     -- optional: show the message on this field
end if;
```

- The message (SQLSTATE `P0001`) is shown as written, next to the item whose `source_column` (or
  name) matches `column`, or at the top of the page.
- Unique, foreign-key, not-null and check violations get friendly messages.
- Other errors show "An unexpected error occurred (reference #id)"; the details are in the
  **activity monitor** (or on screen in debug mode).

All changes of the submit are rolled back, and the page is shown again with the entered
values so the user can correct them.

## Computations

A computation sets a page item or an application item without a process: a default, a value
looked up by SQL, a derived value.

| Property | Meaning |
|---|---|
| `item_name` | The page item or application item it sets |
| `point` | `before_header`: when the page is shown (after the form fetch, before the `load` processes). `after_submit`: after the posted values are stored, before the validations |
| `type` | How `expression` is read, see below |
| `expression` | The value, item, query, expression or function body |
| `condition_type`, `condition_expr`, `condition_value` | Only when the [condition](#conditions-of-computations-and-branches) holds |
| `authz` | Only for users who pass this authorization scheme |
| `seq` | Order; later computations see the values of earlier ones |

| `type` | `expression` |
|---|---|
| `static` | A value; `&ITEM.` substitutions allowed. An empty result clears the item |
| `item` | The name of another item whose value is copied |
| `sql_query` | A SELECT; the first column of the first row (empty without rows) |
| `sql_expression` | A SQL expression, e.g. `round(:P22_DAYS::numeric)` |
| `function_body` | A PL/pgSQL function body that returns the value: `return upper(:P3_NAME);`, or a whole `declare … begin … end` block |

SQL runs as the application's database role with bind variables, each computation in its own
savepoint. A failing computation before the page is shown leaves the item as it was and shows the
error on the page; after a submit it stops the submit (everything is rolled back) and shows the
error, like a failing process.

## Branches

After a successful submit pgapex redirects (POST-redirect-GET). **Branches** decide where to: the
first branch, in sequence, whose button, authorization and condition match is taken; when none
applies, the pressed button's `target_page`, or back to the same page. In a modal dialog, the
dialog closes instead, and the calling page reloads.

| Property | Meaning |
|---|---|
| `name` | A description, shown in the page designer |
| `point` | `after_processing` (after a submit's processes) or `before_header` (before the page is shown: a redirect instead of the page, e.g. "nothing to do here, go to the list") |
| `when_button` | `after_processing` only: the request (button) it is for; empty = any |
| `target_type` | `page` or `url` |
| `target_page`, `target_items` | A page of the application (empty = this page) and the items to set there, e.g. `{"P7_EMPNO": "&P22_EMPNO."}`; the link is signed with a checksum |
| `target_url` | A path inside the application (after `/a/<alias>/`), e.g. `12?view=month` or `account`; `&ITEM.` values are URL-encoded. Other sites are refused (no scheme, `//`, `\` or `..`) |
| `condition_type`, `condition_expr`, `condition_value` | Only when the [condition](#conditions-of-computations-and-branches) holds |
| `authz`, `seq`, `build_option` | As for other components |

A `before_header` branch to the page itself is skipped (it would loop).

### Conditions of computations and branches

| `condition_type` | Holds when |
|---|---|
| (empty) | always |
| `sql` | `condition_expr`, a boolean SQL expression, is true |
| `exists` / `not_exists` | the query in `condition_expr` returns a row / no row |
| `item_null` / `item_not_null` | the item named in `condition_expr` is empty / has a value |
| `item_equals` / `item_not_equals` | that item's value is / is not `condition_value` |
| `request_in` | the request (the button pressed) is one of `condition_value`, comma separated |

A condition whose SQL fails counts as false and shows the error.

**HR example, page 22 (Leave planner).** Computations fill the employee (yours, when none is
chosen: `sql_query` with condition `item_null`), the name (`function_body`) and the pending
requests before the page is shown, and round the days after a submit (`sql_expression`). Branches:
*Check* with more than 10 days goes to the leave calendar (`sql` condition); *Plan* goes to a new
leave request for the employee (`target_items`); the *More* menu's *Start over* request comes back
to the page with the days cleared (`request_in`).

## Build options

**Shared Components → Build options** are named switches (`include` or `exclude`) for features
that are not ready, or only for some installations. Pages, regions, items, buttons, dynamic
actions, validations, processes, computations, branches, navigation entries and application
processes have a `build_option` property:

| `build_option` | The component is part of the application |
|---|---|
| (empty) | always |
| `NAME` | while the option is included |
| `!NAME` | while the option is excluded (shown as "Not" in the builder) |

An excluded component is left out when the runtime loads the application: it is not rendered, not
run, and not accepted on submit (a page left out answers 404). A name that does not exist leaves
the component out (fail closed); the Advisor reports it. Build options are part of an application
export. On HR page 22, the *Forecast* region needs `LEAVE_FORECAST` (excluded), and *Planner tips*
(`!LEAVE_FORECAST`) takes its place until it is included.

## Application processes

**Shared Components → Application processes** run for the whole application:

| `point` | When |
|---|---|
| `after_login` | Once, right after a successful sign-in |
| `before_page` | Before every page view and every submit |

Their SQL can set **application items** by returning columns named like them. The HR sample
maps the signed-in user to an employee:

```sql
select (select empno from hr.emp where lower(username) = lower(:APP_USER)) as ai_empno,
       coalesce((select initcap(ename) from hr.emp where lower(username) = lower(:APP_USER)), :APP_USER) as ai_ename
```

`&AI_ENAME.` then greets the user on the dashboard.

## Automations

**Shared Components → Automations** run SQL or PL/pgSQL on a schedule, like APEX automations:
nightly clean-ups, reminders, recalculations. The pgapex server schedules them, so no extension is
needed (pg_cron isn't available on every managed PostgreSQL service).

| Setting | |
|---|---|
| Schedule | cron syntax, `minute hour day-of-month month day-of-week`: `0 7 * * 1-5` (07:00 on weekdays), `*/15 * * * *` (every 15 minutes), `0 2 1 * *` (02:00 on the 1st), `30 6 1 jan,jul *`; or `@hourly`, `@daily`, `@weekly`, `@monthly`, `@yearly`. When both day fields are set, either may match, as in cron |
| Time zone | the schedule's time zone, e.g. `Europe/Amsterdam` (daylight saving included) or `UTC` |
| For each row of | optional query: the code then runs once per row, with the row's columns as binds (APEX's query-based automations) |
| Code | one or more SQL statements, a `do $$ … $$` block or `call`. Binds: `:APP_ID`, `:APP_ALIAS`, `:APP_USER` (`automation:<name>`), `:AUTOMATION_NAME` and the row's columns. Binds aren't replaced inside `$$ … $$`: pass them to a function instead |
| Roles | what `meta.has_role()` returns true for while it runs (read at every run) |
| Timeout | the statement timeout of a run (default 300 s) |

A run is **one transaction as the application's database role**, so grants and row level security
apply, and an error rolls the whole run back. The editor shows the next run, a **Run now**
button (it also works while the automation is disabled) and the last runs with their status, row
count and error message; the last 100 runs are kept in `meta.automation_log`.

The HR sample's *Remind managers* runs at 08:00 on weekdays and reminds managers of leave requests
that have waited more than two days (`examples/hr/hr_08_automations.sql`):

```sql
-- For each row of
select id from hr.leave_request
 where status = 'PENDING' and created_at < now() - interval '2 days'
-- Code
select hr.remind_pending_leave(:ID::int);
```

**Running more than one pgapex server?** Every server runs the scheduler (every 30 seconds,
`SCHEDULER_INTERVAL_S`). Due automations are claimed with `FOR UPDATE SKIP LOCKED` and a run holds
an advisory lock, so an automation never runs twice at the same time. Set `AUTOMATIONS=off` on
servers that shouldn't run them. Exported applications include their automations; an imported
copy starts with them **switched off**, so a copy never runs the original's jobs unasked.

If you prefer the database to schedule work, [pg_cron](15-extensions.md) still works next to this.

## Approvals and the task list

Approvals (APEX: Task Definitions, the Approvals component and the Unified Task List) let an
application ask someone to approve, reject or complete something, and act on the answer.

**1. A task definition** (Shared Components → Task definitions) describes one kind of task:

| Field | Meaning |
|---|---|
| Name | `EXPENSE_APPROVAL`; application SQL refers to it by name |
| Type | `approval` (Approve / Reject) or `action` (Complete) |
| Subject | e.g. `Expense claim of &NAME.: &AMOUNT.` — `&KEY.` comes from the task's parameters, `&DETAIL_PK.` is the record key |
| Potential owners (roles) | Users with one of these roles may act on the task (plus the users named when it is created) |
| Business administrator (role) | Sees every task of this definition, delegates and cancels them |
| The person who requested it may complete it | Off by default: nobody approves their own request |
| Priority, Due in | 1 (urgent) – 5 (low); e.g. `2 days`. Overdue tasks are marked |
| Details page, Details item | The subject links to this page, setting the item to the record key |
| On completion (SQL) | Runs as the application's role when the task is approved, rejected or completed (below) |

**2. Application SQL creates tasks**, for example in the process that saves a request or in a
trigger:

```sql
select meta.create_task('EXPENSE_APPROVAL',            -- the definition
                        :P5_ID,                        -- the record it is about (detail_pk)
                        jsonb_build_object('NAME', :P5_NAME, 'AMOUNT', :P5_AMOUNT),
                        array[:P5_MANAGER_USERNAME]);  -- users who may act, besides the roles
```

The signed-in user is the task's initiator.

**3. Users act in a task list**, a region of type **`tasks`**. A task list region shows, depending
on its settings, the tasks waiting for me (to act on, to claim, or assigned to me), the ones I
requested, or the ones I administer, optionally with completed ones. Each task offers what the
user may do:

| Action | Who |
|---|---|
| Approve / Reject / Complete (with an optional comment) | The actual owner, or a potential owner while the task is unassigned |
| Claim | A potential owner, while unassigned: it becomes theirs |
| Release | The actual owner: unassigned again |
| Delegate | The actual owner or an administrator, to any user of the application |
| Cancel | The initiator or an administrator |
| Comment | Everybody who sees the task |

Every step is in the task's history.

**4. On completion**, the definition's SQL runs **as the application's role, in the same
transaction** as the decision, with these binds: `:TASK_ID`, `:DETAIL_PK`, `:OUTCOME`
(`APPROVED`, `REJECTED` or `COMPLETED`), `:COMMENT`, `:APPROVER`, `:INITIATOR`, and the task
parameters by name. An error in it (a business rule, row level security) shows the message and
undoes the decision, so a task is never completed without its effect:

```sql
select expenses.decide(:DETAIL_PK::int, :OUTCOME, :COMMENT)
```

When a record is decided somewhere else (for example with buttons on its own page), close its
open tasks so they don't linger: `select meta.close_tasks('EXPENSE_APPROVAL', :P5_ID::text,
'approved')` (no completion SQL runs).

**SQL API** (application code; `meta.app_user()` is the acting user):

| Function | |
|---|---|
| `meta.create_task(name, detail_pk, params jsonb, owners text[], priority)` | Returns the task id |
| `meta.close_tasks(name, detail_pk, outcome)` | Closes a record's open tasks; returns how many |
| `meta.claim_task(id)`, `meta.release_task(id)`, `meta.delegate_task(id, username)`, `meta.cancel_task(id, comment)`, `meta.add_task_comment(id, text)` | The task list's actions, with the same checks |
| `meta.tasks` | View: the tasks the user may see, with `may_act`, `may_claim`, `may_release`, `may_delegate`, `may_cancel` |
| `meta.task_events` | View: the history and comments of those tasks |

The task tables themselves are closed to the application's role: rights are checked by these
functions and views, for every call. pgapex sends no e-mail; put a task list on the home page, or
use an automation to remind owners of overdue tasks.

**Example:** in the HR sample application, a leave request creates a `LEAVE_APPROVAL` task for the
employee's manager; *My tasks* (page 14) approves or rejects it through `hr.decide_leave`, the same
function as the leave request page's buttons, and a request decided there closes its task.

## Workflows

A workflow (APEX: Workflow) runs a process of several steps that can take days: tasks for people,
SQL, decisions, waits. A **workflow definition** (Shared Components → Workflows) is a list of named
steps; the builder checks them and draws the flow.

| Step type | Does | Fields |
|---|---|---|
| `task` | Creates a task ([task definitions](#approvals-and-the-task-list)) and waits until it is completed or cancelled | `task` (definition name), `owners` (a SELECT returning usernames, optional), `next` (a step, or per outcome: `{"approved": "PAY", "rejected": "END"}`) |
| `sql` | Runs SQL; the columns of the row it returns become variables | `code`, `next` |
| `switch` | Goes to the first case whose condition is true | `cases: [{"when": ":AMOUNT::numeric > 1000", "next": "DIRECTOR"}]`, `otherwise` |
| `wait` | Waits before going on | `for` (`30 minutes`, `2 days`), `next` |
| `parallel` | Starts a branch at each of its steps; they run side by side | `branches` (the first step of each, at least two), `join` |
| `join` | Where the branches of a `parallel` step meet | `wait_for` (`all`, the default, or `any`), `next` |
| `end` | Ends the workflow | |

`next` is optional: the following step in the list (after the last one, the workflow is complete).

```json
[{"name": "CHECK",    "type": "switch", "cases": [{"when": ":AMOUNT::numeric > 1000", "next": "DIRECTOR"}], "otherwise": "MANAGER"},
 {"name": "DIRECTOR", "type": "task", "task": "EXPENSE_APPROVAL", "owners": "select username from staff where role = 'director'",
                      "next": {"approved": "PAY", "rejected": "END"}},
 {"name": "MANAGER",  "type": "task", "task": "EXPENSE_APPROVAL", "owners": "select manager from staff where id = :DETAIL_PK::int",
                      "next": {"approved": "PAY", "rejected": "END"}},
 {"name": "PAY",      "type": "sql", "code": "select expenses.pay(:DETAIL_PK::int) as paid_on"},
 {"name": "END",      "type": "end"}]
```

**Starting one.** Application SQL, typically a page process:

```sql
select meta.start_workflow('EXPENSE', :P5_ID, jsonb_build_object('AMOUNT', :P5_AMOUNT))
```

The variables (upper case) are binds in every step, with `:DETAIL_PK`, `:WORKFLOW_ID` and
`:INITIATOR`; after a task step also `:TASK_OUTCOME` (`APPROVED`, `REJECTED`, `COMPLETED`,
`CANCELLED`) and `:TASK_APPROVER`. The title may use `&VAR.`.

**How it runs.** The pgapex server runs workflows: right after they start or a task of theirs
ends (`NOTIFY`), and it checks for waits that are over every few seconds (`WORKFLOW_INTERVAL_S`,
default 10; `WORKFLOWS=off` on servers that shouldn't run them). Each step runs in its own
transaction **as the application's database role**, with the initiator as `meta.app_user()`, so
grants and row level security apply (`meta.has_role()` is false: there is no session). Several
servers can share a database: each instance is locked while it runs.

A step that fails puts the workflow in **faulted** with the error; an administrator (the
definition's administrator role) fixes the cause and **retries** the step. A task that is
cancelled ends the workflow unless the step has a `cancelled` branch.

**Parallel branches.** A `parallel` step (APEX: parallel activities) starts a branch at each step
in `branches`; every branch runs on its own (its own step, wait and task) until it reaches the
`join` step, while the workflow waits there. With `"wait_for": "all"` the join goes on when every
branch has arrived; with `"any"` when the first one has, and the others are cancelled with their
open tasks. Branches share the variables (a later value wins), and a branch may itself contain a
`parallel` step with its own join.

```json
[{"name": "SPLIT",   "type": "parallel", "branches": ["ORDER", "NOTIFY"], "join": "BOTH"},
 {"name": "ORDER",   "type": "task", "task": "ORDER_LAPTOP", "next": "BOTH"},
 {"name": "NOTIFY",  "type": "sql", "code": "select staff.notify_facilities(:DETAIL_PK::int) as notified_at", "next": "BOTH"},
 {"name": "BOTH",    "type": "join", "wait_for": "all"},
 {"name": "WELCOME", "type": "sql", "code": "select staff.welcome(:DETAIL_PK::int) as welcomed_at"}]
```

The builder checks the structure: every branch reaches its join and stays inside (no step after
the join, no step shared with another branch, no way into the join from outside the branches),
and every join belongs to one `parallel` step. An `end` step inside a branch, or a cancelled task
without a `cancelled` outcome, ends the whole workflow. A failing step faults its branch; the
workflow shows as faulted while the other branches go on, and a retry resumes the failed branch.
The diagram draws branches as dashed arrows and marks every step an instance is at.

**Versions.** A definition has versions (APEX: workflow versions), each **development**,
**active** or **inactive**. New instances start the active version, and there is only one. Running
instances keep the version they started with (and its steps) until they end, so changing a
definition never changes them. The active steps can't be edited: under the definition, **Create
new version** copies them into a development version (the label is optional: the next number),
which the property form then edits; **Activate** makes it the active version (the builder refuses
steps with problems), and the active one becomes inactive. **Discard** throws a development version
away. The Versions table shows each version with its instance count and diagram; the Instances
table shows which version each instance runs and where it is.

**The console.** A region of type **`workflows`** lists the workflows the user started (or, with
`"context": "admin"`, those they administer), with their state, the version, the current steps (several with parallel branches), a diagram
and the history. The initiator and administrators can **terminate** a workflow (its open tasks and
branches are cancelled); administrators can retry a faulted one.

| Function / view | |
|---|---|
| `meta.start_workflow(name, detail_pk, vars jsonb)` | Returns the workflow id |
| `meta.terminate_workflow(id, comment)`, `meta.retry_workflow(id)` | The console's actions, with the same checks |
| `meta.workflows`, `meta.workflow_events` | The workflows the user may see (with `version` and `active_steps`), and their history |
| `meta.new_workflow_version(definition_id, label)`, `meta.activate_workflow_version(definition_id)`, `meta.discard_workflow_version(definition_id)` | Versions, for the owner (the builder; scripts that install an application). Not for applications |

**Example:** the HR example application's employee form starts `ONBOARDING` when an employee is
created. Its version 2 (part 18) prepares the workplace (the manager's task) and, in a parallel
branch, the access that employees with a salary of 2500 or more need (a switch and an
administrator's task); when both branches are done, the manager is notified (SQL). Version 1, which
did this one after the other, is inactive. *My tasks* (page 14) shows the workflows.

