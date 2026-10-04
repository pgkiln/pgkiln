# 7. Dynamic actions

Dynamic actions add behaviour in the browser without writing JavaScript: showing and hiding
fields, filling in values computed by SQL, refreshing a region. They are the one part of pgapex
that needs JavaScript; without it, pages still work, just without these conveniences.

## Anatomy

| Property | Meaning |
|---|---|
| `event` | `change` (an item's value changed), `click` (a button was clicked) or `load` (the page loaded) |
| `trigger_element` | For `change`: one or more item names, comma separated. For `click`: a button name |
| `condition_type`, `condition_value` | Optional client-side condition on the (first) trigger item's value: `equals`, `not_equals`, `in_list` (comma-separated values), `is_null`, `is_not_null` |
| `action` | What to do, see below |
| `affected_items`, `affected_region_id` | What it acts on |
| `code` | SQL for server-side actions |
| `items_to_submit` | Items whose current browser values are sent to the server first |
| `message` | Text for `alert`, `show_success` and `show_error` |
| `css_classes` | Class names for `add_class` / `remove_class` |
| `authz` | Only for authorized users |
| `build_option` | Only while the [build option](06-processing.md#build-options) is included |

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

Server-side actions first store `items_to_submit` in session state, run as the application's
database role like everything else, and check the page's and the dynamic action's authorization.
The SQL itself never reaches the browser.

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

## Cascading lists without a dynamic action

For the common "list B depends on item A" case, set `cascade_parents` on B instead
([chapter 5](05-items.md#cascading-lists-of-values)).

## Setting a value triggers further changes

A value set by `set_value` fires a `change` event on that item, so chains work (A changes → B is
set → C is refreshed). Chains are limited to 5 levels to prevent loops.
