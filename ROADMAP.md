# Roadmap

pgkiln aims for functional parity with Oracle APEX on PostgreSQL. The full comparison, row by row,
is in [docs/apex-feature-parity.md](docs/apex-feature-parity.md); this page is the short version.
Released changes are in the [changelog](CHANGELOG.md).

## Where it stands

- **Current release:** 0.97.0 (November 2026): every application runs as a database role of its own (NX-S2), no default password on a public installation (NX-S3), the APEX importer rewrites common Oracle SQL and files the hand work as Team Development issues (NX-F1), a clearer message when row level security refuses the SQL Workshop.
- **APEX parity (26.2):** 174 features compared: 171 available, none partial, none missing (WS-7, the builder in
  more languages, arrived in sprint 121), 3 deliberately not planned (PostgreSQL or the platform covers them).

## Next

Partial features first, then the missing ones, roughly in this order:

1. ~~**Partial:** the remaining region templates~~ (done in sprint 57), ~~multi-tenant workspaces~~ (isolated workspaces, sprint 60).
2. ~~**Page behaviour**~~: done in sprint 52 (every dynamic action event and action, Ajax callbacks,
   an error handling function, the session timeout warning).
3. ~~**Reports and data:** interactive grid views (single row, chart, group by)~~ (done in sprint 54);
   ~~display image and geocoded address items, data export from SQL~~ (done in sprint 53).
4. **Users and apps:** ~~page groups~~ (done in sprint 58); ~~user preferences and application settings, dynamic
   translations of data values~~ (done in sprint 53).
5. **Developer tools:** ~~Quick Edit from the developer toolbar, the Page Designer's help pane for the
   selected property~~ (done in sprint 59); ~~schema comparison and DDL generation in the SQL Workshop~~ (done in sprint 56).
6. **Next level (November 2026), in this order:** ~~browser security per application (NX-S4, sprint 188)~~,
   ~~session limits and Expire bookmarks per application (NX-S5, sprint 189)~~, ~~the APEX importer on real 26.2
   exports (sprint 190)~~; then
   - **NX-S6** a production readiness check, also as `pgkiln admin check --production` for deploy pipelines;
   - **NX-F5 from Oracle to pgkiln**: the schema and data path for teams leaving APEX. pgkiln doesn't translate
     Oracle DDL itself: [ora2pg](https://ora2pg.darold.net/) moves the tables, data and a first pass of the PL/SQL,
     and pgkiln adds a tested recipe in chapter 11, `pgkiln import-apex --check` (the tables, columns and sequences an
     APEX application uses that the PostgreSQL schema doesn't have), import reports that point PL/SQL to port at what
     ora2pg converted, and an end-to-end run on Oracle Database Free (schema and data through ora2pg, then the
     application, every page showing data);
   - **NX-F3** page type, alias and who changed what in the Pages report; **NX-F2** nested regions; **NX-F4** builder
     tokens for the command line and MCP; then the builder UX findings NX-U1, NX-U3 … NX-U6.
   - More real APEX exports to test the importer against (each one so far showed gaps the samples didn't).

Priorities can change with what users need: open an
[issue](https://github.com/pgkiln/pgkiln/issues) for a feature you miss, or see
[CONTRIBUTING.md](CONTRIBUTING.md) to help build one.
