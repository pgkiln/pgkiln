# 3. Using the builder

The builder lives at `/builder`. Everything it does is also possible in SQL (see
[the reference](09-reference.md)); the builder just makes it quicker.

## Signing in and developer accounts

Sign in with a developer account. The first one is `admin` / `admin`, and a red banner reminds you
to change it. On the **Developers** page you can:

- change your own password (minimum 8 characters; other builder sessions of yours end);
- add developer accounts;
- remove other developers (their sessions end immediately).

All developers have full rights in the builder and the SQL Workshop.

## App Builder home

The home page shows your applications as cards (with page count and today's page views), and
forms to **create** and **import** applications.

### Creating an application

| Field | Meaning |
|---|---|
| Name | Display name, shown in the header |
| Alias | Lowercase URL name: `inventory` gives `/a/inventory` |
| Parsing schema | The database schema the app works with. Choose an existing schema, or leave it on "new schema" to create one named after the alias |
| Authentication | *App users* (a login page and a user list) or *None* (a public app) |
| First user / Password | The first application user; they get the `admin` role |

Creating the app also:

- creates the database role `app_<alias>` with `SELECT/INSERT/UPDATE/DELETE` on all tables,
  `USAGE` on sequences and `EXECUTE` on functions in the schema, plus **default privileges**,
  so tables you create later (as the owner, e.g. in the SQL Workshop) are usable by the app straight away;
- creates page 1 *Home*, a navigation entry, and an authorization scheme `ADMIN` (role `admin`).

### Importing

Paste the JSON of an export and optionally give a new alias. Imported apps keep the database role
of the export; check it under **Settings**, and create users under **Shared Components**.

## App dashboard

Open an application to see its pages, with region/item/dynamic-action/process counts,
authorization and protection. The buttons at the top lead to **Shared Components**, **Activity**,
**Settings**, **Export** and **Run**.

### Create pages from a table (wizards)

| Page type | What is generated |
|---|---|
| **Report and form** | An interactive report page listing the table (with an edit link per row and a Create button) and a **modal dialog** form page with Create, Apply Changes and Delete, a form DML process, fields per column (foreign keys become select lists, booleans become switches, NOT NULL columns without default become required) and a navigation entry |
| **Interactive grid** | One page with an editable grid (foreign keys become select lists, NOT NULL columns become required), a grid DML process and a navigation entry |

The table needs a single-column primary key. Make sure the app's database role has privileges
on it (automatic for its own schema).

### Create a blank page

Give a page number, name, mode (normal or modal dialog) and breadcrumb parent, then add
components in the page designer.

## The page designer

The page designer has two panes:

- **Left: the component tree**, as in APEX's Page Designer:
  - the page itself;
  - **Rendering**: regions, each with its items and buttons (plus *+ item* / *+ button* shortcuts);
  - **Page-level items & buttons**: those not in a region;
  - **Dynamic actions**;
  - **Validations** and **Processes**.

  Tags show which components have an authorization scheme (e.g. `MANAGER`) or a condition (`cond`).
- **Right: the property editor** for the selected component, grouped (Identification, Source,
  Layout, Security, …) with help text for each property.

Click a component to edit it, use **+ Add** to create one, and use **Run page** to open the page in
a new tab. Changes are saved per component with **Save** and are live immediately.

Page properties:

| Property | Meaning |
|---|---|
| Page number, name, title | The title supports `&ITEM.` substitutions |
| Page mode | *Normal*, or *Modal dialog* (opens over the calling page) |
| Breadcrumb parent | Builds the breadcrumb trail (and the highlighted menu entry) |
| Requires authentication | Uncheck for public pages in an app with a login |
| Authorization scheme | Who may open the page |
| Page access protection | *Arguments must have checksum* (default): item values in the URL are only accepted from links pgapex generated. *Unrestricted*: anyone may set this page's items through the URL |

Chapters 4–7 describe every component type and property.

## Shared components

Components used by the whole application:

| Component | Purpose |
|---|---|
| **Application users** | Create users, set roles (comma separated), reset passwords, deactivate. Changing a password or deactivating a user ends their sessions |
| **Navigation menu** | Menu entries: label, icon, target page, parent (for sub-menus), authorization |
| **Authorization schemes** | Named access rules, used by pages, regions, items, buttons, processes, dynamic actions and menu entries ([chapter 8](08-security.md)) |
| **Lists of values** | Reusable queries for select lists, referenced as `LOV:NAME` |
| **Application items** | Session variables not on any page, set only by server-side code |
| **Application processes** | Code that runs *after login* or *before every page* |

## Settings

- **Application**: name, alias, home page.
- **Security**: authentication (*App users* / *None*), the database role, and **debug mode**
  (shows full database errors to users; development only).
- **Theme**: accent colour, header colour, and *side* or *top* navigation (on tablets and phones the
  menu is always a drawer).
- **Security checklist**: whether the app has its own role, debug mode, and pages without
  checksum protection or without authentication.
- **Delete application**: removes the definition (not your tables).

## Activity monitor

Per application: page views, distinct users and average page time over the last 24 hours;
failed and locked sign-ins; errors and access denials; views and timings per page over 7 days;
and a list of recent events (with *Include page views*). The "reference #123" numbers users see
on errors are the event ids here.

## SQL Workshop

- **SQL Commands**: run any SQL as the **owner connection**, not as an application role. Multiple
  statements are allowed; the result of the last one is shown (up to 500 rows). Press
  **Ctrl/Cmd + Enter** to run.
- **Object Browser**: tables, views and functions per schema. For a table you see columns, types
  and defaults, **row level security policies**, **grants** and the first 25 rows; for a
  function, its source.

Because the SQL Workshop runs as the owner, restrict who gets a developer account.

## Export and import

**Export** downloads the application as JSON: pages, all components, shared components and
settings. Users, sessions, logs and your database objects are not included. The format is stable
(`"format": "pgapex/2"`), and since it's plain JSON you can commit it to git and review changes in
pull requests.
