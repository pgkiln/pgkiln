# Roadmap

pgkiln aims for functional parity with Oracle APEX on PostgreSQL. The full comparison, row by row,
is in [docs/apex-feature-parity.md](docs/apex-feature-parity.md); this page is the short version.
Released changes are in the [changelog](CHANGELOG.md).

## Where it stands

- **Current release:** 0.47.0 (October 2026): the SQL Workshop like Oracle Database Actions: one SQL Worksheet with a navigator, the statement at the cursor or a whole script with a log per statement, Explain Plan and Autotrace as trees, a Query Result grid with downloads, SQL History, worksheets saved as scripts in tabs, Format, find and replace, bind variables, an object menu with Quick DDL and Drop, and Table Properties to create, edit or copy a table in a form; 0.46.0: the Form Designer (administrators build data entry forms in the running application on the tables the developer offers), pgkiln's own date picker in the application's date format everywhere, facet menus, the page designer by page number with HTML error pages in the builder, a Create Application wizard that reloads its page list and shows row level security, generated home pages with coloured cards and a page footer with the version, the Object Browser's Modify column and one row of tabs, and Comment Out in the page designer; 0.45.0: Shared Components like APEX's (Application Computations, Shortcuts, Report Queries, Component Settings and Component Groups), master-detail pages that open with the first master row selected, and grid cells that read as text with their format mask until edited; 0.44.0: generated applications that read the same in every report and grid (one column per foreign key in faceted search, friendly grid headings, format masks, Yes/No facets with a total row count), an application's own light or dark mode, a signed-out user menu, a developer toolbar with texts, the report search's column scope as its magnifier, and dashboards that sum amounts; 0.43.0: the builder's information architecture like APEX's (a Shared Components grid, Settings tabs, the application home's search and tasks), the SQL Workshop's Object Browser by object type, the interactive report's Actions menu, column heading menus and pager, dates in the application's format, display positions, side-column page templates and button positions with a Page Designer that lays them out (tree by position, context menu, Duplicate and Copy to other page, Common / All); 0.42.0: generated applications like APEX's (human labels, foreign keys by name, file columns, format masks, a Home page with cards, an About page), the Iris look of APEX 26, a developer toolbar of icons, and the Create Application wizard on one page with page types and features; 0.41.0: REST source catalogs from OpenAPI documents, a workspace's export and import, the Data Reporter's welcome page, Find my workspace, Gantt editing by drag and drop, treemap, sunburst and timeline charts; 0.40.0: facet charts and a blueprint from an existing application; 0.39.0: workspace preferences and extension links, Manage backups across applications, SQL Workshop utilities (object reports, About Database, a database monitor), range, box plot and stock charts, approval vacation rules and expiration policies; 0.38.0: the builder's screens like APEX 26.1's (a sign-in page with a workspace, an Administration menu with workspace message, environment banner and utilization, the SQL Workshop home, the App Gallery, application groups, cross application reports); 0.37.0: isolated workspaces (own database logins, row-level security on pgkiln's tables, workspace database roles, workspace administrators); 0.36.0: interactive grid views (single row, group by, chart), an editable login page and Forgot password, Generate DDL and Schema Comparison, more region templates (hero, inline dialog and drawer, wizard, carousel), page groups, Quick edit and the Page Designer's help pane; 0.35.0: application settings, user preferences, dynamic translations, data export from SQL, display image and geocoded address items; 0.34.0: every dynamic action event and action, Ajax callbacks, an error handling function, a session timeout warning; 0.33.2: test a mail service before saving it; 0.33.1: a friendlier Mail services screen; 0.33.0: checked imports, application backups, availability and Run only, feedback; 0.32.0: e-mail, the search and URL regions, the developer toolbar.
- **APEX parity:** 146 features compared: 143 available, none partial or missing, 3 deliberately
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
