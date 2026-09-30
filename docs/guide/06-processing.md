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
