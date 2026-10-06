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
| `hr_33_automation_actions.sql` | *Remind managers* with two actions (escalation after a week, a condition per row), error handling *skip*, and a *Send reminders now* button on page 6 (`meta.run_automation`) |
| `hr_34_workflow_invoke_api.sql` | Workflow `DEPARTMENT_CHECK` with an `invoke_api` step (the `DEPARTMENT` REST data source of part 23, the status into a variable, a switch, a notification for the initiator), started by *Check in a workflow* on page 23 |
| `hr_35_project_charts.sql` | *Project plan* (page 32): a Gantt chart of an office move (`hr.project_task`: progress and dependencies, drill-down to the department's employees), a Gantt chart of the leave the user may see (drill-down to the request), a pyramid of organisation levels, a back-to-back pyramid of salary bands and a polar chart of hires per month |
| `hr_36_map_layers.sql` | *Field visits* (page 33): one map with four layers (clustered customer visits from `hr.field_visit`, the offices linked to their department, sales areas and delivery routes as GeoJSON, a heat map of the visits that is off at first) and a list of visits filtered by the distance from the map's centre |
| `hr_37_rest_writeback.sql` | *Contacts (REST)* (page 34): a sample CRM (`hr.crm_contact`) behind a REST module of the HR example, used through the REST data source `CRM_CONTACTS` by an interactive grid (Add, Save, Delete through the source's operations) and a form (fetch, create, save, delete), and synchronised into `hr.crm_contact_copy` (merge on id; *Synchronise* queues `meta.request_rest_sync()`; a 15-minute schedule, switched off). Needs `PGAPEX_REST_ALLOWED_HOSTS` / `PGAPEX_REST_PRIVATE_HOSTS` = `127.0.0.1` |
| `hr_38_parse_and_fetch.sql` | *Parse and fetch* (page 35): pasted CSV/JSON parsed in SQL with `meta.parse_data` / `meta.parse_data_columns`, and *Fetch the contacts*: a page process queues `meta.web_request()` to the sample CRM of part 37, the server makes it right away and the next process reads `meta.web_response()` (needs `PGAPEX_REST_ALLOWED_HOSTS` / `PGAPEX_REST_PRIVATE_HOSTS` = `127.0.0.1`) |
| `hr_40_sample_data.sql` | A saved generator of SQL Workshop → *Sample Data*, *HR demo staff*: 3 departments, 15 employees (managers and departments picked from existing and new rows, salaries the `hr.check_salary` trigger accepts) and 30 leave requests ending on or after their start, with seed 2026 |
| `hr_42_hr_assistant.sql` | *HR assistant* (page 38): an AI assistant region with a context query over the HR policies (`hr.policy`, full-text search on the question) and four tools run as `hr_app` (the user's leave, colleagues, departments, and *request_leave*, the only one that changes data), next to a staff list with *Ask in your own words* (natural-language filters). Needs an AI service named `HR_ASSISTANT` (see part 41) |
| `hr_43_drawer.sql` | *Leave request* (page 7) opens as a drawer from the right instead of a centred dialog |
| `hr_44_built_in_components.sql` | *Team overview* (page 39): the built-in template components: metric cards, an avatar group, a timeline, a media list linking to the department dialog, and comments |
| `hr_45_photo_crop.sql` | The employee photo (page 3) is cropped to a square in the browser before upload |
| `hr_46_static_files.sql` | Static application files `hr.js` and `hr.css` on every page; two *Execute JavaScript* dynamic actions show the salary per year on the employee form (page 3) |
| `hr_47_plugins.sql` | *Plug-ins* (page 40): the four example plug-ins of `examples/plugins/` (a region, an item, a dynamic action and a process plug-in) |
| `hr_48_map_tiles.sql` | *Weather stations* (page 41): 20,000 generated stations (`hr.weather_station`) as vector tiles, and the stations above 2,000 m loaded for the visible area |
| `hr_49_push_notifications.sql` | Push notifications: the app may send them (users turn them on under *My account → Notifications*); a new leave request notifies the manager, a decision notifies the employee, and the notification opens the request (page 7) |

The files run in order, each once (recorded in `public.pgapex_seed`), so new ones can be added
later. pgapex's own tests use this application as their fixture (`npm test` installs it first).

Optional add-ons for local single sign-on and LDAP demos: `examples/keycloak-sso.sql`,
`examples/keycloak-saml.sql` and `examples/ldap-directory.sql`.

To remove it: `drop schema hr cascade; drop role hr_app, hr_api;` and delete the application in the
builder (or `delete from meta.app where alias = 'hr'`).
