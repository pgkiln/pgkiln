# 7. Dynamic actions

Dynamic actions add behaviour in the browser without writing JavaScript: showing and hiding
fields, filling in values computed by SQL, refreshing a region. They are the one part of pgkiln
that needs JavaScript; without it, pages still work, just without these conveniences. When the
built-in actions are not enough, [Execute JavaScript](#execute-javascript) calls a function of
your own from a static application file.

## Anatomy

| Property | Meaning |
|---|---|
| `event` | When it runs, see [Events](#events) |
| `trigger_element` | What it listens to: item names (`change`, `focus`, `blur`, `key_release`), a button name (`click`), region ids or static ids (`after_refresh`, `selection_change`), dialog page numbers (`dialog_closed`; empty: any dialog) or event names (`custom`), comma separated. Empty for `load` and `before_submit` |
| `condition_type`, `condition_value` | Optional client-side condition on the (first) trigger item's value (for `dialog_closed`: on the dialog's page number): `equals`, `not_equals`, `in_list` (comma-separated values), `is_null`, `is_not_null` |
| `action` | What to do, see below |
| `affected_items`, `affected_region_id` | What it acts on |
| `code` | SQL for server-side actions; the function's name for `execute_javascript` |
| `items_to_submit` | Items whose current browser values are sent to the server first |
| `message` | Text for `alert`, `show_success` and `show_error` |
| `css_classes` | Class names for `add_class` / `remove_class` |
| `config` | A `plugin` action's attribute values: `{"attributes": {"MESSAGE": "Copied."}}` |
| `authz` | Only for authorized users |
| `build_option` | Only while the [build option](06-processing.md#build-options) is included |

## Events

| Event | Runs when | Trigger |
|---|---|---|
| `change` | An item's value changed | Item names |
| `click` | A button was clicked | A button name |
| `load` | The page has loaded | – |
| `dialog_closed` | A modal dialog opened from the page was submitted and closed ([below](#dialog-closed)) | Dialog page numbers (empty: any) |
| `focus` / `blur` | An item gets / loses the focus (APEX: Get Focus, Lose Focus) | Item names |
| `key_release` | A key is released in an item | Item names |
| `after_refresh` | A region was refreshed (`refresh_region`), loaded lazily or shown for another master row | Region ids or static ids |
| `selection_change` | Rows are selected in a report with [row selection](04-pages-and-regions.md#row-selection), or another master row in a grid; the condition sees the selected values, colon separated | Region ids or static ids |
| `before_submit` | The page is about to be submitted; a declined `confirm` keeps the page | – |
| `custom` | JavaScript raised the event: `pgkiln.trigger('ORDER_SAVED', value)` (APEX: custom events, `apex.event.trigger`) | Event names (case-insensitive) |

**The actions of one event and trigger run one after the other, in sequence order** (APEX: the true
actions of a dynamic action), each waiting for the one before (a server action for its answer). A
`confirm` that is declined stops the actions after it, and for `before_submit` the submit too:

| Sequence | Event | Action | Message / items |
|---|---|---|---|
| 10 | `click` on `DELETE_ALL` | `confirm` | *Delete every selected row?* |
| 20 | `click` on `DELETE_ALL` | `execute_sql` | `delete from sales.order_line where id = any(string_to_array(:P5_SELECTED, ':')::int[])` |
| 30 | `click` on `DELETE_ALL` | `refresh_region` | the order lines |

## Actions

| Action | Runs in | Effect |
|---|---|---|
| `show` / `hide` | browser | Show or hide the affected items/region. **With a condition, the opposite happens when the condition is false**, so one dynamic action gives "show commission only for salesmen". Also applied when the page loads (and already on the server, so there's no flicker) |
| `enable` / `disable` | browser | Enable or disable the controls, reversed when the condition is false |
| `set_value` | server | Runs `code` (a SELECT); its first row's columns set the affected items, in order |
| `execute_sql` | server | Runs `code`; returned columns named like items set those items |
| `refresh_region` | server | Re-renders `affected_region_id` with the current session state (e.g. a report filtered by the changed item) |
| `refresh_item` | server | Re-renders the affected items (e.g. a list whose LOV depends on another item) |
| `alert` | browser | Shows `message` |
| `submit` | browser | Submits the page |
| `set_focus` | browser | Puts the cursor in the first affected item (or the first control of the affected region) |
| `add_class` / `remove_class` | browser | Adds or removes `css_classes` (up to five names of lower case letters, digits, `-` and `_`, checked by the database and again in the browser) on the affected items and region. The theme has `is-highlight`, `is-muted`, `is-success` and `is-danger`; your own go in the application's CSS |
| `show_success` | browser | Shows `message` as a success message at the top of the page |
| `show_error` | browser | Shows `message` as an inline error on each affected item, or at the top of the page without affected items |
| `clear_errors` | browser | Removes the error messages of the affected items, or all of them |
| `ai_generate` | server | Runs the [Generate text with AI](06-processing.md#generate-text-with-ai) process named in `code` (a process of type `ai_generate` on the same page, with that process's authorization and condition) and updates its output items, without submitting the page. Items to submit default to the page items its prompts use (never password items); the affected items default to its output items. On a submit button the button waits for the answer; without JavaScript the button submits the page and the process runs as usual |

| `plugin` | browser | Runs the [dynamic action plug-in](04-pages-and-regions.md#plug-ins-with-their-own-code) named in `code`, with `config` `{"attributes": {…}}` (`&ITEM.` filled in); the function gets the same context as *Execute JavaScript* plus `attributes` |
| `execute_javascript` | browser | Calls the function named in `code`, which a [static application file](03-builder.md#static-application-files) registered; see [below](#execute-javascript) |
| `push_subscribe` | browser | Turns on [push notifications](17-mobile.md#push-notifications) on the user's device: the browser asks for permission, then the device is registered. Use it with `click` (browsers ask only after one). `message` is shown when it worked, the browser's reason when not. The app needs push notifications on |
| `confirm` | browser | Asks `message`; **No stops the actions after it** (and the submit, for `before_submit`) |
| `close_dialog` | browser | In a modal page: closes it; the page below refreshes, or runs its `dialog_closed` actions (APEX: Close Dialog) |
| `cancel_dialog` | browser | In a modal page: closes it without refreshing the page below |
| `clear` | browser | Empties the affected items |
| `open_region` / `close_region` | browser | Opens or closes a *collapsible* region; another region is shown or hidden |
| `download` | server | Downloads the file of the [download process](06-processing.md#download) named in `code` (a process of the page, with its authorization and condition), after sending `items_to_submit`; the page stays as it is |
| `print` | browser | The browser's print dialog |
| `current_position` | browser | The device's position as `latitude,longitude` (5 decimals) into the first affected item |
| `share` | browser | The device's share sheet with the page's title, `message` and address; where there is none, the address is copied |

Server-side actions first store `items_to_submit` in session state, run as the application's
database role like everything else, and check the page's and the dynamic action's authorization.
The SQL itself never reaches the browser.

## Ajax callbacks

A page process with point **ajax** (APEX: an On Demand process) runs only when JavaScript calls it by
name, and answers JSON; an application process with point *ajax* can be called from every page (a
page's own process of that name wins). Only processes of type `sql` answer.

```js
// in a static application file
const r = await pgkiln.server.process('ORDER_TOTAL', { items: ['P5_ORDER_ID'], x01: 'EUR' });
r.data.total;   // the first row of the process's last statement
r.rows;         // its rows (at most 1000)
r.items;        // the page and application items it set (also set on the page)
```

```sql
-- the process ORDER_TOTAL (point ajax): :X01 … :X10 are the x01 … x10 sent
select sum(qty * price) as total, :X01 as currency from sales.order_line where order_id = :P5_ORDER_ID::int
```

`items` is a list of item names (their current values are sent) or `{"P5_ID": "7"}`; only items the
user may change are set, as on a submit. The process runs as the application's role with its
authorization, condition and build option; errors come back as `{ "error": "…" }` (the promise
rejects). The request carries the page's CSRF token and needs page access.

## Execute JavaScript

APEX's *Execute JavaScript Code* runs code typed into the action. pgkiln's Content-Security-Policy
allows no inline scripts, so the code lives in a **static application file** instead (Shared
Components → Static application files, [chapter 3](03-builder.md#static-application-files)) and
the action names the function to call:

```js
// hr.js, loaded by every page (Static application files → Every page loads)
pgkiln.actions.register('hr.annualSalary', (da) => {
  const monthly = Number(pgkiln.getValue('P3_SAL')) || 0;
  for (const field of da.elements) field.dataset.annual = String(monthly * 12);
});
```

| event | trigger | action | affected | code |
|---|---|---|---|---|
| `change` | `P3_SAL` | `execute_javascript` | `P3_SAL` | `hr.annualSalary` |

The function gets one argument with the action's context:

| Property | Meaning |
|---|---|
| `value` | The trigger item's value (change events) |
| `items` | The names of the affected items |
| `elements` | The affected items' fields and the affected region, as DOM elements |
| `region` | The affected region's element, or `null` |
| `message` | The action's message |

It may return a promise; an exception is shown as an error message. Besides `actions.register`,
`window.pgkiln` offers `getValue(item)`, `setValue(item, value)`, `showSuccess(message)`,
`showError(message, item?)`, `clearErrors(...items)` and `page` (the page number). A function
registered later than the page loads is still found: the action waits until every deferred script
has run. The name may contain letters, digits, `_`, `$`, `.` and `-`; the page only ever receives
the name, never code. An action whose function is not registered writes a warning to the browser
console and does nothing.

The HR example (part 46) shows the salary per year under the salary field of page 3 this way.

## Examples (from the HR sample)

**Show commission only for salesmen** (page 3):

| event | trigger | condition | action | affected |
|---|---|---|---|---|
| change | `P3_JOB` | equals `SALESMAN` | show | `P3_COMM` |

**Suggest a salary when a job is chosen**:

| event | trigger | action | affected | items to submit |
|---|---|---|---|---|
| change | `P3_JOB` | set_value | `P3_SAL` | `P3_JOB,P3_SAL` |

```sql
select coalesce(:P3_SAL::numeric, hr.suggest_salary(:P3_JOB))
```

**Count working days as dates are picked** (page 7), with two triggers:

| event | trigger | condition | action | affected | items to submit |
|---|---|---|---|---|---|
| change | `P7_START_DATE,P7_END_DATE` | is_not_null | set_value | `P7_DAYS` | `P7_START_DATE,P7_END_DATE` |

```sql
select hr.business_days(:P7_START_DATE::date, :P7_END_DATE::date)
```

**A "Refresh" button for a region**: a button with action `da`, and a dynamic action with
event `click`, trigger the button's name, action `refresh_region`.

**Inline checks without a round trip** (page 22, *Leave planner*):

| event | trigger | condition | action | affected | message / classes |
|---|---|---|---|---|---|
| load | | | set_focus | `P22_DAYS` | |
| change | `P22_DAYS` | equals `0` | show_error | `P22_DAYS` | Zero days is not a leave. |
| change | `P22_DAYS` | not_equals `0` | clear_errors | `P22_DAYS` | |
| click | `HIGHLIGHT` | | add_class | region *Plan your leave* | `is-highlight` |
| click | `HIGHLIGHT` | | show_success | | The form is highlighted. |

These are conveniences: the server still validates on submit.

## Dialog closed

When a modal dialog page is submitted successfully, the dialog closes and the page that opened it
**reloads**. With `dialog_closed` dynamic actions for that dialog, the page runs them instead,
typically `refresh_region` on a report that shows what the dialog changed (APEX: *Dialog Closed*).
The dialog's success message comes along with the first action that goes to the server
(`refresh_region`, `refresh_item`, `set_value`, `execute_sql`) and is shown at the top of the page.
Closing a dialog with its close button (cancel) runs nothing. Without JavaScript there are no
dialogs: the dialog page opens as a normal page and returns to the list after a submit.

**HR example, page 28 (Employee toolkit):** editing a colleague in the *Team* report opens the
employee form (page 3) in a dialog; `dialog_closed` with trigger `3` refreshes the *Team* region.

## Cascading lists without a dynamic action

For the common "list B depends on item A" case, set `cascade_parents` on B instead
([chapter 5](05-items.md#cascading-lists-of-values)).

## Setting a value triggers further changes

A value set by `set_value` fires a `change` event on that item, so chains work (A changes → B is
set → C is refreshed). Chains are limited to 5 levels to prevent loops.
