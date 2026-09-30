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
that have waited more than two days (`db/seed/hr_08_automations.sql`):

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

