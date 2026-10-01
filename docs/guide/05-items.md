# 5. Items

An **item** is a named session-state variable, usually shown as a form field. Items live on a
page, optionally inside a region. Name them `P<page>_<NAME>` (uppercase letters, digits and
`_`); refer to them as `:P3_ENAME` in SQL and `&P3_ENAME.` in HTML.

## Item types

| Type | Renders as | Stored value |
|---|---|---|
| `text` | text field | text |
| `textarea` | multi-line text (always full width) | text |
| `number` | number field (numeric keyboard on phones) | e.g. `1250.50` |
| `date` | date picker | `YYYY-MM-DD` |
| `datetime` | date-time picker | `YYYY-MM-DDTHH:MM` |
| `email`, `tel`, `url` | typed fields with the matching phone keyboard | text |
| `password` | password field; never shown back, empty = unchanged | text |
| `color` | colour picker | `#rrggbb` |
| `select` | select list | the chosen return value |
| `popup_lov` | select list with a search box above it | the chosen return value |
| `radio` | radio group | the chosen return value |
| `checkbox` | a single checkbox | `true` / `false` |
| `switch` | on/off switch | `true` / `false` |
| `checkbox_group` | several checkboxes | **colon-separated** return values, e.g. `10:30` |
| `multiselect` | multi-select list | **colon-separated** return values |
| `display` | read-only text (shows the display value for list items) | whatever was set |
| `hidden` | not rendered | set by URL (with checksum), fetch or processes |
| `file` | file upload ([chapter 16](16-files.md)); on phones the camera with `{"capture": "environment"}`, photos made smaller with `{"max_px": 1600}` ([chapter 17](17-mobile.md)) | the id of the uploaded temporary file (a uuid) |
| `location` | a text field with *Use my location* ([chapter 17](17-mobile.md)) | `latitude,longitude`, e.g. `52.01160,4.35710` |

Use multi-value items in SQL with `string_to_array`:

```sql
select * from hr.emp where deptno::text = any (string_to_array(:P11_DEPTS, ':'))
```

`true`/`false` values cast directly to boolean (`:P3_ACTIVE::boolean`).

## Properties

| Property | Meaning |
|---|---|
| `label` | Field label (default: the name in title case) |
| `region_id` | The region the item is shown in (empty = page level, above the regions) |
| `seq` | Order within its region |
| `source_column` | For **form** regions: the table column it maps to |
| `default_value` | Shown when the item has no value |
| `required` | Must have a value on submit ("Salary is required."); marked with `*` |
| `help` | Help text under the field |
| `lov` | List of values for select/radio/checkbox group/multi-select/popup/display items |
| `readonly_condition` | SQL expression; when true the item is shown read-only and ignored on submit |
| `authz` | Authorization scheme; unauthorized users don't see the item and can't set it |
| `config` | Attributes, see below |

Attributes (`config`):

| Key | Meaning |
|---|---|
| `submit_on_change` | `true`: submit the page when the value changes (typical for report filters) |
| `null_label` | Text of the empty option in select lists (default `- Select -`); `false` removes the empty option |
| `cascade_parents` | Comma-separated items this list depends on, see [cascading lists](#cascading-lists-of-values) |
| `wide` | `true`: take the full width of the form |
| `rows` | Number of lines of a textarea (default 4) |

## Lists of values

A list of values (LOV) provides the options of select lists, radio groups, checkbox groups,
multi-selects, popup LOVs, grid columns and display items. Three forms:

1. **A SELECT returning (display, return)**. Bind variables are allowed:
   ```sql
   select dname, deptno from hr.dept order by 1
   ```
   A single-column SELECT uses the same value for both.
2. **A static list**: `STATIC:Display;Return,Other;OTHER`. For example
   `STATIC:Low;LOW,Normal;NORMAL,High;HIGH`. An entry without `;` uses the same value for both.
3. **A shared list of values**: `LOV:DEPARTMENTS`, defined once under
   **Shared Components → Lists of values** and reusable in any item or grid column.

## Cascading lists of values

A list that depends on another item, for example managers filtered by department:

1. Write the child's LOV using the parent item:
   ```sql
   select ename, empno from hr.emp
    where :P3_DEPTNO is null or deptno = :P3_DEPTNO::int
    order by 1
   ```
2. Set the child's attribute `{"cascade_parents": "P3_DEPTNO"}`.

When the parent changes, the browser sends the parent's value and the server re-renders the
child's options (and clears its old value). Chains (A → B → C) work.

## Read-only items

`readonly_condition` is a SQL expression evaluated on every page view, e.g. "dates can't be
changed once the request exists":

```sql
:P7_ID is not null
```

A read-only item is shown as text (list items show their display value) and is **never** taken
from the submitted form. If the condition raises an error, the item is treated as read-only (fail
closed).

## Setting item values

Items get their values from:

- the user (editable items, on submit);
- the URL: `/a/hr/3?P3_EMPNO=7839&cs=…` sets items of page 3 (after clearing that page's items).
  Links that pgapex generates (report links, buttons, cards, calendars, `meta.page_url()`) carry
  the checksum `cs` automatically;
- **form fetch** (form regions);
- **processes** and **dynamic actions** whose SQL returns columns named like items:
  ```sql
  select hr.give_raise(:P3_EMPNO::int, 10) as p3_sal
  ```
- **application processes** (application items).

Values persist in session state until changed. `?clear=1` in a URL clears the page's items.
