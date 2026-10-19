# Roadmap

pgkiln aims for functional parity with Oracle APEX on PostgreSQL. The full comparison, row by row,
is in [docs/apex-feature-parity.md](docs/apex-feature-parity.md); this page is the short version.
Released changes are in the [changelog](CHANGELOG.md).

## Where it stands

- **Current release:** 0.52.0 (October 2026): AI Agents with tools, AI interactive reports ("ask in your own words" with chips and a parser that needs no AI service), Team Development (issues, labels, milestones, a board), Workflow 26.2 (custom task outcomes, task events and notifications, Send E-Mail and draft steps, migrating running instances, the diagram as SVG / PNG), popup LOVs that load on scroll, a Wait Popup and dynamic actions on menu entries.
- **APEX parity:** 149 features compared: 146 available, none partial or missing, 3 deliberately
  not planned (collections, JSON duality views and database links: PostgreSQL covers them).

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
