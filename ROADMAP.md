# Roadmap

pgkiln aims for functional parity with Oracle APEX on PostgreSQL. The full comparison, row by row,
is in [docs/apex-feature-parity.md](docs/apex-feature-parity.md); this page is the short version.
Released changes are in the [changelog](CHANGELOG.md).

## Where it stands

- **Current release:** 0.31.0, the first public release (October 2026).
- **APEX parity:** 137 features compared: 113 available, 6 partial, 15 not yet, 3 deliberately
  not planned (e-mail sending among them; use an extension or an external service).

## Next

Partial features first, then the missing ones, roughly in this order:

1. **Partial:** automatic row processing in forms, more dynamic action events, the remaining
   region templates (carousel, hero, wizard, …), warn on unsaved changes everywhere, and
   multi-tenant workspaces.
2. **Page behaviour:** the missing dynamic action actions (confirm, close dialog, clear, download,
   print, …), Ajax callbacks (on-demand processes), an error handling function, a session timeout
   warning.
3. **Reports and data:** interactive grid views (single row, chart, group by), search
   configurations and the search region, a URL region, display image and geocoded address items,
   data export from SQL (CSV, XLSX, PDF, JSON).
4. **Users and apps:** user preferences and application settings, dynamic translations of data
   values, feedback from users, automatic application backups and page groups.
5. **Developer tools:** a developer toolbar with a session state viewer; schema comparison and DDL
   generation in the SQL Workshop.
6. **Languages:** more built-in runtime languages (22 today), once the rows above are done.

Priorities can change with what users need: open an
[issue](https://github.com/pgkiln/pgkiln/issues) for a feature you miss, or see
[CONTRIBUTING.md](CONTRIBUTING.md) to help build one.
