# 14. Globalization

This chapter covers what APEX handles under *Shared Components → Globalization*: applications in
several languages, translated texts, date formats, and the light/dark theme choice.

## Languages

Every application has a **primary language** (the language it's built in) and optionally
**translated languages**. Set them under **Builder → App → Settings → Globalization**:

| Setting | Meaning |
|---|---|
| Primary language | e.g. `en`, `nl`, `de`, `en-GB` |
| Translated languages | comma separated, e.g. `nl, de` |
| Language derived from | **Browser** (the `Accept-Language` header), **User preference, then browser**, or **Always the primary language** |
| Date format, Date and time format | masks such as `DD-MM-YYYY` and `DD-MM-YYYY HH24:MI` (see [date formats](#date-formats)) |

However the language is derived, users can switch:

- with `?lang=nl` on any URL (remembered for the session, like APEX's `p_lang`);
- with the language links under the login form;
- on **My account** (saved on the account and applied at every sign-in).

The page is served with `<html lang="…">`, and `dir="rtl"` for Arabic, Hebrew, Persian and Urdu.
SQL sees the language as `meta.app_language()` and the bind variable `:APP_LANGUAGE`.

### pgapex's own texts

The texts pgapex itself shows (sign-in, My account, report toolbars, paging, grid buttons,
calendar, validation and error messages) come in **English** and **Dutch**. For another language
they fall back to English until you add them. To change any of them, or to add a language, create
a **text message** with the same name. For example, `login.title` in `de` → `Anmelden`, or
`report.no_data` in `en` → `Nothing here yet.` The names are in `src/i18n.ts`.

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

## Light and dark

Under **Settings → Theme**, *Theme style* is **Automatic** (follow the device, the default),
**Light** or **Dark**. With **Users may choose light or dark** (on by default, like APEX's
*Enable End Users to Choose Theme Style*), the user menu has an *Appearance* switch and My account
has the same choice. The choice is saved on the account, so it applies in every application that
allows it. For public applications it's kept in a cookie.
