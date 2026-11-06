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
| `condition_type`, `condition_value` | Optional client-side condition on the (first) trigger item's value (for `dialog_closed`: on the dialog's page number): `equals`, `not_equals`, `greater`, `greater_equal`, `less`, `less_equal` (numbers as numbers, other values such as ISO dates as text; an empty value fails them), `in_list`, `not_in_list` (comma-separated values), `is_null`, `is_not_null`. APEX's *JavaScript expression* isn't offered: the Content-Security-Policy runs no code from strings; use `execute_javascript` with a registered function |
| `server_condition_type`, `server_condition_expr`, `server_condition_value` | A [server-side condition](06-processing.md#server-side-conditions) (sprint 154): when it doesn't hold for this request, the dynamic action isn't on the page at all, e.g. `user_signed_in` or `page_is_dialog` |
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
| `menu_entry` | An entry `{"label": …, "action": "NAME"}` of a [menu button](06-processing.md#menu-buttons-and-badges) was chosen (APEX: Menu entry chosen); the condition sees the entry's name ([below](#menu-entry-chosen)) | Entry names, or menu button names (any of their entries) |
| `double_click` | An item, button or region was double-clicked (sprint 156) | Item names, button names, region ids or static ids |
| `key_down` / `key_press` | A key goes down in an item / a key that types a character (APEX: Key Down, Key Press); a `cancel_event` keeps the key out of the field | Item names |
| `mouse_enter` / `mouse_leave` | The pointer enters / leaves an item, button or region (once per element, not while moving inside it) | Item names, button names, region ids or static ids |
| `select` | Text is selected in an item | Item names |
| `resize` / `scroll` | The window is resized / scrolled (at most once per frame) | – |
| `page_unload` | The page is left (APEX: Page Unload); only quick actions in the browser finish | – |
| `before_refresh` | A region is about to be refreshed by a `refresh_region` action (APEX: Before Refresh); a `cancel_event` or declined `confirm` keeps it as it is | Region ids or static ids |
| `facets_change` | A faceted search or smart filters region's facets were applied (APEX: Facets Change); runs on the page that comes back with the new filters | The facets region's id or static id |
| `grid_row_init` | A row was added to an editable grid by Add row or Duplicate (APEX: Row Initialization [Interactive Grid]); the condition sees the row's number among the new rows | The grid's id or static id |
| `grid_save` | A grid's changes were saved (APEX: Save [Interactive Grid]); runs on the page that comes back | The grid's id or static id |
| `calendar_date_select` | An empty day or hour of a calendar was clicked (APEX: Date Select); the condition sees `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM`; a `cancel_event` keeps the Create link closed | The calendar's id or static id |
| `calendar_view_change` | A calendar showed another view or period (APEX: View Change); the condition sees `month`, `week`, `day` or `list` | The calendar's id or static id |
| `map_object_click` | A marker or shape of a map was clicked (APEX: Map Object Clicked); the condition sees the row's `id` column, else its title | The map's id or static id |
| `map_change` | A map was moved or zoomed by the user (APEX: Map Changed); the condition sees the zoom level | The map's id or static id |
| `timer` | (sprint 165) Every so many seconds while the page is open and its tab is visible, e.g. `refresh_region` of a report of open orders | A number of seconds, 5 to 3600 |
| `tree_selection_change` | A tree node was clicked (APEX: Selection Change [Tree]); the condition sees its `id`, the node is marked; a `cancel_event` keeps its link closed | The tree's id or static id |

**The actions of one event and trigger run one after the other, in sequence order** (APEX: the true
actions of a dynamic action), each waiting for the one before (a server action for its answer). A
`confirm` that is declined stops the actions after it, and for `before_submit` the submit too:

| Sequence | Event | Action | Message / items |
|---|---|---|---|
| 10 | `click` on `DELETE_ALL` | `confirm` | *Delete every selected row?* |
| 20 | `click` on `DELETE_ALL` | `execute_sql` | `delete from sales.order_line where id = any(string_to_array(:P5_SELECTED, ':')::int[])` |
| 30 | `click` on `DELETE_ALL` | `refresh_region` | the order lines |

### Component events

The last seven events above belong to a component region (sprint 161): the trigger is that region's
id or static id. Their value (the date, view, node id, map object id or zoom level) is what the
client-side condition compares, and an [Execute JavaScript](#execute-javascript) function gets it as
`value`, with the component's element (the grid row, calendar cell, map or tree node) as `element`.
Two of them can be cancelled: a `cancel_event` whose condition holds keeps the calendar's Create
link or the tree node's link closed, wherever it stands in the sequence; like every `cancel_event`
it also stops the actions after it, so put it last.

A **`set_value` without SQL** on a component event puts the event's value into its affected
items, in the browser. A tree of departments that filters an employee report, without JavaScript:

| Sequence | Event | Action | Affected / items to submit |
|---|---|---|---|
| 10 | `tree_selection_change` on the departments tree | `set_value` (no SQL) | `P5_DEPTNO` |
| 20 | `tree_selection_change` on the departments tree | `refresh_region` | the employees report; items to submit `P5_DEPTNO` |
| 30 | `tree_selection_change` on the departments tree | `cancel_event` | – (last, as it stops the actions after it; the node's link stays closed) |

## Actions

| Action | Runs in | Effect |
|---|---|---|
| `show` / `hide` | browser | Show or hide the affected items/region. **With a condition, the opposite happens when the condition is false**, so one dynamic action gives "show commission only for salesmen". Also applied when the page loads (and already on the server, so there's no flicker) |
| `enable` / `disable` | browser | Enable or disable the controls, reversed when the condition is false |
| `set_value` | server | Runs `code` (a SELECT); its first row's columns set the affected items, in order. The affected items must be on the page: a `hidden` item isn't rendered (its value stays on the server, safe from tampering), so set a text or display item, or use a computation |
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
| `wait_popup` | browser | Shows a modal "please wait" popup with `message` (default *Please wait…*) until `remove_wait_popup` or the next page (APEX: Show Wait Popup); [below](#wait-popup) |
| `remove_wait_popup` | browser | Removes the wait popup (APEX: Remove Wait Popup) |
| `cancel_event` | browser | Stops the actions after it, and the event's own effect: a button doesn't submit or follow its link, a typed key (`key_down`, `key_press`) stays out of the field, a refresh doesn't happen (APEX: Cancel Event). Sprint 156 |
| `set_style` | browser | Sets CSS properties on the affected items (their field: input, select list or text area; (sprint 166) before, the item's wrapper) or region: `{"styles": {"color": "#b42318", "font-weight": "bold"}}` in the attributes (APEX: Set Style). Properties from a fixed list (colours, font, text, border, opacity, visibility, padding, margin, width); values without `url()` or `var()`, checked when saved and again before they reach the page |
| `collapse_tree` / `expand_tree` | browser | Closes / opens every node of the affected tree region (APEX: Collapse Tree, Expand Tree) |
| `show_ai_assistant` | browser | Opens the affected AI assistant region (or the inline dialog it sits in) and puts the cursor in its question (APEX: Show AI Assistant) |
| `trigger_geocoding` | browser | The affected geocoded address item looks its text up, as its *Check address* button does (APEX: Trigger Geocoding); (sprint 166) not when its text is the address just chosen from the list, so a `change` action on the address item itself doesn't reopen it |
| `open_report_dialog` | browser | Opens a dialog of the affected interactive report: `code` is `filter`, `columns`, `sort`, `highlight`, `compute`, `aggregate`, `chart`, `group`, `pivot`, `break`, `rows` or `saved` (APEX: Invoke Interactive Report Dialog) |

Server-side actions first store `items_to_submit` in session state, run as the application's
database role like everything else, and check the page's and the dynamic action's authorization.
The SQL itself never reaches the browser.

## Wait popup

`wait_popup` covers the page with a small dialog (a spinner and `message`) while something slow
runs, so the user doesn't click twice; `remove_wait_popup` takes it away. Because the actions of
one event run in sequence, each waiting for the one before, two patterns cover most cases:

| Sequence | Event | Action | |
|---|---|---|---|
| 10 | `click` on `RECALC` (a submit button) | `wait_popup` | *Recalculating…*: the popup stays until the next page arrives |
| 10 | `click` on `CHECK` | `wait_popup` | *Checking…* |
| 20 | `click` on `CHECK` | `execute_sql` | the Ajax call (also `set_value`, `refresh_region`, `download`, a plug-in) |
| 30 | `click` on `CHECK` | `remove_wait_popup` | |

`before_submit` → `wait_popup` shows it for every submit of the page. A submit the browser refuses
(a required field is empty) removes it again, and so does going back to the page in the browser.
The popup is a modal `<dialog>`: the page below can't be clicked or focused, Escape doesn't close
it, its text is a status message that screen readers read out, and the page's `<main>` is
`aria-busy` while it shows. It follows the theme (light and dark) and needs no inline styles or
scripts. From JavaScript: `const done = pgkiln.waitPopup('Saving…'); … done();` (or
`pgkiln.removeWaitPopup()`).

## Menu entry chosen

A [menu button](06-processing.md#menu-buttons-and-badges)'s entry can run dynamic actions instead
of linking or submitting: `{"label": "Export", "action": "EXPORT"}`. Dynamic actions with event
`menu_entry` and trigger `EXPORT` run when it is chosen (the menu closes first); a trigger with the
menu button's name runs for every action entry of that menu, and a client-side condition tests the
entry's name (`equals` `EXPORT`). Without JavaScript such an entry does nothing, like a button with
action `da`. The HR example's page 47 has an *Actions* menu whose *Count employees* entry shows a
wait popup around an Ajax call.

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
| `element` | A [component event](#component-events)'s element (grid row, calendar cell, map, tree node), else `null` |

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
