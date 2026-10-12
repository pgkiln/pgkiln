# Roadmap

pgkiln aims for functional parity with Oracle APEX on PostgreSQL. The full comparison, row by row,
is in [docs/apex-feature-parity.md](docs/apex-feature-parity.md); this page is the short version.
Released changes are in the [changelog](CHANGELOG.md).

## Where it stands

- **Current release:** 0.33.2 (October 2026): test a mail service before saving it; 0.33.1: a friendlier Mail services screen; 0.33.0: checked imports, application backups, availability and Run only, feedback; 0.32.0: e-mail, the search and URL regions, the developer toolbar.
- **APEX parity:** 140 features compared: 121 available, 6 partial, 10 not yet, 3 deliberately
  not planned (collections, JSON duality views and database links: PostgreSQL covers them).

## Next

Partial features first, then the missing ones, roughly in this order:

1. **Partial:** more dynamic action events, the remaining region templates (carousel, hero,
   wizard, …), and multi-tenant workspaces.
2. **Page behaviour:** the missing dynamic action actions (confirm, close dialog, clear, download,
   print, …), Ajax callbacks (on-demand processes), an error handling function, a session timeout
   warning.
3. **Reports and data:** interactive grid views (single row, chart, group by), display image and
   geocoded address items, data export from SQL (CSV, XLSX, PDF, JSON).
4. **Users and apps:** user preferences and application settings, dynamic translations of data
   values, page groups.
5. **Developer tools:** Quick Edit from the developer toolbar, the Page Designer's help pane for the
   selected property; schema comparison and DDL generation in the SQL Workshop.
6. **Languages:** more built-in runtime languages (22 today), once the rows above are done.

Priorities can change with what users need: open an
[issue](https://github.com/pgkiln/pgkiln/issues) for a feature you miss, or see
[CONTRIBUTING.md](CONTRIBUTING.md) to help build one.
