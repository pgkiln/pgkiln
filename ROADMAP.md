# Roadmap

pgkiln aims for functional parity with Oracle APEX on PostgreSQL. The full comparison, row by row,
is in [docs/apex-feature-parity.md](docs/apex-feature-parity.md); this page is the short version.
Released changes are in the [changelog](CHANGELOG.md).

## Where it stands

- **Current release:** 0.91.0 (November 2026): parity leftovers: keep notices in the SQL Worksheet, workflow instance diagrams in the Workflow Console, plv8 bodies highlighted as JavaScript, a version per App Gallery app.
- **APEX parity (26.2):** 174 features compared: 171 available, none partial, none missing (WS-7, the builder in
  more languages, arrived in sprint 121), 3 deliberately not planned (PostgreSQL or the platform covers them).
- **Beyond parity, unreleased (sprint 177):** `meta.web_request` as an outbox (retries, callbacks, ordered delivery,
  idempotency keys) and inbound webhooks (the REST handler type `webhook`: signed, deduplicated, processed afterwards).

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

Priorities can change with what users need: open an
[issue](https://github.com/pgkiln/pgkiln/issues) for a feature you miss, or see
[CONTRIBUTING.md](CONTRIBUTING.md) to help build one.
