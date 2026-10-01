# 6. Buttons, validations and processes

## Buttons

| Property | Meaning |
|---|---|
| `name` | The **request** (`SAVE`, `CREATE`, `APPROVE`, …); uppercase. Processes and validations can run "when button pressed" |
| `label` | Button text |
| `action` | `submit`: submit the page with this request. `redirect`: go to `target_page` without submitting. `da`: do nothing except trigger [dynamic actions](07-dynamic-actions.md) |
| `target_page` | For `redirect`: where to go. For `submit`: where to go **after** success (the *branch*); empty = stay on the page |
| `target_items` | For `redirect`: items to set on the target page, e.g. `{"P3_ID": "&P2_ID."}` |
| `condition` | SQL expression; the button only exists when it is true |
| `authz` | Authorization scheme |
| `hot` | Primary styling. The first visible hot submit button is also the one **Enter** presses |
| `confirm` | A confirmation question before the action (e.g. "Delete this record?") |
| `region_id`, `seq` | Placement: region header (reports, cards, …), region footer (forms, static) or page bottom |

The **condition and authorization are checked again when the button is pressed**: a request for a
button that isn't visible to this user in this state is refused (403) and logged. So a condition
like `:P3_ID is null` on *Create* really does prevent creating from an existing record.

In a modal dialog, a `redirect` button whose target is not a modal page (typically *Cancel*)
simply closes the dialog.

## What happens on submit

```
POST ──> CSRF check ──> page authorization ──> "before page" app processes
     ──> visibility (with the state as rendered) ──> button allowed?
     ──> copy posted values of editable items into session state
     ──> validations (not for DELETE)      ── error ──> re-show page with messages (422)
     ──> processes, in sequence            ── error ──> roll back, re-show page with message
     ──> COMMIT ──> success message ──> redirect to the button's target page
```

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

## Branches

After a successful submit pgapex redirects (POST-redirect-GET) to the pressed button's
`target_page`, or back to the same page. In a modal dialog, the dialog closes instead, and the
calling page reloads. Conditional branches are not supported yet; use separate buttons or a
process that sets an item and a page that reacts to it.

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

