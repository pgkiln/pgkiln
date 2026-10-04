# HR: an example application built on pgapex

This directory is **not part of pgapex**. It is an application built with it, the way you would
build your own: a PostgreSQL schema (`hr`) with tables, PL/pgSQL business rules, triggers and row
level security, a database role for the app (`hr_app`), and the application definition as rows in
pgapex's `meta` schema.

```bash
npm run example:hr        # = npx tsx scripts/migrate.ts --example hr
```

Then open http://127.0.0.1:3100/a/hr and sign in as `king`, `blake`, `jones`, `allen`, `scott` or
`demo` (the password equals the username).

| File | What it adds |
|---|---|
| `hr.sql` | Schema, business functions, RLS, the app with its pages, the users |
| `hr_02_showcase.sql` | Dashboard, charts, cards, interactive grid, calendar, facets |
| `hr_03_api.sql` | An `api` schema for PostgREST (REST API) |
| `hr_04_i18n.sql` | Dutch translation and text messages |
| `hr_05_files.sql` | Employee photos (file upload) |
| `hr_06_data_load.sql` | Import employees (CSV, Excel, JSON) |
| `hr_07_layouts.sql` | A report layout for PDFs |
| `hr_08_automations.sql` | A scheduled reminder for pending leave |
| `hr_09_documents.sql` | The employee sheet (document template) and its Print button |
| `hr_10_approvals.sql` | Leave approvals as tasks, and the *My tasks* page |
| `hr_20_items.sql` | *Reviews* (page 20): rich text, Markdown, star rating, combobox (tags), date range, QR code and password reveal items |

The files run in order, each once (recorded in `public.pgapex_seed`), so new ones can be added
later. pgapex's own tests use this application as their fixture (`npm test` installs it first).

Optional add-ons for local single sign-on and LDAP demos: `examples/keycloak-sso.sql`,
`examples/keycloak-saml.sql` and `examples/ldap-directory.sql`.

To remove it: `drop schema hr cascade; drop role hr_app, hr_api;` and delete the application in the
builder (or `delete from meta.app where alias = 'hr'`).
