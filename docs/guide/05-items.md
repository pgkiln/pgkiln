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
| `popup_lov` | a field and a search button that opens a dialog searching the list of values on the server ([Popup LOV](#popup-lov)) | the chosen return value |
| `radio` | radio group | the chosen return value |
| `checkbox` | a single checkbox | `true` / `false` |
| `switch` | on/off switch | `true` / `false` |
| `checkbox_group` | several checkboxes | **colon-separated** return values, e.g. `10:30` |
| `multiselect` | multi-select list | **colon-separated** return values |
| `display` | read-only text (shows the display value for list items) | whatever was set |
| `hidden` | not rendered | set by URL (with checksum), fetch or processes |
| `file` | file upload ([chapter 16](16-files.md)); on phones the camera with `{"capture": "environment"}`, photos made smaller with `{"max_px": 1600}` ([chapter 17](17-mobile.md)) | the id of the uploaded temporary file (a uuid) |
| `location` | a text field with *Use my location* ([chapter 17](17-mobile.md)) | `latitude,longitude`, e.g. `52.01160,4.35710` |
| `richtext` | rich text editor (toolbar; a plain HTML textarea without JavaScript), full width | **sanitised HTML**, see [below](#rich-text-and-markdown) |
| `markdown` | Markdown textarea with a toolbar; shown formatted when read-only | the Markdown text |
| `rating` | star rating (radio buttons drawn as stars) | `1` … `max` (default 5) |
| `combobox` | free text with suggestions from the list of values; several values become tags | **colon-separated** values, e.g. `SQL:Sales` |
| `daterange` | two date pickers, *From* and *To* | `from:to`, e.g. `2026-01-01:2026-06-30` |
| `qrcode` | display only: the value as a QR code (SVG drawn on the server) | whatever was set |
| `plugin` | an [item plug-in](04-pages-and-regions.md#plug-ins-with-their-own-code): a text field its JavaScript enhances; `config`: `{"plugin": "char_counter", "attributes": {"MAX": "140"}}` | text |

Use multi-value items in SQL with `string_to_array`:

```sql
select * from hr.emp where deptno::text = any (string_to_array(:P11_DEPTS, ':'))
```

`true`/`false` values cast directly to boolean (`:P3_ACTIVE::boolean`). A date range splits the
same way (either date may be empty unless the item is required):

```sql
where hiredate between nullif(split_part(:P20_PERIOD, ':', 1), '')::date
                   and coalesce(nullif(split_part(:P20_PERIOD, ':', 2), '')::date, 'infinity')
```

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
| `rows` | Number of lines of a textarea (default 4), rich text or Markdown editor (default 8) |
| `max` | `rating`: the number of stars, 3 to 10 (default 5) |
| `multiple` | `combobox`: `false` for a single free-text value with suggestions (default: several values, as tags) |
| `ecc` | `qrcode`: error correction `L`, `M` (default), `Q` or `H` |
| `size` | `qrcode`: width and height in pixels (64–1024; default 4 per module) |
| `show_value` | `qrcode`: `true` also prints the text under the code |
| `reveal` | `password`: `true` adds a *Show*/*Hide* button (shown only when JavaScript runs) |
| `format_mask` | `number`, `display`: a number format mask such as `999G999G990D00`; the value is shown in the language's notation and read back into a plain number on submit (see [number formats](14-globalization.md#number-formats)) |

## Rich text and Markdown

APEX's Rich Text Editor stores HTML; pgkiln's `richtext` item does too, but never stores or shows
HTML it did not rebuild itself. On submit and every time it is displayed, the HTML goes through a
strict allow-list (`src/richtext.ts`): paragraphs, line breaks, headings, bold/italic/underline/
strikethrough, sub/superscript, lists, quotes, code, horizontal rules and links. Text is always
escaped; links keep only `href` (`http`, `https`, `mailto`, `tel` or a relative URL) and get
`rel="noopener noreferrer nofollow"`; scripts, styles, event handlers, `style` attributes,
`javascript:`/`data:` URLs, images, frames, SVG and comments are dropped. An empty editor stores
nothing (NULL). The value may come from a table that other programs write: it is cleaned again
when shown, so stored HTML is never trusted.

With JavaScript the textarea becomes an editable area with a toolbar (bold, italic, underline,
strikethrough, heading, paragraph, lists, quote, code, link, remove link, clear formatting); the
toolbar is one tab stop (arrow keys move between its buttons). What it produces goes through the
same allow-list, in the browser and again on the server. Pasted or dropped content is cleaned
before it reaches the page: formatting within the allow-list is kept, and styles, images and
scripts from the other page are left out (pasted files are ignored).

The `markdown` item stores the Markdown text as typed. Read-only it is
rendered on the server: headings, paragraphs, emphasis, ~~strikethrough~~, inline and
fenced code, lists (nested), quotes, horizontal rules, links and bare `https://` addresses. HTML in
the Markdown is shown as text, and the result passes through the same allow-list.

## Star rating, combobox, date range, password reveal and QR code

- **Star rating** (`rating`): radio buttons, so the keyboard (arrow keys) and screen readers work as
  for any radio group (“3 of 5”); CSS draws stars. A required rating has no *No rating* choice. The
  server accepts only whole numbers from 1 to `max`.
- **Combobox** (`combobox`, APEX 23.2+): a text field with a `datalist` of the list of values. With
  several values (the default) JavaScript shows them as tags with a remove button; type and press
  Enter or comma, or pick a suggestion. Without JavaScript type the values separated by colons. The
  server trims the values and removes duplicates. A suggestion stores its return value; free text is
  stored as typed (a typed display value is turned into its return value in the browser).
- **Date range** (`daterange`): two date pickers with the item's name, stored as `from:to`. The
  server checks that both are real dates and that *from* is not after *to*; a required range needs
  both. A dynamic action that sets the item uses the same `from:to` text.
- **Password reveal**: `{"reveal": true}` on a `password` item adds a *Show*/*Hide* button
  (`aria-pressed`). The field is hidden again before the form is sent; the value is never sent back
  to the browser.
- **QR code** (`qrcode`): shows the item's value (set by a computation, a process or a form fetch)
  as an SVG QR code made on the server (byte mode, UTF-8, versions 1–40, no extra library), with
  the value as its accessible name. It cannot be submitted. Text longer than a QR code holds
  shows a message instead.

The HR example's page 20 *Reviews* (`examples/hr/hr_20_items.sql`) uses all of them.

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
   **Shared Components → Lists of values** and reusable in any item or grid column. A shared
   list can also read a web service: give it a **REST data source** and query the rows from
   `rest` ([chapter 19](19-rest-data-sources.md#lists-of-values)).

On submit, the value of a select list, radio group, checkbox group, multi-select or popup LOV (each
value of a multi-value item), and of a grid column with a list of values, must be one its list
returns at that moment, for that user: a list that leaves out departments a user may not pick also
keeps a crafted request from choosing them. Otherwise the item gets *"choose a value from the
list"*. For a list that may legitimately miss the current value, set `"any_value": true` in the
item's config. A combobox is free text and isn't checked.

## Popup LOV

A `popup_lov` item shows the chosen value's display text and a **Search** button. The button
opens a dialog with a search field: the server searches the item's own list of values (case
insensitive, on the display column and any extra columns) and answers one page at a time.

- **Several columns**: the first column is the display value, the second the return value, and
  any further columns are shown in the dialog (and searched), for example:
  ```sql
  select ename as name, empno, job, dname as department
    from hr.emp left join hr.dept using (deptno) order by 1
  ```
- **Attributes**: `{"page_size": 25}` rows per dialog page (at most 100); `max_rows` limits
  the select list the page itself renders (see below); `null_label` and `cascade_parents`
  work as for a select list.
- **Without JavaScript** the item is a plain select list of the first `max_rows` rows. A value
  beyond them is still shown, looked up by its return value.
- **Security**: the search runs as the application's database role, with the term as a bind
  parameter (never SQL text), only for an item the user may see and change on a page they may
  open. A submitted value must be one the list of values returns, or the page shows an error.

The HR example's page 26 (*Pick an employee*) has one with name, job and department columns.

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
  Links that pgkiln generates (report links, buttons, cards, calendars, `meta.page_url()`) carry
  the checksum `cs` automatically;
- **form fetch** (form regions);
- **processes** and **dynamic actions** whose SQL returns columns named like items:
  ```sql
  select hr.give_raise(:P3_EMPNO::int, 10) as p3_sal
  ```
- **application processes** (application items).

Values persist in session state until changed. `?clear=1` in a URL clears the page's items.
