# pgapex documentation

pgapex is a low-code, SQL-driven application builder for PostgreSQL, modeled on Oracle APEX.
This guide explains how everything works, from installing it to building, securing and
deploying applications, and how to extend pgapex itself.

## User guide

| # | Chapter | What you will learn |
|---|---|---|
| 1 | [Installation and configuration](guide/01-installation.md) | Requirements, quick start, every configuration option, production deployment, upgrades, backups |
| 2 | [Concepts: how pgapex works](guide/02-concepts.md) | Architecture, the metadata repository, the request lifecycle, session state, bind variables, substitutions |
| 3 | [Using the builder](guide/03-builder.md) | Creating apps, the page wizards, the page designer, shared components, SQL Workshop, export/import |
| 4 | [Pages and regions](guide/04-pages-and-regions.md) | Page properties and every region type (reports, grids, forms, charts, cards, calendar, facets, static/dynamic content) with all attributes |
| 5 | [Items](guide/05-items.md) | Every item type, lists of values, cascading lists, read-only conditions, multi-value items |
| 6 | [Buttons, validations, processes and page logic](guide/06-processing.md) | Menu buttons and badges, what happens when a page is submitted, form and grid DML, calling PL/pgSQL, error handling, computations, conditional branches, build options, application processes |
| 7 | [Dynamic actions](guide/07-dynamic-actions.md) | Client-side behaviour: show/hide, set values from SQL, refresh regions, cascading lists |
| 8 | [Users, authentication and authorization](guide/08-security.md) | Sign-in, users and roles, passwords and My account, authorization schemes, row level security, session state protection |
| 9 | [SQL API and metadata reference](guide/09-reference.md) | `meta.*` functions, every metadata table and column, URL parameters |
| 10 | [Tutorial: build a Tasks app](guide/10-tutorial.md) | A complete app with RLS, PL/pgSQL, validations and dynamic actions, step by step |
| 11 | [Coming from Oracle APEX](guide/11-from-apex.md) | Concept mapping, porting PL/SQL to PL/pgSQL, users per app vs workspace, ORDS vs PostgREST |
| 12 | [Developing pgapex](guide/12-development.md) | Code structure, tests, adding a region or item type, release process |
| 13 | [REST APIs with PostgREST](guide/13-rest-api.md) | PostgREST next to pgapex, the `api` schema pattern, tokens, one set of RLS policies for UI and API |
| 14 | [Globalization](guide/14-globalization.md) | Languages, translating an app (XLIFF/CSV), text messages, date formats, light/dark |
| 15 | [Useful PostgreSQL extensions](guide/15-extensions.md) | Extensions for search, scheduling, auditing, maps, AI search, Oracle compatibility and web services, mapped to APEX features, with security notes |
| 16 | [Files, data loading and printing](guide/16-files.md) | File upload items, loading CSV/Excel/JSON into tables (SQL Workshop and pages), report PDFs, document templates and printing |
| 17 | [Mobile and field work](guide/17-mobile.md) | Progressive Web Apps: installing, offline pages, forms sent offline, location, camera and barcode items |
| 18 | [The command line and application files](guide/18-cli.md) | `pgapex` CLI: migrate, export/import, one file per component for git, static ids, diff, updating an app in place |
| 19 | [REST data sources and web credentials](guide/19-rest-data-sources.md) | Regions and lists of values on web services, web credentials (basic, API key, bearer, OAuth2) with write-only secrets, the `invoke_api` process, the server's allow-list |

## Other documents

- [Security model and review](../SECURITY.md)
- [Oracle APEX feature parity](apex-feature-parity.md)
- [Contributing](../CONTRIBUTING.md)
- [Changelog](../CHANGELOG.md)

## Conventions in this guide

- `code` refers to SQL, file names, configuration keys or UI labels you type.
- **Builder → App → Shared Components** describes a path through the builder's menus.
- Examples often use the HR example application (`/a/hr`, `npm run example:hr`); it is not part of pgapex.
