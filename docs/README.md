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
| 6 | [Buttons, validations and processes](guide/06-processing.md) | What happens when a page is submitted, form and grid DML, calling PL/pgSQL, error handling, branches, application processes |
| 7 | [Dynamic actions](guide/07-dynamic-actions.md) | Client-side behaviour: show/hide, set values from SQL, refresh regions, cascading lists |
| 8 | [Users, authentication and authorization](guide/08-security.md) | Sign-in, users and roles, authorization schemes, row level security, session state protection |
| 9 | [SQL API and metadata reference](guide/09-reference.md) | `meta.*` functions, every metadata table and column, URL parameters |
| 10 | [Tutorial: build a Tasks app](guide/10-tutorial.md) | A complete app with RLS, PL/pgSQL, validations and dynamic actions, step by step |
| 11 | [Coming from Oracle APEX](guide/11-from-apex.md) | Concept mapping, porting PL/SQL to PL/pgSQL, users per app vs workspace, ORDS vs PostgREST |
| 12 | [Developing pgapex](guide/12-development.md) | Code structure, tests, adding a region or item type, release process |

## Other documents

- [Security model and review](../SECURITY.md)
- [Oracle APEX feature parity](apex-feature-parity.md)
- [Contributing](../CONTRIBUTING.md)
- [Changelog](../CHANGELOG.md)

## Conventions in this guide

- `code` refers to SQL, file names, configuration keys or UI labels you type.
- **Builder → App → Shared Components** describes a path through the builder's menus.
- SQL examples assume the HR sample app (`/a/hr`), which `npm run setup` installs.
