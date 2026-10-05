# 14. Globalization

This chapter covers what APEX handles under *Shared Components → Globalization*: applications in
several languages, translated texts, date and number formats, time zones, and the light/dark
theme choice.

## Languages

Every application has a **primary language** (the language it's built in) and optionally
**translated languages**. Set them under **Builder → App → Settings → Globalization**:

| Setting | Meaning |
|---|---|
| Primary language | e.g. `en`, `nl`, `de`, `en-GB` |
| Translated languages | comma separated, e.g. `nl, de` |
| Language derived from | **Browser** (the `Accept-Language` header), **User preference, then browser**, or **Always the primary language** |
| Date format, Date and time format | masks such as `DD-MM-YYYY` and `DD-MM-YYYY HH24:MI` (see [date formats](#date-formats)) |
| Currency | ISO 4217 code (e.g. `EUR`) for `L` and `C` in [number format masks](#number-formats); empty: the language's default |
| Time zone, Automatic time zone | see [time zones](#time-zones) |

However the language is derived, users can switch:

- with `?lang=nl` on any URL (remembered for the session, like APEX's `p_lang`);
- with the language links under the login form;
- on **My account** (saved on the account and applied at every sign-in).

The page is served with `<html lang="…">`, and `dir="rtl"` for Arabic, Hebrew, Persian and Urdu.
SQL sees the language as `meta.app_language()` and the bind variable `:APP_LANGUAGE`.

### pgapex's own texts

The texts pgapex itself shows (sign-in, My account, report toolbars, paging, grid buttons,
calendar, validation and error messages) come in **English**, **Dutch**, **German**, **French**
and **Spanish** (like APEX's translated runtime messages). For another language they fall back
to English until you add them. To change any of them, or to add a language, create a **text
message** with the same name. For example, `login.title` in `it` → `Accedi`, or
`report.no_data` in `en` → `Nothing here yet.` The names are in `src/i18n.ts` (English and
Dutch) and `src/i18n/de.ts`, `fr.ts`, `es.ts`.

Each built-in language also brings its default date formats (`format.date`, `format.timestamp`:
`DD-MM-YYYY` in Dutch, `DD.MM.YYYY` in German, `DD/MM/YYYY` in French and Spanish) and currency
(`format.currency`: `EUR`; `USD` in English).

## Translating an application

APEX makes a copy of the application per language (seed, export XLIFF, translate, publish). APEX
26.1 added translation through text messages in the application itself. pgapex works like the
latter: **one application, with a translation table**.

**Builder → App → Shared Components → Globalization** lists every text of the application in the
primary language, with where it is used:

- the application name, page names and titles, navigation entries;
- region titles, column headings, "no data" messages, facet labels and range labels, smart filter placeholders, display selector tab names, static region HTML;
- item labels, help texts, placeholders, null labels, and the display values of static lists
  (`STATIC:Yes;Y,No;N`);
- button labels and confirmations, validation, process and dynamic-action messages, authorization
  error messages.

Type the translation next to each text and save. A text used in several places is translated
once. An empty translation shows the primary-language text. The coverage (`85 of 92 texts
translated`) is shown above the table.

Column headings that pgapex derives from column names (`hiredate` → "Hiredate") aren't in the
list, because they only exist once the query runs. Add them with **Add a text**.

### XLIFF and CSV

For translators outside the builder, **Export** gives an **XLIFF 1.2** file (the format APEX
uses; most translation tools and agencies read it) or a **CSV** file (`source,target,used_in`,
UTF-8, easy in a spreadsheet). **Import** reads either one back. For XLIFF, the language comes
from the file's `target-language`. Empty targets are skipped, so you can import a partly
translated file.

Translations, text messages and e-mail templates are part of the application export
(`meta.export_app()`), so they move with the application.

### Text messages

For texts that come from **SQL or PL/pgSQL** (a message in a trigger, a label computed in a
query), use text messages, like `APEX_LANG.MESSAGE`:

```sql
select meta.message('KPI_PAYROLL') as title, sum(sal) as badge from hr.emp;

raise exception '%', meta.message('LEAVE_OVERLAP', to_char(p_start, 'DD-MM-YYYY'));
-- text message LEAVE_OVERLAP (nl): 'Je hebt al verlof op %0.'
```

- `%0` … `%9` are replaced by the parameters.
- A missing language falls back to the base language (`nl-BE` → `nl`), then to the primary language, then to the name itself.
- In static HTML, titles and other texts with substitutions, use `&APP_TEXT$NAME.`, e.g. `&APP_TEXT$GREETING.`.

The HR sample's dashboard uses them for its key figures (`examples/hr/hr_04_i18n.sql`).

### Date formats

Dates and timestamps in reports, grids and display items are formatted with a **mask**:

| Token | Output | Token | Output |
|---|---|---|---|
| `YYYY`, `YY` | 2026, 26 | `HH24`, `HH12` / `HH` | 14, 02 |
| `MM` | 09 | `MI`, `SS` | 05, 09 |
| `MON`, `Mon`, `mon` | SEP, Sep, sep (in the page's language) | `AM` / `PM` | PM |
| `MONTH`, `Month` | SEPTEMBER, September | `DD` | 29 |
| `DY`, `DAY` | TUE, TUESDAY (case like MON) | `"text"` | literal text |

The mask comes from, in order:

1. a text message `format.date` / `format.timestamp` for the language;
2. the application's date formats (Settings);
3. pgapex's default for the language. English shows dates as PostgreSQL sends them (`2026-09-29`); Dutch uses `DD-MM-YYYY` and `DD-MM-YYYY HH24:MI`.

Form items keep ISO dates (`<input type="date">` shows them in the browser's own format). CSV
downloads keep ISO dates too. Chart and calendar labels use the page's language.

A column can have its own date mask, see [number formats](#number-formats).

### Number formats

Numbers in reports, grids, cards, charts and number and display items can have a **format mask**,
with the tokens of Oracle's `TO_CHAR` and APEX:

| Element | Meaning | Element | Meaning |
|---|---|---|---|
| `9` | a digit; leading zeros left out | `0` | a digit; zeros kept from here on |
| `G` | the language's group separator | `D` | the language's decimal separator |
| `,` `.` | a literal comma, point | `FM` | no padding; trailing decimal 9s are dropped |
| `L`, `U` | currency symbol (€) | `C` | ISO currency code (EUR) |
| `S` | sign first or last | `MI`, `PR` | trailing minus, `<negative>` |
| `B` | blank when the integer part is zero | `V` | multiply by 10ⁿ (n = digits after `V`) |
| `EEEE` | scientific notation | `X`, `RN`, `TM` | hexadecimal, Roman numerals, shortest text |

`%`, spaces and `"text"` are shown as they are (`%` doesn't multiply the value). Values are
handled as exact decimals, so a `numeric(30,10)` formats and rounds exactly (half away from zero).
A value too large for the mask shows `#` signs, as in Oracle.

| Mask | 1234.5 in English | in Dutch / German | in French |
|---|---|---|---|
| `999G999G990D00` | 1,234.50 | 1.234,50 | 1 234,50 |
| `FML999G990D00` | €1,234.50 (with currency EUR) | €1.234,50 | €1 234,50 |
| `FM990D0%` (on 12.34) | 12.3% | 12,3% | 12,3% |
| `00000` (on 42) | 00042 | 00042 | 00042 |

Where to set them:

- **Report, grid and cards columns:** `{"formats": {"sal": "FML999G990D00", "hiredate": "DD MON YYYY"}}`
  in the region's attributes, or the *Format mask* column of the page designer's **Report
  settings**. A mask with date tokens formats a date or timestamp column. Aggregates
  (sum, average, minimum, maximum), control breaks, group by and pivot views and the PDF use the
  column's mask; counts stay plain. CSV and Excel downloads keep the raw values.
- **Charts:** `{"format_mask": "FML999G990"}` formats the values in labels, tips and the data
  table (the axes stay compact).
- **Number and display items:** `{"format_mask": "999G999G990D00"}`. The item shows its value with
  the mask and reads what the user types back into a plain number (`1.234,50 €` → `1234.5` in
  Dutch) before validations and processes run, so SQL always sees `:P1_AMOUNT` as a number.
  Text that isn't a number is an error with an example: *Amount must be a number, e.g. 1,234.50.*

The currency is, in order: a text message `FORMAT.CURRENCY` for the language, the application's
*Currency* setting, the language's default. The builder refuses masks it can't read.

## Time zones

PostgreSQL shows `timestamp with time zone` values (and `now()`) in the session's `TimeZone`.
pgapex sets it per request (`SET LOCAL timezone`, so pooled connections are not affected) to:

1. with **Automatic time zone** on (APEX: *Automatic Time Zone*):
   1. the user's own choice on **My account** (*Time zone*, saved on the account and applied at
      every sign-in);
   2. else the browser's time zone. `app.js` sends it once per session (and with the sign-in
      form) to `POST /a/<alias>/tz`. When that changes the times on the page, the page loads again,
      unless the user has started typing;
2. else the application's **Time zone** (Settings → Globalization, an IANA name such as
   `Europe/Amsterdam`);
3. else the database's own setting.

Without JavaScript the application's time zone applies. Only names PostgreSQL knows
(`pg_timezone_names`) are accepted, from the builder, My account and the browser alike.
`timestamp` (without time zone) and `date` values aren't converted. In SQL,
`current_setting('TimeZone')` is the request's time zone, so `to_char(now(), 'HH24:MI')` is the
user's clock time.

The HR sample's page 29 *Formats and time zones* (`examples/hr/hr_30_formats.sql`) shows column
masks, a metric card and a chart with masks, a number item with a mask (try `?lang=nl`) and the
time of the request in your time zone.

## Light and dark

Under **Settings → Theme**, *Theme style* is **Automatic** (follow the device, the default),
**Light** or **Dark**. With **Users may choose light or dark** (on by default, like APEX's
*Enable End Users to Choose Theme Style*), the user menu has an *Appearance* switch and My account
has the same choice. The choice is saved on the account, so it applies in every application that
allows it. For public applications it's kept in a cookie.

## Style variants (Theme Roller)

APEX lets an application keep several *theme styles* and lets users pick one. In pgapex:
**Settings → Theme → Theme Roller** (`/builder/apps/:id/theme`) keeps up to 10 named **styles** per
application. The base colours under Settings → Theme are the *Standard* style; each style can change:

| Property | Values |
|---|---|
| Accent colour, header colour | `#rrggbb` (or "as the base"); like the base colours they apply to the light theme, dark mode keeps its own palette |
| Font | *System* (default), *Humanist sans*, *Geometric sans*, *Serif*, *Rounded*, *Monospace* (font stacks of fonts on the device; nothing is downloaded) |
| Font size | 14, 15 (default), 16 or 17 px |
| Corners | Square, 4, 8 (default) or 14 px, for regions, buttons and fields |

*Default style* is what everyone sees; with **Users may choose a style** (APEX: *Enable End Users
to Choose Theme Style*) the user menu and My account list the styles (*Standard* plus each style).
A signed-in user's choice is kept per application on the account (`meta.account_style`) and applied
at the next sign-in; signed out it lasts for the session. A choice is only honoured while the
application offers it: a deleted style falls back to the default, and a renamed one keeps its users.

The styles are part of the application's definition: they are stored in `meta.app.theme`
(`"styles"`, `"style"`, `"style_choice"`) and travel with export and import; users' choices
don't (they belong to the installation, and `pgapex import --replace` keeps them). Only values from
the fixed lists become CSS, in the page's one nonce'd `<style>`; a style's name is shown as text and
never reaches the CSS. Regions and buttons can add [template options](04-pages-and-regions.md#template-options).
