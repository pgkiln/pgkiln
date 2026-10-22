# 3. Using the builder

The builder lives at `/builder`. Everything it does is also possible in SQL (see
[the reference](09-reference.md)); the builder just makes it quicker.

## Signing in and developer accounts

Sign in with a developer account. The first one is `admin` / `admin`, and a red banner reminds you
to change it. After signing in the builder opens the [Workspace home](#workspace-home) (`/builder/home`).

The sign-in page (`/builder/login`) is laid out like APEX's: **Workspace** (optional), **Username** and
**Password** (with a *Show* button). A workspace you name must be one of yours (administrators: any); it becomes the
current one, and a wrong one gets the same answer as a wrong password. Left empty, you continue in your first
workspace and switch in your account menu. **Remember workspace and username** keeps both on this device (an
HttpOnly cookie for `/builder`, no password); signing in without the tick forgets them. *Administration* under the
form signs in and opens Workspace utilities.

**Find my workspace** under the form (APEX: Find My Workspace) asks for an e-mail address and mails the developer
accounts with that address their user name and the workspaces they belong to. It needs a mail service for the
builder: Workspace utilities → Mail services → **Builder mail** (a service and a From address among its senders);
without one the page says to ask an administrator. The page answers the same whether or not an account has the
address, the mail leaves after the answer, and it sends at most three mails an hour to an address and handles ten
requests an hour from an IP address. Developers set their own address on the Developers page (migration 096);
administrators set anyone's.

On the **Developers** page you can:

- change your own password (minimum 8 characters; other builder sessions of yours end);
- set your **e-mail address** (optional; *Find my workspace* sends your workspaces to it);
- as an **administrator**: add developer accounts (developers or administrators, with an e-mail address), change
  their e-mail addresses, make a developer
  an administrator or the other way round, and remove other developers (their sessions end
  immediately).

All developers have full rights in the builder and the SQL Workshop; administrators also manage
developer accounts and [workspaces](#workspaces) and can break other developers' [locks](#page-locks-and-comments). Accounts
that existed before 0.23 and those made with the command line are administrators. A developer added on this page
joins the workspace you are working in; one made with the command line or SQL joins the Default workspace.

### Two-factor sign-in

(0.60) Developers can sign in to the builder with a second factor: a 6-digit code from an **authenticator app**
(Google Authenticator, Microsoft Authenticator, 1Password, Bitwarden, any app for TOTP codes per RFC 6238) or
(0.61) a **passkey**: the fingerprint reader, face recognition or screen lock of a laptop or phone, or a security key
(WebAuthn). APEX has no built-in second factor for the builder; there it comes from an identity provider.

**Setting it up.** Your account menu → **Two-factor sign-in** opens **Security** (`/builder/security`):

1. **Add an authenticator app** shows a QR code (and the key to type in by hand). Scan it with the app.
2. Enter the code the app shows, give the app a name (*Phone*) and **Confirm and turn on**.
3. You get **ten recovery codes**, shown once. Save them away from your phone and tick *I saved these codes*.

**A passkey** instead (or as well): on Security, give it a name (*Laptop*) and click **Add a passkey**; the browser asks
for your fingerprint, face, screen lock or security key. Add one on each device you use, or one that syncs (iCloud
Keychain, Google Password Manager, 1Password). The first factor you add, app or passkey, gives you the recovery codes.

From then on, signing in asks for a code, or a passkey with **Use a passkey**, after the password. A recovery code works instead of an app code, once;
signing in with one opens Security, which shows how many are left and makes new ones (the old ones stop working).
Removing an app or a passkey asks for your password. Each code is accepted once, and one 30-second step either side
of the server's clock.

A passkey belongs to the **address** it was made at. With `PUBLIC_URL` set, that is its host name; otherwise the
host name in the browser's address bar. Passkeys need a host name: at `http://127.0.0.1:3100` the page asks you to
use `http://localhost:3100` instead. If the builder moves to another domain, passkeys made for the old one are
marked *for old.example.com* and stop working there; add new ones (apps and recovery codes keep working). To use
one passkey on several sub-domains, set `PGKILN_RP_ID` to the parent domain (`example.com` for
`builder.example.com`; [chapter 1](01-installation.md)). Passkeys are public keys: they keep working when the
instance key changes. pgkiln accepts any authenticator (attestation *none*), checks the signature, the address and
the relying party on every sign-in, and refuses a key whose signature counter goes back (a copied key).

The app's secret is stored encrypted with the instance key (`PGKILN_SECRET_KEY`, [chapter 1](01-installation.md));
without the key the page says so and you can't add an app. Recovery codes are stored as SHA-256 hashes, so they keep
working if the key is lost. Wrong codes count with wrong passwords for the [sign-in lockout](08-security.md#what-sign-in-protects-against).

**Requiring it.** Administrators set the policy in Workspace utilities → **Instance settings** → *Two-factor
sign-in*: **Nobody** (optional, the default), **Administrators** or **All developers**, with a **grace period**
(default 7 days). During the grace period a developer without an app sees a reminder on every page; after it, they
see only their Security page until they add one. The region lists the developers who have no app yet.

**Trusted browsers** (0.61): *Trust a browser (days)* in the same region (0, the default: never) adds *Trust this
browser for N days* to the second step. A trusted browser skips the second step for that developer until the days
are over; only a hash of the cookie's random token is stored. The developer's Security page shows how many browsers
they trust and **Forget trusted browsers**; changing the password, removing a factor or a reset forgets them too, and
setting the days to 0 stops every trusted browser at once.

**So nobody is locked out:**

- The policy can be turned on only when **at least two administrators** have two-factor sign-in (or every
  administrator, when there are fewer than two). While it is on, an administrator can't remove their last app, be
  made a developer or be removed when that would leave fewer.
- An administrator **resets** another developer's two-factor sign-in on **Developers** (the *Two-factor* column →
  *Reset*, with a reason): their apps and recovery codes are removed and their builder sessions end; they sign in with
  the password and set up an app again.
- Resets, policy changes, new apps and used recovery codes are in the activity log (`2fa_reset`, `2fa_policy`,
  `2fa_enrolled`, `2fa_recovery_used`), and resets and policy changes are mailed to the administrators when the
  builder has a mail service (*Builder mail*).

### Locked out?

| Situation | What to do |
|---|---|
| Lost your phone or key, still have recovery codes | Sign in with a recovery code, remove the old app or passkey on Security and add the new one |
| Lost phone, keys and codes | Ask another administrator to reset your two-factor sign-in on Developers |
| A passkey no longer works after a move to another domain | Sign in with an app code or a recovery code and add a new passkey ([above](#two-factor-sign-in)) |
| No administrator can sign in | On the server: `pgkiln admin reset-2fa <developer> --reason "…"` ([chapter 18](18-cli.md)), then sign in with the password |
| The policy locks everyone out | On the server: `pgkiln admin set-2fa-policy off` |
| Codes are always wrong | Check the time on the phone and on the server (codes allow 30 seconds either way) |
| The instance key was lost or changed | The apps' secrets can't be read: reset the developers (`pgkiln admin reset-2fa`); recovery codes still work |

The command line needs the owner's database connection (`DATABASE_URL`), so only someone with access to the server
can use it. It writes to the activity log and mails the administrators too. With Docker:
`docker compose exec pgkiln node bin/pgkiln.js admin reset-2fa admin`.

## Workspaces

A workspace (APEX: a workspace) groups applications and the developers who build them, for example per team or
department. Every installation has the **Default** workspace, which holds the applications and developers from before
0.29 (and can't be deleted).

- **Developers see the applications of their own workspaces**: the App Builder home, Recent, the workspace dashboard,
  boilerplates on Create and the theme and library applications offered for subscription all show the **current
  workspace** only. Opening an application of another workspace (any builder page under it, also by typing its URL)
  answers *Not found*. Administrators see every workspace.
- **The current workspace** is shown in the status bar. Developers with more than one workspace switch in the
  account menu (the circle with your initials); opening one of their applications from another workspace switches too.
- **New applications** (Create, from a file, pasted data, existing tables, a blueprint) and **imports** go into the
  current workspace; a working copy stays in its main application's workspace. Imports made with the command line
  (`pgkiln import`) go into Default. Exports don't carry the workspace.
- **Workspace utilities**: tiles for users and sign-in, application groups, the App Gallery, developers, the SQL
  Workshop and the dashboard (and, for administrators, instance settings, workspaces, AI and mail services and the
  installation), with **Cross Application Reports** in the side column (APEX: Cross Application Reports), each over
  every application of the current workspace: *Application attributes* (type, sign-in, availability, build status,
  debug level, language, database role), *Build options*, *Developer comments*, *Authentication* (sign-in methods,
  identity providers, LDAP, access, the login page, Forgot password), *Authorization schemes*, *Password items* and
  *Theme summary*.
- Workspace utilities → **Workspaces** (administrators): add a workspace (you become its first developer), rename it,
  choose its developers, move applications to another workspace and delete an empty workspace.
- **Workspace administrators**: on a workspace's page, administrators tick which of its developers administer it. A
  workspace administrator opens the page from Workspace utilities (the card names the current workspace) and changes
  its name, description and developers; isolation, database roles, moving applications and deleting stay with the
  installation's administrators.

A **shared** workspace (the default) is not a security boundary between developers who write SQL: its SQL Workshop
runs as pgkiln's owner, and its application code (processes, regions, validations) runs on the shared runtime
connection, from which SQL can reach other shared applications' data and metadata. Make a workspace **isolated** when
its developers must not reach other teams' applications or data.

### Workspace message and environment banner

Administrators and the workspace's administrators set them on the workspace's page (*Manage service*, or the
Administration menu → *Workspace message and environment banner*; APEX: Define Workspace Message, Define Environment
Banner): a **message** (plain text, up to 2000 characters) shown to the workspace's developers on the
[Workspace home](#workspace-home) (where they can also edit it in place) and the App Builder home,
and an **environment banner**: a label of up to 40 characters in one of eight colours, shown at the top of every
builder page while the workspace is current.

### Workspace preferences

Administrators and the workspace's administrators set them on the workspace's page (Administration menu →
*Workspace preferences*; APEX: Set Workspace Preferences):

- **Enable the SQL Workshop**: off, every SQL Workshop page (the SQL Worksheet, the Object Browser, SQL scripts, Load and
  Unload Data, Quick SQL, the query builder, Sample Data, DDL, Compare, AI) answers *403* while the workspace is
  current, for every developer including administrators; the rail and Workspace utilities no longer show it. A
  developer who belongs to another workspace can still use it there. Turn it off for a workspace whose developers
  should build applications only, for example a shared workspace, where the SQL Workshop runs as pgkiln's owner.
- **Enable RESTful services**: off, the [REST modules](13-rest-api.md#rest-modules-in-the-builder) of the workspace's applications answer
  *404* at `/a/<alias>/rest/…` (also their OpenAPI description); they can still be edited, and they come back
  when it is turned on again. PostgREST is not affected.

Both are on by default (migration 093) and are not exported.

- **Builder links open** (sprint 109, migration 119): what an address of just `/builder` (a bookmark from before the
  Workspace home) opens in this workspace: the **App Builder** (the default: it is also at `/builder/apps`) or the
  **Workspace home** (a redirect). Signing in always opens the Workspace home. It travels in a
  [workspace export](#export-and-import)'s settings.

### Extension links

Links to the other tools a workspace's developers use (monitoring, a wiki, a ticket system; APEX: Manage Extension
Links), added on the workspace's page by administrators and the workspace's administrators: a label, an `http://` or
`https://` URL, an optional description and an order. While the workspace is current an **Extensions** icon in the
rail opens them, each in a new tab (`rel="noopener noreferrer"`).

#### Scheduling with pg_cron

(sprint 101; Database Actions: Scheduling) **SQL Workshop → Scheduling** (administrators only) manages the jobs of
[pg_cron](https://github.com/citusdata/pg_cron), the PostgreSQL extension that runs SQL on a schedule inside the
database server. pgkiln needs pg_cron 1.4 or later, created in pgkiln's database; the page says what is missing when
it isn't (the package, `shared_preload_libraries = 'pg_cron'`, `cron.database_name`, `create extension pg_cron`).
Without pg_cron it lists **pgkiln's own scheduled work** read-only: every application's automations (Shared Components
→ Automations, [chapter 6](06-processing.md)) with their schedule, next and last run, and the latest background process
jobs. With pg_cron that list is behind a toggle under the jobs.

- **Jobs** (`cron.job`): name, the command, the schedule with its meaning in words (*At 02:00, every day*), the **next
  run**, the last run's status and time (and how many of the last ten failed), database and the role it runs as;
  a search field. Times are in pg_cron's time zone (`cron.timezone`, GMT unless set). pg_cron shows each role only its
  own jobs: when pgkiln's owner connection is neither a superuser nor `BYPASSRLS`, the page says so.
- **Create job** / **Edit**: name (unique per role), database, *Run as* (a role that can sign in; only a superuser
  schedules for another role), *Active*, the command (SQL, run outside a transaction block as pg_cron runs it, so
  `vacuum` works) and the **schedule**: five cron fields, `n seconds` (1 to 59) or `@hourly` … `@yearly`, `@reboot`.
  A **schedule builder** (one field each for minute, hour, day of month, month and day of week, `$` for the last day
  of the month) and **common schedules** fill it in; the **preview** shows it in words with the **next five runs**,
  as you type (without JavaScript: the *Use* and *Preview* buttons). pgkiln explains schedules as pg_cron reads them:
  lists, ranges, steps, month and day names, 7 for Sunday, and a day matching either the day of month or the day of
  week when both are restricted.
- **Review SQL** shows the statements (`cron.schedule_in_database`, `cron.alter_job` with only what changed, an
  `update cron.job` for a new name; the command dollar-quoted); **Apply** runs them in one transaction and only if they
  are still what was reviewed. **Disable / Enable** (`cron.alter_job(…, active := …)`) applies at once and shows the
  statement; **Unschedule…** (`cron.unschedule`) after a review. Every change goes to the activity log (event `cron_job`).
- **Run now**: pg_cron has no run-now, so pgkiln runs the job's stored command once itself: a new connection to the
  job's database with the owner connection's login, `SET ROLE` to the job's role (the owner must be allowed to), no
  transaction block around it, a 10-minute statement timeout. The page shows the result, the duration and notices.
  The run is not in pg_cron's history; the activity log has it (event `cron_run_now`).
- **Run history** (`cron.job_run_details`, newest first, 200 at most): status, start, duration and message, filtered
  by job, status or a text in the message or command. **Purge…** deletes runs older than 7, 30 or 90 days, or all
  (of every job or one), after showing the `delete` and how many runs it removes: pg_cron keeps every run until then.

## Export and import

Workspace utilities → **Export and import** (`/builder/workspace-export`; APEX: Workspace Utilities → Export), for
administrators and the workspace's administrators: the current workspace's components as one JSON file (format
`pgkiln-workspace/1`), to copy them to another workspace or installation or keep them in version control next to the
applications' files. Choose what goes in:

| Component | In the file |
|---|---|
| Settings | Description, [workspace message, environment banner](#workspace-message-and-environment-banner) and [preferences](#workspace-preferences) |
| Developers | User names and who is a workspace administrator (never passwords) |
| Application groups | Names, descriptions and the aliases of their applications |
| Extension links | Label, URL, description, order |
| REST source catalogs | Every [catalog](19-rest-data-sources.md#rest-source-catalogs) with its services |
| SQL scripts, blueprints, data generators | The SQL Workshop's saved work |
| Data Reporter datasets | Every [dataset](#data-reporter-datasets-and-reporting-applications) (sprint 110) |
| Team Development | [Label groups, labels, milestones, templates and issues](#team-development) with their comments and history; an issue's application by alias (sprint 113) |

Never in the file: the workspace's name, its [isolation](#isolated-workspaces) and database roles, its
[mail service](#a-workspaces-own-mail-service) and [network access list](#network-access) (installation-specific, like
isolation), passwords and secrets, script runs and other history. **Applications are exported on their own** (an application's *Export*).

**Import** reads such a file into the current workspace, for the components you choose. Components with a name the
workspace already has are kept, or replaced with *Replace components with the same name*; nothing is deleted. A
developer is added only when this installation has a developer of that name (add them under *Developers* first); an
application group takes the workspace's applications with those aliases. The import is one transaction: a value the
installation refuses (an invalid URL, a catalog service that doesn't pass the checks) changes nothing, and the page
says what was added, kept and replaced.

### Workspace utilization

Administration menu → **Workspace utilization** (`/builder/workspaces/<id>/utilization`; APEX: Workspace
Utilization), for administrators and the workspace's administrators: the number of applications, pages, developers,
page views of the last 30 days and SQL scripts; per application its pages, regions, items, page views, users and the
size of its static files; and the schemas the workspace's database roles use with their tables and storage.

### Isolated workspaces

On a workspace's page an administrator chooses **Isolate this workspace** (Workspace utilities → Workspaces → the
workspace → *Isolation*). It needs `RUNTIME_DATABASE_URL` (applications don't run on the owner connection) and
`PGKILN_SECRET_KEY` (the passwords of the workspace's logins are derived from it; nothing is stored). Then:

- **Two PostgreSQL logins of its own**: `pgkiln_ws<id>_run_<suffix>` runs its applications (pages, processes, REST
  handlers, automations, workflows, background processes, REST synchronisation); `pgkiln_ws<id>_dev_<suffix>` runs its
  developers' SQL: the SQL Worksheet, SQL Scripts, Quick SQL, Load and Unload Data, Sample Data, DDL and Compare, the
  Advisor, code checks and document previews. SQL that runs `RESET ROLE` (or `set_config('role', …)`) only gets back to
  that login, which can use the workspace's database roles and nothing else.
- **The workspace's database roles** (APEX: workspace schemas): isolating gives the workspace the roles its
  applications run as; administrators add or remove roles on its page. Its applications can run only as these roles,
  so an import or a changed *Database role* setting that names another role is refused. A role belongs to one
  workspace; a superuser, a role that creates roles or bypasses row-level security, and pgkiln's own roles can't
  belong to one. A **new application** in an isolated workspace gets a new role and a new schema (owned by that role),
  or a schema of one of the workspace's roles. The developer login starts as the first role (alphabetically), so the
  tables a developer creates in the SQL Workshop belong to an application role; `set role` picks another of them.
- **pgkiln's own tables** (`meta`) show each login its own workspace's applications, pages, sessions and accounts
  (row-level security), and the shared runtime connection no longer sees the isolated workspace's.
  `meta.app_id()` refuses another workspace's application, so `meta.web_request`, `meta.ai_generate`, mail, push
  and `meta.page_url` can't act for it. The developer login has no rights in `meta`.
- **The SQL Workshop's saved work** (scripts and their runs, blueprints, sample data generators) belongs to the
  workspace it was made in, also in shared workspaces; data load definitions are listed for the current workspace's
  applications.
- **Administrators keep the owner** in the SQL Workshop, and a developer who also belongs to a shared workspace has the
  owner's rights there: make the developers of an isolated workspace members of that workspace only.
- A workflow step's SQL runs on the workspace's login and commits just before the workflow's own state, so after a
  crash between the two a step can run again.

Still installation-wide: user accounts (an account with access to an isolated workspace's application is visible only
to that workspace, other accounts to every workspace), identity providers, LDAP directories, mail and AI services, the
REST API through PostgREST (use REST modules for isolated applications), and the database catalog (any login can read
table and function definitions in `pg_catalog`, not their rows). Every login of every workspace counts towards the
server's `max_connections`: each isolated workspace opens at most `PGKILN_WORKSPACE_POOL_SIZE` (5) connections per
login and server process.

**Make shared** undoes it: the roles go back to the shared runtime connection and the workspace's logins can no
longer sign in. Delete a workspace only when it is shared and empty; its logins are dropped with it.

## The builder window

Every builder page has the same frame, modelled on an IDE:

- **The icon rail** on the left: Home (the [Workspace home](#workspace-home); the logo leads there too), App Builder,
  SQL Workshop, [App Gallery](#app-gallery), [Data Reporter](#data-reporter-datasets-and-reporting-applications), **Search** (on the
  pages of an application); at the bottom the **Administration** menu (Workspace utilities; for administrators of the
  current workspace *Manage service*: [workspace message and environment banner](#workspace-message-and-environment-banner),
  [workspace utilization](#workspace-utilization) and the workspace's page; Manage users and groups, Developers,
  Monitor activity, [Database users](#database-users) for administrators, Change my password), Help, and your account menu (the circle with your initials) with the
  **builder theme** (*Dark*, the default; *Light*; or *System*, which follows the operating system),
  Change password and Sign out. The theme is remembered on this device, also after signing out;
  it only changes the builder, not your applications.
- **The toolbar** at the top: a back button, the breadcrumb and, in the page designer, the page
  tools.
- The pages of an application have tabs under its name: Pages, Shared Components, Activity, REST
  API, Settings, Search and Advisor, with Export and Run on the right.

- **The status bar** at the bottom: who is signed in, the current [workspace](#workspaces), the database, the
  [builder language](#choosing-the-builder-language) (a menu) and the pgkiln version.
- **An environment banner** (when the current workspace has one) across the top: a coloured band with a label such as
  DEVELOPMENT or TEST, so nobody mistakes one environment for another.

On phones the rail gets narrower and the breadcrumb shows only the current page.

The builder's look comes from design tokens at the top of `public/builder.css` (sprint 105): CSS custom properties
for colours (a warm neutral palette with the kiln's ember for primary buttons, links, focus rings and selections),
surfaces and their shadows, corner radii, the type scale and transitions, in a light and a dark set; the code editor's syntax colours (`--ce-*`: keywords, strings, numbers, comments, binds,
quoted names, operators, the matching bracket, the current line, the selection and the line numbers) are tokens there
too (sprint 108). The rail, the
toolbar and the status bar stay dark in both themes. Transitions are switched off when the operating system asks
for reduced motion. The builder uses the system's fonts (Inter when it is installed); it loads nothing from
other sites.

(sprint 86) An address under `/builder` that leads nowhere (a deleted application or page, a typo, an
application of a workspace you are not a member of) shows a **Page not found** page in the builder's
theme with a link to the App Builder home; a server error shows **Something went wrong** (the error
is in the server log, not on the page). Scripts get the plain answers they always got.

### Choosing the builder language

(sprint 121, APEX: the builder's language links) The builder speaks **Deutsch, English, Español, Français, Nederlands
and Português** (Brazilian). English is the default.

- **On the sign-in page** the languages are links under the form: choosing one shows the sign-in page in that
  language and, when you then sign in, stores it as your builder language. The choice is remembered on this device
  (a cookie), so the sign-in page keeps it after you sign out.
- **When signed in**, the language in the status bar at the bottom is a menu: pick another language and the page
  you are on comes back in it.

The language is stored **per developer** (in your developer account), so it follows you to every session and every
device; other developers keep their own. It only changes the builder: your applications have their own languages
(chapter 7).

What is translated: the builder's frame (the rail, the top bar and its search, your account menu, the status bar,
standard messages and error pages), the sign-in page, the Workspace home, the App Builder home, an application's
home page and its tabs, the Page Designer's toolbar, menus, component tree, panes and gallery, the SQL Workshop's
home page and tabs, (sprint 123) the **SQL Worksheet** (with its messages in the browser), the **Object Browser**
and **Table Properties**, and (sprint 124) **Shared Components** (the overview, every component type's list and
editor frame, access control, breadcrumbs, component settings) and an application's **Settings**, and (sprint 125)
the administration screens: **Users** (accounts and identity providers), **Developers** and **Workspaces** (with
utilization). Other builder pages are still in English (they move over screen by screen); so are the
Page Designer's property names and their help (and, the same way, the field names and help of a shared component's
form), the links to this guide, and any SQL the builder generates.

## Workspace home

(sprint 109; APEX: the workspace home page) The page the builder opens after signing in, `/builder/home`, above the
App Builder and the SQL Workshop. Everything on it is of the current [workspace](#workspaces), and it works without
JavaScript. The [default-password banner](#signing-in-and-developer-accounts) stays on top until the password is changed.

- **Tool cards**: App Builder (`/builder/apps`), SQL Workshop (not when the workspace's preferences turn it off),
  **Data Reporter** (when the server has the Data Reporter tool at `/builder/reporter`) and the [App Gallery](#app-gallery).
- **Workspace message**: the [workspace message](#workspace-message-and-environment-banner), plain text. The
  workspace's administrators (and the installation's) edit it in place with **Edit message**; empty removes it.
- **Summary**: the number of applications (opens the App Builder), tables in the schemas the workspace's database
  roles may use (opens the Object Browser), developers (opens Developers) and reporting applications (applications
  made by [Data Reporter](#data-reporter-datasets-and-reporting-applications) → *Create reporting application*; opens
  the Data Reporter).
- **Activity**: **Top applications** (page views and users), **Top users** and **Top developers** (page views by the
  workspace's developers and the installation's administrators in its applications) over **1 hour**, **1 day** (the
  default) or **1 week**. The timeframe is remembered for each developer (`meta.developer.home_timeframe`).
- **System message**: the pgkiln version the server runs and, when the [release check](#the-release-check) is on and
  a newer release is out, **pgkiln X is available** with a link to its release notes and how to upgrade (back up,
  install the new version, `pgkiln migrate`, restart).
- **A side column**: About, **Team Development** ([open issues](#team-development), those assigned to you, unseen
  mentions of you, or *Set up Team Development* before it is set up), **Learn more** (this guide, the [tutorial](10-tutorial.md),
  [Coming from APEX](11-from-apex.md), the changelog and the discussions on GitHub) and Resources.

### The release check

Off by default. When it is on, the server asks GitHub's releases API (`api.github.com`) for the latest pgkiln release,
at most once a day per server process (an hour after a failure), with a 5-second timeout and a 1 MB limit; nothing
about the installation is sent. Pages never wait for it: they show what was fetched last and refresh it in the
background. Administrators turn it on or off on the Workspace home (**Check for new versions**, **Check now**,
**Turn off**) or on Workspace utilities → **Instance settings** → *New versions* (*On*, *Off*, or *As the environment
says*: the variable `PGKILN_RELEASE_CHECK`, [chapter 1](01-installation.md#configuration-reference)). Leave it off on a server
that may not reach the internet. Under the test runner the server never asks GitHub.

## App Builder home

The App Builder's home page, `/builder/apps` (`/builder` shows it too, unless the workspace's
[preferences](#workspace-preferences) send `/builder` to the Workspace home), is laid out like APEX's App Builder:

- **Four tiles**: **Create** and **Import** (each on its own page), the workspace **Dashboard**
  (applications, pages, active accounts; page views, users, failed sign-ins and errors of the last
  24 hours, and per application the last 7 days with a link to its Activity page) and
  **Workspace Utilities** (users, identity providers, LDAP directories, password policy,
  developers, the SQL Workshop, and for administrators [workspaces](#workspaces), AI services and the
  [installation log](#installation)). The list, the dashboard and Recent show the current workspace.
- **The applications**, as a report (application id, name, alias, pages, page views of the last 24
  hours, sign-in, last updated, **updated by**, **working copies**, and Edit / Run) or as cards. **Search** filters the list as you type
  (by name, alias or id; without JavaScript, press Enter). Click a column heading, or use
  **Actions**, to sort. The view and the sort are remembered until you sign out.
- (sprint 116) **Updated by** is the developer who changed the application last in the builder (any change to its
  pages, shared components or settings; locks and comments don't count) or who created, imported or copied it;
  *Updated* is the later of that change and the application's own settings. An import with `pgkiln import` or the
  MCP server changes *Updated* only. **Working copies** counts the application's [working copies](#working-copies)
  and links to them. A **lock icon** after the name shows that the application is [locked](#page-locks-and-comments),
  with its owner in the tooltip (and for screen readers). The cards show the same as small badges. On phones the
  report keeps the id, the name with the lock and the actions.
- **A side column** (on the right on wide screens, below the list otherwise): About, **Recent** (the
  applications you opened last) and Tasks.
- **The workspace message**, when the workspace has one, above the tiles.
- **Application groups**: when the workspace has [groups](#application-groups), a select next to the views shows one
  group; each application shows its group.

### Application groups

Workspace utilities → **Application groups** (`/builder/app-groups`; APEX: Application Groups) organises the
applications of the current workspace into named groups: add, rename and delete groups, and choose each
application's group. The App Builder home then filters by group. Groups belong to the workspace, not to the
applications: they are not exported, an in-place import keeps them, and an application moved to another workspace
leaves its group. Every developer of the workspace manages them.

## App Gallery

The **App Gallery** (the cube in the icon rail, `/builder/gallery`; APEX: App Gallery) has four tabs, each with
the number of its apps. The search field filters the tab's cards as you type (without JavaScript it searches on the
server, `?q=`); every word must be in the title or the description.

- **Sample Apps**: applications shipped with pgkiln, each with its own schema, data and **demo account with a known
  password**, so install them on a development or demo instance only. Administrators install them; they go into the
  current workspace (an isolated workspace gets the application's role too). An installed one shows Run, and Edit
  in its own workspace (*in another workspace* elsewhere). They are:
  - **HR Demo**, the showcase of nearly every feature (the same scripts as `pgkiln migrate --example hr`), and
    **Tasks**, the [tutorial](10-tutorial.md);
  - single-topic apps (sprint 120; APEX: Sample Charts, Sample Cards, Sample Calendar, Sample Interactive Grids,
    Sample Dynamic Actions, Sample Reporting), small apps that show one feature area with a text on every page that
    says how it is made: **Sample Charts** (all 22 chart types on a page per question, and a drill-down),
    **Sample Cards** (cards, KPI tiles, lists as cards, built-in template components), **Sample Calendar** (the
    four views, create on click, drag and drop through a function), **Sample Interactive Grids** (an editable grid,
    select lists, totals, a frozen column, a row menu, master-detail, the grid's views), **Sample Dynamic Actions**
    (show and hide, values from the server, refresh, messages, a wait popup, classes, an inline dialog) and
    **Sample Reporting** (interactive report, faceted search, smart filters that also read a phrase, a classic report
    with column options and a column template); and (sprint 122; APEX: Sample Maps, Sample Approvals, Sample Data
    Loading, Sample File Upload and Download) **Sample Maps** (markers and clusters, layers with GeoJSON and a heat
    map, a map that filters a list by distance, a location item, without PostGIS), **Sample Approvals** (a form
    starts a workflow: approved by itself below 1,000, otherwise an approval task decided under My tasks; the
    workflow console; accounts **demo** and **approver**), **Sample Data Loading** (`data_load` processes by column
    name, through a data load definition and skipping bad rows, with example files to download) and **Sample Files**
    (a file in the record's columns, several files in a child table, a photo cropped before upload);
  - the **UX Pattern Catalog** (APEX: the Universal Theme app): region templates and template options, button
    styles, item types and form layouts, alerts, badges, colour classes, lists, media lists, timelines, comments,
    avatars, metric cards, empty states, a dialog, a drawer and a side column, each named by its template, option
    or class to copy from.

  Each single-topic app and the catalog is one SQL file in `examples/gallery/samples/`, run in one transaction (a
  failing script leaves nothing behind); sign in with **demo** / **demo**. Outside the builder:
  `psql "$DATABASE_URL" -1 -f examples/gallery/samples/sample-charts.sql`.
- **Starter Apps**: small applications (Team Tasks, Contacts, Expense Claims, Asset Inventory, Event Registrations)
  shipped as [blueprints](#creating-an-application-from-a-blueprint). **Install** opens the blueprint's review:
  nothing is created before you confirm, the application gets a new role and schema in the current workspace, and you
  may edit the blueprint first (another alias, more columns). Any developer installs them.
- **Utility Apps** (sprint 120; APEX: Utility Apps): applications a workspace *uses* rather than learns from, shipped
  as blueprints and installed like starter apps, by any developer, into the current workspace:
  **Lookup Lists** (the lists of values several applications share, kept as data, with the grant and the list of
  values query another application uses), **Release Notes** (the releases of your applications and their changes)
  and **Announcements** (maintenance, outages and releases for the workspace, with the query that shows the current
  ones in another application).
- **Custom Apps**: the workspace's boilerplate applications (Application type *Boilerplate*): *Create from it* opens
  Create with that boilerplate chosen.

The list is `examples/gallery/gallery.json` (see `examples/gallery/README.md`); add your own starters and utilities
there as blueprint files. A request only ever names a key of that list, never a file.

Why two install paths: a blueprint can only describe tables, generated pages and sample rows, and creating one needs no
more than a developer's rights (pgkiln writes the DDL). The sample apps need what blueprints can't say (chart kinds,
dynamic actions, template options, PL/pgSQL functions), so they are SQL scripts, and running shipped SQL as the owner
is for administrators.

## Data Reporter: datasets and reporting applications

**Data Reporter** in the icon rail (`/builder/reporter`, sprint 110; APEX 26.1: Data Reporter as a workspace tool)
gives business users reports on the workspace's data without a developer writing a page per question. Every
developer of the workspace manages it; the page lists the workspace's **datasets** and its **reporting
applications** (with their users and published reports).

A **dataset** (`meta.dataset`, per workspace) is a trusted view of the data: tables and views of one schema, joined,
the columns users may see, and a row filter.

- **New dataset**: choose a schema (those your [SQL Workshop](#sql-workshop) connection may use; never pgkiln's own
  or the system's), tick tables and views (the first is the main one) and give it a name (lower case, it can't
  change) and a label. **Joins are proposed from foreign keys** in either direction (a left join on the key's
  columns); every column is offered, labelled from its name, numbers with a number mask.
- **The dataset's page**: its label and description; the tables with their joins (to an earlier table, left or
  inner, *on* `column = its column`; add a table, remove one); the **columns** (offer or not, a name reports use, a
  label, a [format mask](14-globalization.md) and a description users see in the report editor); up to five
  **row filter** conditions (column, operator, value) that every report on it gets; the **query** it builds, and a
  **preview** of ten rows (read only, through your SQL Workshop connection). The dataset is checked against the
  database when it is saved: tables, views and columns must exist; the page says what doesn't match (any more).
- **Download** one dataset or **Export all** as a file (`*.dataset.json`, format `pgkiln-dataset/1`); **Import**
  reads such a file (or pasted text) in one transaction: each dataset is checked against this installation's
  database, and one with the same name is kept unless you choose *Replace*. Datasets also travel in the
  [workspace export](#export-and-import); they are not part of an application's export.

**Create reporting application** (on a dataset's row or page: the form is filled in, so *Create* is the second
click) makes an application of type *Reporting* on one or more datasets: page 1 is a
[Data Reporter](04-pages-and-regions.md#data_reporter-data-reporter) region offering the datasets, users sign in with
their accounts of the [user directory](#users-the-user-directory), and the first administrator is the account you
name (yours by default). Its database role `app_<alias>` may only **read** (SELECT) the datasets' tables and views,
so every report runs through those grants and [row level security](08-security.md) (a view with
`security_invoker` needs grants on its own tables too: grant them to the role yourself). Give accounts access and
roles under the application's *Users and roles*:

| Role | May |
|---|---|
| viewer (or no role) | Open published reports (by their stable URL too), pin them |
| editor | Also build reports, save them, publish and unpublish their own |
| administrator | Also unpublish and delete anyone's reports |

The application is an ordinary pgkiln application otherwise: change its pages, theme or sign-in in the builder as
you like. `meta.reporting_app_count(workspace_id)` counts a workspace's reporting applications.

### Creating an application

**Create** (a tile, or `/builder/create`) is one page, like APEX's Create Application wizard. Links at the top
start from a file, pasted data, a blueprint or the App Gallery instead. Then:

| Section | Field | Meaning |
|---|---|---|
| Data | Pages on the tables of | The parsing schema: an existing schema, or a new, empty one named after the alias. (sprint 87) Choosing a schema lists its tables under Pages at once, with the name and alias proposed for it (unless you already typed them); without JavaScript, *Show its tables* does it |
| Application | Name | Display name, shown in the header. Proposed from the schema and selected when you click it, so typing replaces it |
| | Description, Icon | Shown on the home page's hero and the About page |
| Appearance | Theme style, Navigation, Accent colour | Iris, Lavender or Standard; a side or top menu; an own accent colour |
| Pages | a page type per table | *Interactive report with form*, *Faceted search*, *Cards*, *Calendar* (a table with a date column), *Master detail* (a table another table refers to), *Interactive grid*, *Report* or *No page*. Tables with a single-column primary key get a modal form with their report, faceted search, cards and calendar; views and tables without such a key can't have a form or a grid. Proposed: a report with form, an interactive grid for a table of more than 100,000 rows, a report for a view. (sprint 87) A table with [row level security](08-security.md) shows *RLS · n* (its number of policies), or *RLS, no policies* in red: the application's role would see no rows. *Dashboard*: a chart per table |
| Features | | *About page* (in a Help menu), *Access control* (authorization schemes `CONTRIBUTOR` and `READER` next to `ADMIN`, for the roles admin, contributor and reader), *Activity reporting* (page 9010 for administrators: page views per day and the latest activity, from `meta.app_activity`), *Feedback*, *Theme style selection* (users may choose light or dark), *Install as an app* (PWA) and *Push notifications* (needs `PGKILN_SECRET_KEY`) |
| Settings | Alias | Lowercase URL name: `inventory` gives `/a/inventory`. (sprint 87) It follows the name as you type it (*Café Orders* → `cafe-orders`) until you change it yourself |
| | Authentication | *App users* (a login page and a user list), *HTTP header* (a trusted reverse proxy names the user, see [chapter 8](08-security.md#http-header-authentication-reverse-proxy)), *Database accounts* (PostgreSQL login roles and their passwords, see [chapter 8](08-security.md#database-accounts-postgresql-roles)), *Custom* (your own PL/pgSQL function, see [chapter 8](08-security.md#custom-authentication-a-plpgsql-function)) or *None* (a public app) |
| | First user / Password | The first user; they get the `admin` role. An existing account is reused (its password isn't changed). (sprint 87) Hidden while Authentication is *None* |
| | Language | The application's primary language |
| Advanced | Start from | Shown when there are **boilerplate** applications (Settings → Application type): their pages, shared components and settings are copied into the new application, which keeps its own name, alias, role and authentication ([application types](#application-types-and-subscriptions)) |

Creating the app also:

- creates the database role `app_<alias>` with `SELECT/INSERT/UPDATE/DELETE` on all tables,
  `USAGE` on sequences and `EXECUTE` on functions in the schema, plus **default privileges**,
  so tables you create later (as the owner, e.g. in the SQL Workshop) are usable by the app straight away;
- creates page 1 *Home*, a navigation entry, and an authorization scheme `ADMIN` (role `admin`); (sprint 88) the home
  page is a hero with the name and icon on the page background and a card per page, each with a colour band and its
  icon in a round badge; the version is *Release 1.0*;
- shows a progress message while it works and then opens the new application's page in the builder,
  with what was created (and anything left out) as a message.

Everything is created in one transaction: when a page can't be made, nothing is.

The parsing schema can't be `meta`, `information_schema` or a `pg_*` schema.

### Creating an application from a file

**Create → From a file** (`/builder/create/file`, APEX: *Create App from a File*) starts an
application from a spreadsheet:

1. **Upload** a CSV or TSV file (UTF-8 or Windows-1252; the delimiter is detected), an Excel `.xlsx`
   file (every sheet with rows becomes a table, see [several sheets](#several-sheets-or-tables-in-one-file)),
   JSON (an array of objects; an object with several arrays becomes several tables) or XML, up to `DATA_LOAD_MAX_MB` (50 MB) and
   `DATA_LOAD_MAX_ROWS` (100,000 rows). Untick *First row contains column names* when it doesn't.
2. **Check the proposal**: a preview of the first rows; the application's name, alias, parsing schema,
   authentication and first user (as for a blank application); the table name (`employee_list.xlsx`
   → `employee_list`) and, per file column, a few sample values, the column name (`Hire Date` →
   `hire_date`; empty skips the column) and the type inferred from the values (text, integer, bigint,
   numeric, boolean, date, timestamp: dates and timestamps in ISO format). Choose the pages:
   - always: page 2, an interactive report of the table, with a modal form (page 3) to create, change
     and delete rows;
   - *Dashboard* (page 4): a bar chart with the number of rows per value of the first text, yes/no or
     date column whose values repeat (2 to 50 different values); left out when there is none;
   - *Faceted search* (page 5): a report with a filter panel: values with counts for repeating text
     and yes/no columns, ranges for numbers and dates, and a search field.
3. **Create application**: in one transaction, the schema and the role `app_<alias>` (as above), the
   table in the app's schema with an identity primary key `id`, the rows, and the pages (made with
   `meta.generate_page`, the [page wizards](#create-page-wizards)) with a navigation entry each. When a
   row doesn't fit its column's type, **nothing is created**: the form comes back with the failed
   rows (the first 100) and your choices; fix the types, or tick *Skip rows with errors* to load the
   others (the result page lists the skipped rows).

Everything is a plain form (no JavaScript needed). The file is kept as a temporary file of your
builder session between the steps; it is deleted when the application is created. To load more files
into the table later, use the SQL Workshop's [Load Data](16-files.md#sql-workshop--load-data) or a data load definition.

#### Several sheets or tables in one file

An Excel workbook with several sheets (empty sheets are left out; at most 20), or a JSON object with
several arrays of objects (`{"departments": [...], "employees": [...]}`), gives step 2 a section per
sheet:

- **Create a table from this sheet**: untick to leave the sheet out;
- **Table name** (from the sheet name: `Order Lines` → `order_lines`), and the column names and types as above;
- **Primary key**: a file column, or a new identity column `id`. Proposed: a column named `id`,
  `code`, `<table>_id`, `<table>_code` or `<table>_no` (singular or plural) with a value in every row,
  all different. A whole-number key becomes the table's identity key (new rows continue after the
  highest loaded value); another key (a text code) becomes `not null unique` next to a new `id`.
- **Foreign keys** (one list under the sheets): a column is proposed as a foreign key to another
  table's key when it is named like the key column (`dept_id` → `departments.dept_id`), like the
  other table and its key (`department_id` → `departments.id`, `project_code` → `projects.code`) or
  like the other table alone (`department`), with a compatible type. A proposal is ticked when every
  value is found in the other table, otherwise it shows how many rows don't match. Untick what you
  don't want. After changing table or column names or keys, press **Update the proposals**: the
  form is redrawn (nothing is created yet).

**Create application** then creates, in one transaction: the app, the tables, the rows, the foreign
keys (added after all rows are loaded, with an index on each foreign key column; a value that isn't
found stops everything with the row's key in the message), an interactive report with a modal form
per table (forms get a select list for each foreign key), a navigation entry per table, and with
*Dashboard* one page with a chart per table (at most six): the rows per parent row for a table with a
foreign key, otherwise per value of a column whose values repeat.

### Creating an application from pasted data

**Create → From pasted data** (`/builder/create/paste`, APEX: *Copy and Paste*): paste rows copied
from a spreadsheet (tab-separated) or CSV text (comma, semicolon or `|`; detected) into the text
area, give it a name (it proposes the application and table names) and press *Next*. The text is
kept as a temporary file of your builder session and takes the same steps as an uploaded file. At
most 4 MB of text; upload larger data as a file.

### Creating an application from existing tables

**Create**, then a schema under *Data* (`/builder/create?schema=…`; pgkiln's `meta`,
`information_schema` and the `pg_*` schemas aren't offered): each table and view gets a page type
under *Pages* (above), or *No page*. The application gets that schema as its parsing schema and a role
`app_<alias>` with the grants of a blank application on the schema (so **all** tables of the schema,
not only the ones with pages). The pages are made with `meta.generate_page`, with a navigation entry
each; and optionally a dashboard (a chart per table, as above;
for existing tables the repeating values come from the planner statistics, so `ANALYZE` a table that
was never analyzed). Everything is created in one transaction. Foreign keys to tables in another
schema show in forms as select lists that the app's role may not be allowed to read: grant it, or
pick a schema that holds them all.

#### What the generated pages look like

The wizards (every *Create application* flow and the page wizards) make pages that read like APEX's:

- **Labels**: names become words. `snake_case` and `camelCase` are split, run-together words are
  recognised (`hiredate` → *Hire Date*, `deptno` → *Department Number*) and common abbreviations are
  expanded (`emp` → *Employee*, `dept` → *Department*, `sal` → *Salary*, `comm` → *Commission*, `mgr` →
  *Manager*, `qty` → *Quantity*, `desc` → *Description*, `pct` → *Percent*, `crm` → *CRM*, `id` → *ID*).
  A foreign key column drops its `_id`/`no` suffix (`deptno` → *Department*), and a column named after
  the table's first letter drops it (`emp.ename` → *Name*). A short `COMMENT ON COLUMN` (one line, at
  most 60 characters, no full stop) is the label; a longer one becomes the item's help text. A short
  `COMMENT ON TABLE` names the pages.
- **Plural and singular**: report pages, cards and the navigation menu use the plural (*Employees*),
  forms and dialog titles the singular (*Employee*).
- **Reports** show a foreign key's parent by its display column (a name, title or label, else its first
  text column): *Manager* shows KING, *Department* shows SALES. The key itself stays in the query,
  hidden, so filters can use it; a report never has two columns with the same heading (also a faceted
  search report, whose facets filter on the display column). A row starts with a pencil that opens the form.
- **Interactive grids** (the grid page and both grids of a master-detail page) use the same labels as
  headings (*Department Number*, *Hire Date*); a foreign key is a select list of the parent's names.
- **Files**: a `bytea` column becomes one file upload item that also fills the columns that go with it
  (`<col>_name`/`_filename`, `<col>_mime`/`_mime_type`, `<col>_size`, `<col>_updated`; or `filename`
  and `mime_type` next to the only `bytea` column). Reports leave these columns out. Columns named like
  *photo*, *image* or *logo* accept pictures only.
- **Numbers** get a format mask with group separators (and the scale's decimals for `numeric(p,s)`),
  in reports, read-only grid cells and forms alike, in the application's language (*2,850.00*); keys get none.
- The **Dashboard** comes right after *Home* in the menu; its charts are titled *Employees by Manager*
  (a count) or *Salary by Department* (the sum of an amount column: salary, total, price, cost, value…),
  a donut for six groups or fewer, a line for a date, else a sorted bar; a grouping that says nothing (one
  group, or every group the same size) is left out. Rows without a value are labelled *(none)*, and bar charts show the ten largest values (the rest is
  one *Other* bar). Tables with row-level security are left out (the application's role may see none of
  their rows); the result page says which.
- The **Home** page has a hero with the application's icon and name, and a card per page of the menu
  (a list `HOME_PAGES`, Shared Components → Lists). A blank application gets the hero only.
- An **About** page (page 9000: the application's description, or the pages of its menu) in a **Help**
  menu of the header's navigation bar (a list `NAVBAR`, the application's navigation bar list).
- New applications use the **Iris** base style in the **light** theme; users may switch to dark.

### Creating an application from a blueprint

**Create → From a blueprint** (`/builder/blueprints`; APEX 26.1: *Blueprints*, spec-driven
development) describes a new application as a JSON document, a **blueprint**, and creates it only
after you have reviewed what it does. A blueprint names the application (name, alias, schema,
sign-in) and lists:

- **tables** with their columns: a type (`text`, `integer`, `number`, `date`, `timestamp`,
  `boolean`), `"required"`, `"unique"`, `"values"` (the allowed texts, a check constraint) and
  `"references": "table"` (a foreign key, with an index). Every table gets an `id` identity primary
  key, so don't list one;
- **pages**: the [create page wizards'](#create-pages-from-a-table-wizards) types on a table of the
  blueprint (`report_form` with a `form_page`, `grid`, `form`, `cards`, `calendar`, `chart`, `map`,
  `facets`, `master_detail`) or `blank` pages with a text; without pages, a report and form per
  table. `"dashboard": true` adds a page with a chart per table;
- optionally the **navigation** (`[{"label", "page", "icon"}]`, replacing the pages' own entries) and
  **sample data** (`[{"table", "columns", "rows"}]`; give parent rows an `id` so child rows can refer
  to it).

```json
{"blueprint": 1, "name": "Projects", "alias": "projects", "schema": "projects",
 "tables": [{"name": "project", "label": "Projects", "columns": [
              {"name": "name", "type": "text", "required": true, "unique": true},
              {"name": "status", "type": "text", "values": ["Planned", "Active", "Done"]}]},
            {"name": "task", "columns": [{"name": "project_id", "references": "project", "required": true},
                                         {"name": "title", "type": "text", "required": true},
                                         {"name": "due", "type": "date"}]}],
 "pages": [{"type": "report_form", "table": "project", "page": 2, "form_page": 3, "label": "Projects"},
           {"type": "calendar", "table": "task", "page": 4, "label": "Due dates"}],
 "sample_data": [{"table": "project", "columns": ["id", "name", "status"], "rows": [[1, "Website", "Active"]]}]}
```

The editor starts with an example. With the [App Builder's AI service](#app-builder-ai), **Draft a
blueprint** turns a description into one (only the description is sent); the draft replaces the
editor's text and is not saved or created. **Review** checks the blueprint (names, types,
references and their order, page numbers, sample rows; problems are listed) and shows what it will
create: the application, the tables with their columns and sample row counts, the SQL, the pages
and the menu. **Create the application** (with the first user for an application with a login page)
then creates the schema and role (as for a blank application), the tables, the rows and the pages
in **one transaction**: if anything fails, nothing is created. Creation only accepts the blueprint
text the review showed you (it is signed with your session); change it and review again. **Save**
keeps a blueprint in the list (`meta.blueprint`, with the application last created from it).

**From an application** (on the Blueprints page; APEX 26.1: a blueprint from an application) opens a blueprint of an
application of the current workspace in the editor, for a copy, a new version or a test system:

- **tables**: the tables its regions read (a form's table, the first `schema.table` after `FROM` in a query) that the
  application's database role may read, with their columns: types (integers, numbers, dates, timestamps, booleans,
  text; other types become text, binary columns are left out), *required* (NOT NULL without a default), *unique*
  (a one-column unique constraint), allowed values (an enum, or a `CHECK (col IN (…))`) and references to another of
  these tables' `id`. Every blueprint table gets an `id`: an old key with another name stays a required, unique column,
  and a reference to it a plain column;
- **pages**: a report with its form page becomes `report_form`, and grids, cards, calendars, charts, maps, faceted
  searches and forms keep their type and page number; other pages become `blank` pages with their name;
- **navigation**: the menu entries of those pages;
- **sample rows** only when ticked: up to 20 per table, read read-only through the application's developer
  connection. They are copied into the blueprint as they are, so leave this off for personal or confidential data.

The new name, alias and schema end in *copy*; a list of **notes** says what didn't carry over. Nothing is created
until you review and confirm it, as for any blueprint.

### Importing

**Import** (a tile, or `/builder/import`): paste the JSON of an export and optionally give a new
alias. **Check the application before importing** (ticked) runs the [Advisor](#advisor) on the
imported application before anything is saved: errors (a missing table, column or function, a wrong
type, a missing grant) refuse the import and are listed. A directory export (one file per component)
is imported with `pgkiln import` ([chapter 18](18-cli.md#checking-before-an-import)). Imported apps keep the database role
of the export; check it under **Settings**, and create users under **Shared Components**. An
application with [supporting objects](#supporting-objects) opens on their page after the import:
they are **not** run until you choose to.

## App dashboard

(sprint 74) Above the pages: a **search** by page name or number (the rows filter while you type),
**Report** and **Icons** views, and **Create page** (the page wizards below). **Tasks** on the right: run the
application, create pages (also with AI), Shared Components, page groups, export, backups, supporting
objects, lock or delete the application.

The **default-password** warning shows on the App Builder home (and Developers) only; dismiss it with × until the
next sign-in. The avatar keeps a red dot until the password is changed.

Open an application to see its pages, with region/item/dynamic-action/process counts,
authorization and protection. The tabs under its name lead to **Shared Components**, **Activity**,
**REST API**, **Settings**, **Search** and **Advisor**; **Export** and **Run** are on the right.

### Create pages from a table (wizards)

The wizards are two plain forms (they work without JavaScript). On the app's Pages tab, choose a
**page type** and a **table or view** (tables the app's database role can't read are marked) and
press **Next**. The second step proposes everything from the database catalog: the columns, the
primary key, date and number columns, positions and foreign keys. Change what you like, choose the
page number, name and menu icon, and press **Create page**: the builder opens the new page in the
page designer. An error (a page number in use, a column that doesn't fit) shows on the second
step, which keeps the table and type.

| Page type | What is generated | Proposed from the catalog |
|---|---|---|
| **Report and form** | An interactive report page listing the table (with an edit link per row and a Create button) and a **modal dialog** form page with Create, Apply Changes and Delete, a form DML process, fields per column (foreign keys become select lists, booleans become switches, NOT NULL columns without default become required) and a navigation entry | |
| **Interactive grid** | One page with an editable grid (foreign keys become select lists, NOT NULL columns become required), a grid DML process and a navigation entry | |
| **Form** | One form page (normal or modal) with the chosen columns, Cancel / Delete / Apply Changes / Create and a form DML process; the buttons return to a page you choose (default: the home page). No navigation entry unless you tick it | All columns except binary ones; NOT NULL columns without a default are always included |
| **Cards** | A [cards](04-pages-and-regions.md#cards) region with a title, subtitle, body and badge column | Title: a name, title or label column; subtitle: the first foreign key (showing the parent's name) or the next text column |
| **Calendar** | A [calendar](04-pages-and-regions.md#calendar) region (month, week, day and list views) | Start: a date or timestamp column named like *start*, *begin* or *…_date* (not *created*/*updated*); end: one named like *end* or *until*; title: a name column, else the first foreign key's name |
| **Chart** | A [chart](04-pages-and-regions.md#chart) region: bar, column, line, area, donut, pie or funnel of the row count, or the sum, average, minimum or maximum of a number column, per label | Label: the first foreign key (its parent's name), else a text column that isn't unique |
| **Map** | A [map](04-pages-and-regions.md#map) region with popups and, if ticked, an interactive report of the same rows that the map filters (*Show this area in the list*) | Position: a PostGIS geometry or geography (markers, and lines and areas as shapes), a `point`, `lat`/`lng`-like number columns, or a *location* text column with `latitude,longitude` |
| **Faceted search** | An interactive report (9 columns wide) and a [facets](04-pages-and-regions.md#facets-faceted-search) panel (3 columns, collapsible) with a search field | Up to six facets: foreign keys (values of the parent's name, which the report shows instead of the key), booleans, text columns with few values, dates and numbers as ranges with *from*/*to* |
| **Master detail** | One page with a grid of the table and an editable grid of the selected row's details below it (the grids' [master-detail](04-pages-and-regions.md#grid-interactive-grid)): a hidden item for the selection, both grids with a grid DML process; new detail rows get the master's key | The detail table: a table with a foreign key to this table's primary key |

Cards, Calendar, Map and Faceted search take an optional **Form page** number: it adds a modal
form page for a row, a link from each card, event, popup or report row, and a **Create** button
(on a calendar also a **+** on every day and hour, with the start date filled in). A calendar can
also get **drag and drop**: an `UPDATE` of the start (and end) column as the app's role, so row
level security applies; set the region's `move_authz` to limit who may move events.

Report and form, Interactive grid, Form, a Form page and Master detail need a single-column
primary key; the other types also work on views. Make sure the app's database role has privileges
on the table (automatic for its own schema): the second step warns when it hasn't. The same
generators can be called from SQL with [`meta.generate_page`](09-reference.md#functions-for-developers-and-scripts).

**Create pages with AI** (below the wizard; needs the [App Builder's AI service](#app-builder-ai)):
describe the pages you want in your own words (*"a page to manage employees, a calendar of leave
and a chart of salaries per department"*). The AI service proposes pages of the wizards above: a
page type, a table or view the application's database role can read, a page number (and a form
page for *Report and form*) and a menu label, each with a one-sentence reason. Nothing is created
yet: check the proposals, change the type, table, numbers or labels, untick what you don't want,
and **Create the ticked pages**. They are made with `meta.generate_page` and the wizards' defaults,
in one transaction (all or none); only page types of the list and tables the application can read
are accepted, whatever the form says.

### Create a blank page

Give a page number, name, mode (normal or modal dialog) and breadcrumb parent, then add
components in the page designer.

### Page groups

**Shared Components → Page groups** (APEX: Page Groups) names groups of pages, e.g. *Employees*,
*Leave*, *Administration*; each page joins one with its **Page group** property (Page Designer →
Page → Appearance). The application's page list then has a *Group* column and a filter: all pages,
one group, or the pages without a group. Renaming a group renames it on its pages, deleting it takes
them out of it; the Advisor reports a page in a group that doesn't exist. Groups travel with the
application (export, import, working copies) and change nothing when it runs. The HR example puts
its pages in four groups.

## The page designer

(sprint 86) A page's address in the page designer is its application's id and its number:
`/builder/apps/<app id>/pages/<page number>`, with `?c=region-<id>` (and so on) for the selected
component, so a link names the page you mean. The older `/builder/pages/<internal id>` still works:
a browser that opens it is sent to the page's number.

The page designer has three panes, as in APEX's Page Designer. From 1024 pixels wide they sit
side by side; on phones and portrait tablets they are tabs (**Tree**, **Layout**, **Properties**):
choosing a component opens the Properties tab.

- **Left: the component tree**, with four tabs:
  - **Rendering**: the page, *Pre-Rendering* (branches, computations and processes that run
    before the page is shown), the regions by
    [display position](04-pages-and-regions.md#side-columns-and-display-positions) (Banner, Breadcrumb bar,
    Left column, Body, Right column, Footer: the page template's positions and any other that has regions)
    with their items and buttons (by [button position](04-pages-and-regions.md#button-positions): *Buttons*,
    *Buttons: Next*, …), and page-level items and buttons;
  - **Dynamic actions**, grouped by event (change, click, page load);
  - **Processing**: computations after submit, validations, processes and the branches (the
    [branch components](06-processing.md#branches) in sequence, then the buttons that go to
    another page);
  - **Shared components** the page can use (lists of values, authorization schemes, navigation,
    application items), linking to Shared Components.

  Icons show which components have an authorization scheme, a condition or a build option; type icons are coloured
  by kind (regions, items, buttons, dynamic actions, processes). Folders open and close
  with a click; with the keyboard, the arrow keys walk the tree (Left / Right close and open a
  folder), Enter opens a component.

  **Right-click** a region, item or button in the Rendering tree (or press <kbd>Shift</kbd>+<kbd>F10</kbd> or the
  menu key) for its menu (APEX: the tree's context menu): *Create page item*, *Create button* (in the region),
  *Create dynamic action*, *Create region below*, **Duplicate** (a copy right after it; a region comes with its
  items and buttons, names get `_2`), **Copy to other page…** (to the end of a page of the same application; items
  named `P<n>_` get that page's number, a region's buttons and items come along, references in SQL are not changed),
  *Expand all below*, *Collapse all below*, (sprint 90) **Comment out** and *Delete*. The arrow keys move through the
  menu, Escape closes it. **Comment out** (APEX's) leaves a component (a region, item, button, dynamic action,
  validation, process, computation or branch) out of the page without deleting it: it gets the
  [build option](#shared-components) `COMMENTED_OUT`, made with the status *Exclude* when first needed, and is struck
  through in the tree; **Uncomment** takes it off again (another build option of the component is left alone).
  APEX's *Create Sub Region* is not there: pgkiln has no nested regions.
- **Middle: the Layout**: the page template's display positions as labelled zones (Banner, Breadcrumb bar,
  the side column of a side-column template beside the Body, Footer), each with its regions on the 12-column
  grid, each region with its items and its buttons in their button positions, as they will be placed on the page; under it a **gallery** of region types, item types
  and button actions. The middle pane also has a **Page search** tab (searches the application)
  a **Lock and comments** tab ([below](#page-locks-and-comments)) and a **Help** tab (layout keys and the substitution cheat sheet). Zoom in, zoom out and
  maximize (hides the side panes) are above the layout.
- **Right: the property editor** for the selected component, grouped (Identification, Source,
  Layout, Security, …) with help text for each property. Type in **Filter** to show only the
  properties whose name contains the text (Escape clears it); click a group's name to fold it
  (remembered on this device). **Common** / **All** (APEX: Show Common / Show All) shows only the properties
  most often set for regions, items and buttons, or all of them (remembered); **Go to group** jumps to a group
  (opening the Attributes tab when the group is there). **Template options** open in a dialog from a button that
  counts the chosen ones; they are saved with the other properties. Under the properties, the **Help** pane (APEX: the Help tab) shows the
  property that has the focus (or the pointer): its help, the name it is stored under in exports and
  application files, and a link to the guide section of the component's type.

The toolbar has the page switcher (previous, the page number: type or step to one and press Enter, a list of
all pages, next), **Undo** / **Redo** of
layout changes, the **Create** menu (region, item, button, dynamic action, computation, validation,
process, branch, or a new page), a **Utilities** menu (Advisor, search, shared components, all pages, export),
**Save** (saves the property editor; it is highlighted when there are unsaved changes) and **Run**
(opens the page in a new tab). Changes are live as soon as they are saved.

### Page locks and comments

APEX's page locks and developer comments, for teams. In the page designer's **Lock and comments**
tab a developer **locks** the page (with an optional note); on the application's page (**Pages**,
under the list) they can lock the **whole application**. While it is locked, other developers' changes
to it are refused (with a message, or `423` for JSON requests) and the designer says who locked it
and since when; the page list shows a lock column. Locking an application refuses changes to every
page, the settings, shared components and deleting it. Only the developer who locked it or an
**administrator** unlocks it; an administrator breaking another developer's lock is logged in the
activity log (`lock_broken`). Running the application, the SQL Workshop and the command line are
not affected.

**Comments** are notes for the team on a page or the application: any developer adds one, the
author or an administrator deletes it. The page list counts each page's comments. A page that gets
another number keeps its lock and comments. Locks and comments belong to this installation and
are not exported.

**Make an issue** under a comment turns it into a [Team Development](#team-development) issue about the same page;
the comment then links to its issue. A page with open issues shows them above the designer's tabs (*1 open issue:
…*, with *New issue* for that page), and the application's page list tags such pages (*2 issues*).

### Arranging the layout

Regions are placed in sequence order; a region's *column span* (1–12) sets its width, and a
region that no longer fits starts a new row.

- **Drag a region** by its header to another place, or drag its right edge to make it wider or
  narrower.
- **Drag a region into another position** (zone) to set its display position: e.g. a faceted search into
  the *Left column* of a page with the Left side column template.
- **Drag an item or button** to another place in its region, to another region, or to *Page level*. While a
  button is dragged, a region's empty [button positions](04-pages-and-regions.md#button-positions) (Create, Edit,
  …, Previous, Next) show as drop targets; dropping it there sets its position.
- **Drag an entry of the gallery** onto the layout to create that component there, with a working
  starting point (a sample query for reports, charts and cards; a name like `P5_NEW` for items);
  then set its properties on the right. Clicking a gallery entry instead opens the create form
  with that type filled in.
- **Without a mouse**: focus a component on the layout and press <kbd>Alt</kbd>+<kbd>↑</kbd> /
  <kbd>↓</kbd> to move it, or <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>←</kbd> / <kbd>→</kbd> to make a
  region narrower or wider. The **Arrange** bar above the properties does the same with buttons
  (move up, move down, narrower, wider, or move an item or button to another region); on phones and
  tablets this is the way to arrange things.
- **Undo** and **Redo** in the toolbar take back the last 20 layout changes on this page (moving
  and resizing, display and button positions too; creating, duplicating or copying a component starts a new
  history).

Without JavaScript the panes are shown one under the other, every component is a link and the
Arrange buttons still work.

### The code editor

Every field that holds code (region sources, conditions, lists of values, validations,
processes, dynamic actions, the JSON attributes, document templates, workflow steps, REST
handlers, the SQL Workshop and the import box) opens in a small code editor:

- **Syntax highlighting** for SQL and PL/pgSQL (keywords, types, strings, comments, `:ITEM`
  binds, `&ITEM.` substitutions, `$$` bodies), JSON and HTML (tags, attributes, `&ITEM.` and
  `{{tags}}`). The language follows the component type: a `static` region's source is HTML, a
  `regex` validation is plain text, an `execute_sql` dynamic action is PL/pgSQL.
- **Line numbers**, the line and column of the cursor, the **current line** (a band and its number in bold
  while the field has the focus) and the **matching bracket** marked.
- **Colours from the builder's theme** (sprint 108): keywords take the kiln's ember, types, functions, strings,
  numbers, binds and quoted names cool hues, comments a muted grey, each at least 4.5:1 (WCAG AA) on the editor's
  background in the light and the dark theme. Read-only SQL (the Object Browser's DDL and source tabs, the Data
  Modeler's DDL, generated SQL in Quick SQL, Query Builder, Scheduling, Database Users and the table editor, the SQL
  Monitor's text, a saved chart's query, the Change Log, a script's results) is highlighted the same way.
- **Tab / Shift+Tab** indent and outdent (the selected lines, too); **Enter** keeps the
  indentation and indents after `(`, `begin`, `loop`, `then`; brackets and quotes are closed for
  you and typing the closer steps over it. Press **Escape, then Tab** to move on to the next field.
- **Suggestions**: press **Ctrl+Space** (or the **Suggest** button on a touch screen), or just
  type: after `schema.` the schema's tables, after `alias.` or `table.` its columns, after `:` the
  page's items, the application items and built-ins like `APP_USER`, after `&` the same as
  substitutions. Tables named in `from`/`join` and their aliases put their columns first.
  **Up/Down** choose, **Enter** or **Tab** insert, **Escape** closes.
- **Check** plans the SQL like the [Advisor](#advisor) does, as the application's role
  (`explain`, rolled back, nothing runs), and shows the problem under the field.

Suggestions only list what the **application's database role** may use: schemas it has `usage`
on, tables, views and columns it has a privilege on, and functions it may execute (an
application without its own role uses the runtime connection's role). The SQL Workshop lists
what the owner connection sees. The list is cached for 30 seconds and refreshed when you run
something in the SQL Workshop.

The editor only decorates the normal text field: the form posts the same text as before, undo,
copy and paste work as usual, screen readers read the plain field (the suggestion list is
announced as you move through it), and without JavaScript you get the plain field.

**Report regions** also get a **Report settings** form on the property editor's **Attributes** tab
(the editor reopens the tab you used last), so the common
settings need no JSON: rows per page, search, Actions menu, sorting, saved and public reports,
and per column its heading, whether it's shown, whether it's printed and its PDF width, plus the
link column (page and items), row selection (value column and item) and the PDF layout. The columns are read from the region's query
(run with `limit 0` as the application's role and rolled back). Saving writes the region's
*Attributes (JSON)* and keeps any other keys there.

The other region types with settings get a similar form, under the same rules (defaults are left
out, other keys are kept, columns the query no longer returns stay listed so you can clear them):

| Region | Settings form |
|---|---|
| `grid` | Rows per page; whether users may add, change and delete rows; per column its heading, shown, read-only, required and "Edit as" (a shared list of values); aggregates in the footer, frozen columns, the Actions menu, saved and public grid reports, the row actions menu (edit link, duplicate, delete) and master-detail (the master's column and item, the detail's item and column) |
| `chart` | Chart type (also Gantt, pyramid, polar, range, box plot and stock, with the columns each expects), the text when there are no rows, the gauge's range and thresholds, and the drill-down link (page and items, `#column#` and `#series#`); lists the query's columns |
| `cards` | Cards or KPI tiles, the text when there are no rows, and the link (page and items) |
| `calendar` | The views and the one shown first, the hours of the week and day views, the edit link of each event, the create-on-click link (`#start#`, `#end#`, `#date#`), and drag and drop (the SQL with `:EVENT_ID`, `:NEW_START`, `:NEW_END`, the key column, who may drag); warns when the query lacks `start_date` or `title` |
| `facets` | The report region it filters and a search field on/off; per column of that report: facet on/off, label, type (checkboxes, ranges, star rating), values shown, exclude, ranges (`..1000; 1000..3000 = Middle; 3000..`), from/to, a chart of the counts (bar or pie) and order |
| `smart_filters` | The same per-column facets, the suggestions per facet and the search field's placeholder |
| `display_selector` | Tabs or a select list, "Show all", remember the choice; per other region of the page: in a tab and the tab name (saved in that region's settings) |
| `ai_assistant` | The AI service (those the application may use), system prompt, welcome text, placeholder, error message, tool rounds per question, questions per conversation, public or not, and the context queries and tools as JSON (checked when saving: query shapes, parameter types, REST data sources and authorization schemes that exist) ([AI assistant](04-pages-and-regions.md#ai_assistant-ai-assistant)) |
| `report` (also) | *Ask in your own words (AI)*: off, the built-in phrases or an AI service, and the placeholder of [Ask in your own words](04-pages-and-regions.md#ask-in-your-own-words-ai-interactive-reports) |
| `data_reporter` | Data sources (a table or view each: static id, label, description, offered columns with labels and format masks; or (sprint 110) a dataset of the workspace), who may share, build and moderate reports, publishing, rows per page ([Data Reporter](04-pages-and-regions.md#data_reporter-data-reporter)) |
| `form_designer` | Who may design forms (an authorization scheme), data sources (a table or view each: static id, label, description, key column, may add / change / delete rows, offered columns with labels and lists of values), rows per page ([Form Designer](04-pages-and-regions.md#form_designer-form-designer)) |

Links, lists of values and the facets' report are checked when saving: a form can only point to
pages and shared lists of values of the same application, and to report regions on the same page.

Page properties:

| Property | Meaning |
|---|---|
| Page number, name, title | The title supports `&ITEM.` substitutions |
| Page mode | *Normal*, or *Modal dialog* (opens over the calling page) |
| Breadcrumb parent | Builds the breadcrumb trail (and the highlighted menu entry) |
| Requires authentication | Uncheck for public pages in an app with a login |
| Authorization scheme | Who may open the page |
| Page access protection | *Arguments must have checksum* (default): item values in the URL are only accepted from links pgkiln generated. *Unrestricted*: anyone may set this page's items through the URL |

Chapters 4–7 describe every component type and property.

## Developer toolbar

While you are signed in to the builder, the pages of your applications show the **developer
toolbar** when you run them in the same browser (APEX: the Runtime Developer Toolbar): a compact bar
centred at the bottom, each tool an icon with a short text (*Home*, *App 12*, *Page 3*, *Session*,
*Debug off*, *Quick edit*, *Customize*, *Info*) and a tooltip; on narrow screens, docked at the left or
right, or with *Icons only* in Settings, just the icons. It isn't shown to anyone else, nor inside
dialogs. The page keeps room for it, so it never covers the menu's last entry or a report's pager.
After a few seconds without use it shrinks to a slim tab at the edge; point at it or Tab to it to
bring it back. **Settings** (the last icon) docks it at the bottom, top, left or right, turns the
hiding off and shows *Icons only* (kept in your browser). It has:

| Entry | Does |
|---|---|
| **App Builder** | Back to the builder |
| **Application *n*** | The application's page in the builder |
| **Edit page *n*** | This page in the Page Designer |
| **Quick edit** | (with JavaScript) Point at a region, item or button of the page (it is outlined) and click it: it opens selected in the Page Designer, in the builder's tab (APEX: Quick Edit). Click the button again or press Esc to stop |
| **Session** | The **session state viewer**: the user, roles, session id, language, time zone and debug level; the values of this page's items, the application items and the items of other pages in the session. A password item's value is never shown. *Clear the items of page n* empties this page's items in the session (APEX: Clear Cache) |
| **Customize** | The application's Theme Roller in the builder |
| **Info** | The application, the page, the user and the developer |
| **Debug** | Records [debug messages](06-processing.md#debug-messages) for **this session only**, at the chosen level, while the application itself stays out of debug (*Application (n)* when the application has a level of its own). *View debug* opens the recorded requests |

How it knows you: signing in to the builder gives the browser a second, separate random token for
the applications' pages (the cookie `pgkiln_devbar`, path `/a`, HttpOnly). A page shows the toolbar
when that token belongs to a live builder session of a developer who may open the application (an
administrator, or a member of its workspace). The token does nothing else; signing out of the
builder ends it.

## Backups

**Backups** (in an application's header; APEX: Application Backups) are exports of the application
that this installation keeps:

- one **before every import that replaces it** (`pgkiln import --replace`, the MCP server, a working
  copy's merge, a restore), with who did it;
- one **a day** when the application changed since its newest backup (the scheduler);
- the ones made with **Back up now** (with a note).

The newest *Backups to keep* (default 25; 0: none at all) are kept. Each can be **downloaded** (the
JSON export, to import elsewhere or keep in git) and **restored**: a restore is an import over the
application, so the version it replaces becomes the newest backup and the restore can be undone the
same way. Backups belong to the installation: they are not exported, and an import over the
application keeps them. Restores are logged in the activity log (`backup_restored`).

Workspace utilities → **Manage backups** (`/builder/backups`; APEX: Manage Backups) shows the backups of
every application of the current workspace on one page: how many, how many are kept, the newest and
whether the application changed since, and their size, with a link to each application's Backups.
**Back up now** there makes a backup of every application of the workspace that keeps backups (by
default only of those changed since their newest backup), with a note.

## Availability and build status

**Availability** (in an application's header; APEX: Application Availability and Build Status) says
who may use the running application:

| Status | Who |
|---|---|
| Available | Everyone who may sign in (the default) |
| Available to developers only | Developers signed in to the builder in the same browser (they see the [developer toolbar](#developer-toolbar)); others see the message |
| Restricted | The users named (case-insensitive) and developers; others sign in and are told the application is not available to their account |
| Unavailable | Nobody: every page, and the sign-in page, shows the message (HTTP 503) |

The **message** (for example *"We are upgrading; back at 14:00."*) replaces a standard text in the
user's language. Pages, file downloads, REST modules and the PostgREST API follow the status;
automations, workflows, background jobs and queued mail keep running.

**Build status** *Run only* makes the builder refuse every change to the application (pages, shared
components, settings, restores) as if it were locked, until it is set back to *Run and build* here.
`pgkiln import --replace` still deploys it, so production can be Run only while releases come from
git. Availability and build status belong to the installation: exports leave them out, a new import
is *Available* and *Run and build*, and an import over the application keeps them. Changes are
logged in the activity log (`availability`). A badge in the application's header shows a status
other than *Available* and *Run and build*.

A deployment with a maintenance window:

```sh
# Availability: Unavailable, "Back at 14:00"   (the builder, or SQL on meta.app)
psql -f migrations/042_orders.sql                 # the database changes
pgkiln import apps/sales --replace --check        # the application, checked
# Availability: Available
```

## Feedback

Users tell the developers what they think, from the running application (APEX: Feedback). Switch it
on under Application → Activity → **Feedback** (*Users can send feedback*): the navigation bar gets a
**Feedback** link that opens a page about the page the user was on. They choose *Comment*, *Idea* or
*Problem*, an optional rating (1–5 stars) and write up to 4000 characters; below the form they see
their earlier feedback with its status and your answer. The page's own access rules apply, and a
session sends at most 10 a hour.

On the builder's **Feedback** page you read it (newest first, filtered by status and kind; with the
user, page, rating and browser), set its status (*Open*, *In progress*, *Done*, *Declined*) and write
an answer the user sees. Answering is allowed while the application is locked or Run only. The
setting travels with the export; the feedback itself belongs to the installation.

**Make an issue** turns an entry into a [Team Development](#team-development) issue of the application's workspace
(title from its first line, the feedback quoted, linked to its page, labelled *Bug* for a problem and *Feature* for
an idea when the workspace has those labels); open feedback becomes *In progress*, and the entry links to its issue.

## Team Development

(sprint 113, migration 122; APEX: Team Development) An issue tracker for the developers of a
[workspace](#workspaces): **Team Development** on the icon rail (`/builder/team`) and a block in the
[Workspace home](#workspace-home)'s side column with the number of open issues. Everything is of the current
workspace and works without JavaScript.

- **Set up** installs sample data, like APEX's set-up wizard: the label groups *Type* (Bug, Feature, Task) and
  *Priority* (High, Medium, Low), issue templates (*Bug report*, *Feature request*, *Task*), canned responses and the
  milestones *1.0*, *1.1* and *Backlog*. What the workspace has already (by name) is kept, so it can run again.
  The samples are in English; other languages are added in `src/team-samples.ts`.
- **Issues** have a title, a description in Markdown (rendered safely: raw HTML is shown as text, links are http,
  https, mailto or relative), *Open* or *Closed*, labels, a milestone, assignees (the workspace's developers and the
  installation's administrators), and optionally an application of the workspace and one of its pages. Comments are
  Markdown too; *Comment and close* does both. **@name** mentions a developer of the workspace: they see it under
  *Mentions of you* (and on the Workspace home) until they open the issue or mark them seen; no mail is sent. Every
  change is in the issue's history (who changed the title, labels, milestone, assignees, link or status, and when).
  An issue is deleted by its author or a workspace administrator.
- **The list** filters by status, label, milestone, assignee (*Me*, *Nobody*), application and a search of the title
  and text (or `#12` for issue 12). **Save view** keeps the filters under a name, for you only.
- **The board** shows the issues as columns of cards, by the labels of one label group (a card moved to *High*
  loses *Medium*; *None of these* removes the group's labels) or by milestone. Each card has a *Move* form, so it
  works without dragging.
- **Labels** belong to label groups and have a colour from a fixed palette (red, orange, yellow, green, teal, blue,
  purple, gray). **Milestones** have a due date and are open or closed, with the share of their issues closed.
  **Templates** are issue templates (title, labels, text: *Start from a template* on *New issue*) and canned
  responses (*Canned response* → *Insert* above an issue's comment field). Any developer of the workspace adds and
  changes them; only its administrators delete labels, label groups and milestones.
- Issues come from [feedback](#feedback) and [developer comments](#page-locks-and-comments) with **Make an issue**,
  linked both ways. The page designer shows a page's open issues and App Home counts them per page (*Open issues* in
  its Tasks).

Issues and the rest are workspace data: they are not part of an application's export (an in-place import keeps them)
but travel in the workspace's [Export and import](#export-and-import) (*Team Development*): labels, milestones and
templates match by name, an issue by its title and creation time; assignees are kept when they are developers of the
importing workspace and the application link when it has an application with that alias. GitHub synchronisation is
not part of it.

## Working copies

APEX's working copies: a second application to change in isolation, then merge back. On an
application's pages, **Working copies** (top right) lists its copies and **creates** one with a
name; the copy gets the alias `<alias>-<name>` and its own application id. It is the same
application, so it runs against the main application's schema, role and data, and the same users
may sign in to it. It runs no automations or REST synchronisations (the main application does);
web credentials keep working.

Change the copy like any application. Its **Compare and merge** page compares it with the main
application per **component**: the application settings, each shared component (a list of values,
an authorization scheme, a REST data source, …), the navigation menu, each page's settings and each
region, item, button, process and so on. A copy keeps the main application *as it was when the copy
was made* (or last refreshed or merged), so the page tells which side changed what:

| Result | Meaning |
|---|---|
| Copy | changed (added, deleted) only in the copy: the copy's version wins |
| Main | changed only in the main application: its version stays |
| Conflict | changed on both sides, differently: choose **Main** or **Copy** |

**Show** shows a component's differences (lines of the main application with `-`, of the copy with
`+`). Then:

- **Merge into …** writes the result into the main application *and* the copy;
- **Refresh the copy** writes it into the copy only, bringing the main application's changes in
  (conflicts are chosen the same way).

Both keep what belongs to the installation, like `pgkiln import --replace`: users and access,
sessions, saved reports, running tasks and workflows, secrets of web credentials, and the main
application's automation and synchronisation switches (a new automation arrives switched off). A
merge is refused while another developer has locked the main application or a page the merge
changes, and when either side changed after the comparison was shown (compare again). If the
result is not consistent (for example an item kept from one side refers to a region the other side
renamed), nothing is written and the message names the problem. Merges and refreshes are logged in
the activity log (`working_copy`).

**Delete working copy** deletes the copy's application. Deleting the main application leaves its
copies as ordinary applications. Copies of copies are not possible, and working copies are not
exported.

## Shared components

Components used by the whole application. **Shared Components** opens on a grid like APEX's: ten groups
(Application Logic, Security, Other Components, Navigation and Search, User Interface, Files and Reports,
Data Sources, Workflows and Automations, Globalization, Generative AI) with a link and a count per component
type. A type opens its list (`?type=…`): search by name (the rows filter while you type), sort by name,
**Create**, and a row opens its editor. The types pgkiln keeps in the application's Settings (authentication,
security attributes, navigation bar list, user interface attributes, PWA, globalization attributes) open the
right Settings tab. **Breadcrumbs** shows the pages by their breadcrumb parent. **Tree view** (`?view=tree`)
is the earlier page: every component in one rail, with **Access control** next to it.

| Component | Purpose |
|---|---|
| **Access control** | Who may sign in (only listed accounts, or any active account), which accounts have access with which roles, and which identity-provider groups map to which roles |
| **Navigation menu** | Menu entries: label, icon, target page, parent (for sub-menus), authorization |
| **Authorization schemes** | Named access rules, used by pages, regions, items, buttons, processes, dynamic actions and menu entries ([chapter 8](08-security.md)) |
| **Lists of values** | Reusable queries for select lists, referenced as `LOV:NAME` |
| **Application items** | Session variables not on any page, set only by server-side code |
| **Application processes** | Code that runs *after login* or *before every page* |
| **Component groups** | Sets of a library application's components that other applications subscribe to at once ([below](#component-groups)) |
| **Component settings** | Defaults of built-in component types: rows per page, list of values rows, stars ([below](#component-settings)) |
| **Report queries** | Named queries printed as PDF, Excel, CSV, JSON, XML or HTML with `?doc=NAME` ([chapter 16](16-files.md#report-queries)) |
| **Shortcuts** | Named texts: `"NAME"` in static content, help texts and confirm messages ([chapter 2](02-concepts.md#shortcuts-name)) |
| **Application computations** | Computations of (application) items for every page: at sign-in, before every page, after every submit ([chapter 6](06-processing.md#application-computations)) |
| **REST modules** | REST endpoints (method, path, SQL) served by pgkiln, with an OpenAPI description ([chapter 13](13-rest-api.md#rest-modules-in-the-builder)) |
| **Workflows** | Multi-step processes of tasks, SQL, web service calls (invoke API), e-mail, decisions, waits and parallel branches, with versions, draft steps, migration of running instances and a diagram (SVG / PNG download) ([chapter 6](06-processing.md#workflows)) |
| **Task definitions** | Approvals and action tasks: subject, owners, administrators, due date, custom outcomes, the SQL that runs on completion, events and e-mail notifications ([chapter 6](06-processing.md#approvals-and-the-task-list)) |
| **Document templates** | Letters, invoices and other PDFs filled from a query ([chapter 16](16-files.md#document-templates)), with a preview |
| **Build options** | Include / exclude switches for features; pages and their components name one in their *Build option* property, and *Used in* lists them ([chapter 6](06-processing.md#build-options)) |
| **Web credentials** | How the application signs in to web services (basic, API key header, bearer token, OAuth2 client credentials); the secret is write-only and encrypted ([chapter 19](19-rest-data-sources.md#web-credentials)) |
| **REST data sources** | Web service endpoints whose JSON becomes rows for regions and lists of values, with a **Test** button and suggested columns ([chapter 19](19-rest-data-sources.md#rest-data-sources)) |
| **Template components** | HTML templates with placeholders and directives, used as a region type and as report column templates, with a preview; shared as plug-in files ([chapter 4](04-pages-and-regions.md#template-components)) |
| **Data load definitions** | A target table, file format (CSV, Excel, JSON, XML with its row element) and column mapping with transformations, for SQL Workshop → Load Data and the `data_load` process ([chapter 16](16-files.md#data-load-definitions)) |
| **Lists** | Named sets of links (static entries with nesting, badges, conditions and authorization, or a query) for list regions, the navigation menu and the navigation bar ([chapter 4](04-pages-and-regions.md#list-lists)) |
| **Supporting objects** | Install, upgrade and deinstall scripts that travel with the export ([below](#supporting-objects)) |
| **E-mail templates** | Subject, HTML and plain text with `#PLACEHOLDERS#` for `meta.send_mail_template` and the Send e-mail process ([chapter 6](06-processing.md#e-mail-templates)) |
| **Search configurations** | What a search region searches: a table, a query or a list, the columns searched, and the title, subtitle, description, badge, icon and link of each result ([chapter 4](04-pages-and-regions.md#search-search-region)) |

### Application types and subscriptions

APEX 26.1's theme, library and boilerplate applications, and subscribed shared components. Each
application has a **type** (Settings → Application type):

| Type | Meaning |
|---|---|
| Standard | An ordinary application |
| Theme application | Offers its theme (colours, navigation, light/dark settings and the Theme Roller's styles) and its template components to other applications |
| Library application | Offers its lists of values, authorization schemes, build options, template components and lists (with their entries) to other applications |
| Boilerplate application | A starting point: **Create** offers it under *Start from* |
| Reporting application | (sprint 110) Made by [App Builder → Data Reporter](#data-reporter-datasets-and-reporting-applications) on datasets: its users build, publish and share reports |

**Shared Components → Subscriptions** subscribes the application to one of those components: it is
copied now (replacing a component with the same name) and remembered as a subscription. The page
lists the subscriptions with their state (*in sync*, or *differs* when the master or the copy
changed); **Refresh** (one, or all) copies the master's definition again, replacing changes made
here, and **Unsubscribe** keeps the component as it is but forgets where it came from. The
component's own page in Shared Components says where it comes from, with a Refresh button.

On a theme or library application the same page lists its **subscribers**, and **Publish**
refreshes every subscriber of a component at once (an application locked by another developer is
skipped and named in the message). Subscribing, refreshing and publishing are logged in the activity
log (`subscription`). A subscribed list of values that uses a REST data source needs a data source
with the same name in the subscribing application. Subscriptions are links between the
applications of this installation and are not exported (the type is).

#### Component groups

**Shared Components → Component Groups** (APEX: Component Groups, migration 105) names a set of a
theme or library application's components, as `kind:name`: `lov:JOBS, authz_scheme:MANAGER,
build_option:FEATURE_EXPORT, template_component:status_badge, list:SHORTCUTS`. Saving checks that
the application has each one (and keeps its name as the application spells it). Another
application of the same workspace subscribes to the whole group on its Subscriptions page
(*Subscribe to a component group*): each component is copied and subscribed as above, and a member
the library no longer has is skipped and named in the message. Groups are exported with the
application (`shared/component-groups/`).

### Component settings

**Shared Components → Component Settings** (APEX: Component Settings, migration 105) are the
application's defaults for its built-in component types, used where a component sets nothing itself
(`meta.app.component_settings`, exported with the application):

| Setting | pgkiln's default | Bounds |
|---|---|---|
| Reports: rows per page (`report_rows`) | 15 | 1–1,000 |
| Interactive grids: rows per page (`grid_rows`) | 25 | 1–200 |
| Popup lists of values: rows per page (`popup_lov_rows`) | 25 | 1–100 |
| Lists of values: maximum rows (`lov_max_rows`) | 5,000 | 1–50,000 |
| Star ratings: stars (`rating_max`) | 5 | 3–10 |

A value out of its bounds (an edited export, say) is ignored: the default applies.

### Supporting objects

APEX's *Supporting Objects*: SQL scripts that create, upgrade or remove what the application needs
in the database (tables, views, functions, grants, seed data). Add them under **Shared Components →
Supporting objects** with a name, a kind (*install*, *upgrade* or *deinstall*) and a sequence. They
are part of the export (section `supporting_scripts`, and `shared/supporting-objects/` in a
directory export), so an application can be moved with its database objects.

They **never run by themselves**, also not on import (the builder and `pgkiln import` say how many
came along). **Review and run…** opens the *Supporting objects* page: it shows every script and
runs the scripts of one kind on request, in sequence, **as the application's database role**
(so they can only do what that role may: give it `CREATE` on its schema for an install script),
statement by statement in **one transaction**: the first error undoes the whole run. The page then
shows each statement with its result (up to 20 rows) or its error, and the activity log records the
run (`supporting_objects`). Statements may take up to 10 minutes each.

### Static application files

APEX's *Static Application Files*: JavaScript, CSS, JSON, images and fonts that belong to the
application. **Shared Components → Static application files** uploads them (several at once; a
file with the same name is replaced), writes and edits text files in the browser, renames and
deletes them. They are served from the application's own address,
`/a/<alias>/static/<name>`, to anyone (like APEX's `#APP_FILES#`), so don't put secrets in them,
and they are part of the export (section `static_files`, base64; in a directory export the files
themselves under `static/`).

- **Names**: letters, digits, `_`, `-` and `.`, with an extension from a fixed list (`js`, `mjs`,
  `css`, `json`, `map`, `txt`, `csv`, `md`, images including `svg`, fonts, `pdf`, `mp3`, `mp4`,
  `webm`). **No HTML**: a page of your own would run with the application's rights. Up to 5 MB a
  file.
- **Loading them**: *Every page loads* lists the `.js` and `.css` files every page of the
  application includes, in order; a page adds its own under **Page → Appearance → JavaScript and
  CSS files** (APEX's *JavaScript File URLs* and *CSS File URLs*). Scripts load with
  `<script src defer>` after pgkiln's own, stylesheets with `<link>`; a name that is not uploaded
  yet is left out until it is. Renaming a file updates both lists.
- **Caching**: pages link to `…/static/<name>?v=<version>`, which browsers keep for a year; a
  change gives a new version. A link without `?v=` is checked again every time (with an ETag).
- **The Content-Security-Policy stays strict** (`script-src 'self'`): code runs only from these
  files, never inline. An SVG opened on its own is sandboxed, so a script in it never runs.

JavaScript in these files registers functions for the dynamic action
[Execute JavaScript](07-dynamic-actions.md#execute-javascript).

### Plug-ins

**Shared Components → Plug-ins** imports plug-in files (region, item, dynamic action and process
types with their own JavaScript, CSS, template and PL/pgSQL), shows what each one brings and where
it is used, runs its install SQL on request (as the application's role, in one transaction, never
on import), downloads it again and removes it. See
[plug-ins with their own code](04-pages-and-regions.md#plug-ins-with-their-own-code).

## Users (the user directory)

**Builder → Users** lists every account with the applications (and roles) it can use. Create
accounts here (a password is optional for single sign-on-only accounts). Open an account to edit
its name and e-mail, set or remove its password, deactivate or delete it, and grant, change or
revoke access per application. Password changes, deactivation and access changes end the
affected sessions. See [chapter 8](08-security.md#the-user-directory).

**Users → Identity providers** configures OpenID Connect and SAML providers for single sign-on, and **Users → LDAP directories** the LDAP servers passwords can be checked against. Identity providers: issuer,
client ID and secret, claims, automatic account creation. The page shows the redirect URI to
register at the provider, and has a *Test discovery* button. See
[chapter 8](08-security.md#single-sign-on-openid-connect).

## Settings

Settings has tabs (APEX: Edit Application Definition and Security Attributes): **Definition**, **Security**,
**Sign-in**, **User Interface**, **Globalization**, **Errors and Sessions** and **Progressive Web App**. It opens
on Definition (`?tab=…` opens another). *Save settings* saves the first five together and comes back to the tab
you were on. The Security tab shows only the fields of the chosen authentication type (HTTP header, database
accounts or custom).

- **Application**: name, alias, home page, and (sprint 88) the **version** (APEX: Version, e.g. *Release 1.0*): shown
  at the bottom of the application's pages, next to *Back to top*. New applications start at *Release 1.0*; empty: no
  version in the footer.
- **Security**: authentication (*App users*, *HTTP header*, *Database accounts*, *Custom* or
  *None*), the database role, and **debug mode** (shows full database errors to users; development
  only). The state of the [debug messages](06-processing.md#debug-messages) is shown below it,
  with a link to set their level. **Custom authentication**: the function name, or the function body, and the
  post-authentication code ([chapter 8](08-security.md#custom-authentication-a-plpgsql-function)).
- **Sign-in methods**: username and password, and/or the identity providers to offer on the login page; the
  application's own **Login page** (*Create a login page* makes one) and **Offer "Forgot password?"** (with a mail
  service), see [chapter 8](08-security.md#the-login-page).
- **Theme**: the **base style** (*Iris*, the default for applications created from 0.29 on, or *Standard*, pgkiln's
  look until 0.28; see [chapter 14](14-globalization.md#base-styles-iris-and-standard)), accent colour, header colour, *side* or *top* navigation (on tablets and phones the
  menu is always a drawer), a [list](04-pages-and-regions.md#list-lists) as the navigation menu
  (instead of the navigation entries) and as the navigation bar (links in the header), the theme style (automatic, light or dark) and whether users may choose light or dark.
  **Theme Roller** opens the [style variants](14-globalization.md#style-variants-theme-roller): several
  saved styles (colours, font, font size, corners), the default one, and whether users may choose.
- **Globalization**: primary language, translated languages, how the language is chosen, date formats.
- **Security checklist**: whether the app has its own role, debug mode, debug messages, and pages without
  checksum protection or without authentication.
- **Delete application**: removes the definition (not your tables).

**Progressive Web App** (in Settings): installable, offline pages, forms sent offline, the icon ([chapter 17](17-mobile.md)).

## Search and "Used in"

**Search** (in the application's header) looks through every page and component of the
application: names, titles, SQL, conditions, settings JSON and help texts, case-insensitively,
grouped by component type with the matching text marked. Each result links to the component.

Under an **item**, **page**, **list of values**, **list**, **authorization scheme** or **report layout**, a
**Used in** list shows the components that refer to it:

| Target | Found as |
|---|---|
| Item (page or application item) | the name as a whole word: `:P3_ID`, `&P3_ID.`, `"P3_ID"` in links and settings, `v('P3_ID')` |
| List of values | `LOV:NAME` in items and grid columns |
| Authorization scheme | Authorization fields (also negated, `!NAME`) and `"public_reports"` |
| Page | target pages, breadcrumb parents, navigation, `"page": n` in links, `meta.page_url(n, …)` |
| Report layout | `"layout": "NAME"` in report settings |
| List | `"list": "NAME"` in list regions (its entries are listed under the list itself) |

Database code (views, functions, RLS policies) isn't part of the application, so it isn't searched.

## Advisor

**Advisor** (in the application's header) checks the application without running it:

- **SQL:** every region source, list of values, condition, validation, process, computation,
  branch condition, button badge query, dynamic action,
  authorization scheme, application process and automation is planned with `EXPLAIN` as the
  application's database role, with binds as NULL, in a transaction that is rolled back. That
  finds syntax errors, unknown tables, columns and functions, type errors and missing grants.
  `DO` blocks are compiled into a temporary function (syntax). Statements that can't be planned
  without running them (`notify`, `call`, `set`, …) are listed as notes.
- **References:** pages, items, lists of values, authorization schemes, report layouts and
  regions that a component names but that don't exist (also build options, which leave the
  component out, and the items computations set or copy); grids without a key or a save process;
  workflow `invoke_api` steps that name a REST data source, parameter or web credential that
  doesn't exist, leave a required parameter empty or use a `&VAR.` no step sets.
- **PL/pgSQL functions:** when the `plpgsql_check` extension is installed, the functions in the
  schemas the application's role can use are checked with `plpgsql_check_function_tb` (see
  [extensions](15-extensions.md)).

Findings are errors, warnings or notes, each linking to the component.

## Activity monitor

Per application: page views, distinct users and average page time over the last 24 hours;
failed and locked sign-ins; errors and access denials; views and timings per page over 7 days;
and a list of recent events (with *Include page views*). The "reference #123" numbers users see
on errors are the event ids here.

**Debug messages** (APEX: *View Debug*) sets the application's debug level and retention and lists
the requests recorded while it was on: time, page, method and path, user, HTTP status, total time,
number of entries and problems (errors and warnings), filtered by page, user or *only with errors or
warnings*, 50 at a time. Opening one shows its entries with the time since the start of the request,
the duration of timed steps (the slowest is highlighted), the time until the next entry, level,
component and message, with links to the previous and next request. *Delete all debug messages*
empties the list. See [chapter 6](06-processing.md#debug-messages).

**Top SQL** lists the statements the application's database role ran, from `pg_stat_statements`:
calls, total and mean time, rows and share of the total, sortable, with *Reset the statistics*.
Literals appear as `$1`, `$2`…; applications that share a database role share the list. It needs
the server to load the module (`shared_preload_libraries = 'pg_stat_statements'`, set by the
development `docker-compose.yml`) and the extension, which migration 016 creates when it can (as
a superuser; otherwise `create extension pg_stat_statements;` by hand). Reading other roles' query
texts needs `pg_read_all_stats` for the owner role, and resetting needs execute on
`pg_stat_statements_reset`.


**AI usage** shows the [AI services](#ai-services) the application may use, today's requests and
tokens against their daily limits, and the last 100 AI requests (time, page, user, service, model,
source, tokens, duration, status). Prompts and answers are not logged.

## Mail services

Workspace utilities → **Mail services** (administrators): how the applications of this
installation send [e-mail](06-processing.md#sending-e-mail). **Add service** first asks for the
provider (SMTP with a password or OAuth2, Microsoft 365 through Graph, Amazon SES, Resend, Postmark,
SendGrid, Mailgun, or *log only*), then shows that provider's settings only; on a service's page,
*Provider → Change* switches it. A service has the provider's settings, a secret (password, client secret, API key or secret access
key: stored encrypted with `PGKILN_SECRET_KEY`, never shown again, never exported), the **allowed
senders** (addresses, or `@domain`) and a default From address. On a service's page:

- **Applications**: which applications send through it (one service per application), each with
  its From address (one of the allowed senders) and an optional limit per day;
- **Check before saving** (at the end of the form, also while adding a service): *Test connection*
  checks the settings as filled in without sending anything (SMTP: connect, TLS and sign in;
  Microsoft 365: an Entra token; Amazon SES: the account, with its sending quota and whether it is
  still in the sandbox; Resend, Postmark, SendGrid, Mailgun: a read-only call with the key, which also
  shows a key that may not send). *Send test mail* sends one message to the address you give, from an
  allowed sender. An empty secret field uses the stored secret; nothing is saved;
- **Recent mail** of its applications.

Applications → Activity → **Mail** (developers) shows an application's service, today's count
against its limit and the mail of the last 30 days with its status and the provider's answer;
**Send again** queues a failed or cancelled mail again, **Cancel** stops a queued one.

**Microsoft 365.** Register an application in Microsoft Entra with a client secret. For the Graph
provider grant it the application permission *Mail.Send*; for SMTP with OAuth2 the permission
*SMTP.SendAsApp* and register its service principal in Exchange Online. In both cases limit it to the
sending mailboxes (an application access policy or RBAC for Applications).


### Mail queue

Administration menu → **Mail queue** (`/builder/mail-queue`; APEX 26.2: Administration → Mail queue): the delivery
health of the mail queue, for administrators (every workspace, or one) and a workspace's administrators (the current
workspace's applications only; other developers get 403). Filter by period (24 hours, 48 hours, 7 days), workspace and
application:

- **figures**: queued now, retrying now (failed with an error that may pass, waiting for the next of its 5 attempts),
  being sent, sent and failed in the period, the share delivered and the average provider call;
- **Per hour**: queued, sent, failed and retrying mail per hour (UTC);
- **Slowest provider calls**: the 10 longest hand-overs of the period (how long the provider took to accept or refuse
  the mail), with application, service and outcome;
- **Per workspace and application**: sent, failed, retrying and queued mail, the average and slowest call;
- **Failures**: every failed mail (kept 30 days) with the provider's answer, e.g. the SMTP server's
  `550 5.1.1 no such user`. **Retry** queues one again with fresh attempts, **Purge** deletes it; *Retry all failed*
  and *Purge all failed* act on the failures of the filter (never outside the developer's scope).

Bodies and attachments are never shown here. Every action checks again on the server that the mail's application is in
the developer's scope, and is written to the activity log.

### A workspace's own mail service

A workspace's page → *Mail and network access* → **mail service** (`/builder/workspaces/<id>/mail`; APEX 26.1:
workspace-level SMTP credentials), for the workspace's administrators: a mail service of the workspace's own, with the
same providers and checks as [above](#mail-services). The applications of the workspace that an administrator gave no
service send through it (an application an administrator gave one keeps it; a service of another workspace is never
used). Its secret is stored encrypted with `PGKILN_SECRET_KEY` like a web credential's: write-only, never shown, never
exported. It differs from an installation service in two ways that keep it from reaching what the installation
doesn't allow:

- it uses the provider's own API: no API base URL and no token URL (OAuth2 goes to Microsoft Entra of the tenant);
- an SMTP server must be on the installation's allow-list (`PGKILN_REST_ALLOWED_HOSTS`, e.g. `smtp.example.com:587`)
  and the workspace's [network access](#network-access) list, and resolve to a public address (unless
  `PGKILN_REST_PRIVATE_HOSTS` lists it). The server resolves the host once and connects to the address it checked,
  with the host name kept for TLS, on every send and test.

### Network access

Administration menu → **Network access** (`/builder/network`; APEX 26.2: workspace network ACLs), for administrators
(any workspace, `?ws=`) and a workspace's administrators (their workspaces): which web services a workspace's
applications may call. The installation's list (`PGKILN_REST_ALLOWED_HOSTS`, set in the server's environment, shown
read-only; the private hosts to administrators only) applies to every workspace. A workspace can choose **Only the
hosts below**: then every outgoing call made for one of its applications must match one of its entries *and* the
installation's list. A workspace's list only narrows; it can never widen the installation's, and private, loopback and
link-local addresses stay refused unless the installation allows them. Entries are `api.example.com`, `*.example.com`
(its subdomains) or `api.example.com:8443` (that port only); restricted with no entries means no outgoing calls.

It is enforced on the server for every outgoing web call of the workspace: `meta.web_request` and
`meta.web_request_source`, REST data sources (regions, write-back, synchronisation, the assistant), the Invoke API
process and workflow step, web credential token endpoints, object storage of file items, the builder's *Test* of a
source, REST source catalogs read from a URL, and the SMTP server of the workspace's own mail service. Every redirect
hop is checked again, and a REST source's cached response is not served once its host is off the list. A refused call
fails with *The host … is not on the network access list of workspace …*, is written to the application's debug log
(level 2, warning, for `meta.web_request` in a page process; level 1 for regions and processes) and appears under
**Refused calls** (kept 7 days). **Check a URL** says whether a URL may be called, without calling it.

Not covered by a workspace's list: the installation's own services, which only administrators configure (installation
mail services, AI services, the geocoder, sign-in providers) and push notification services (their own list,
`PGKILN_PUSH_HOSTS`).

## AI services

Workspace utilities → **AI services** (administrators only; APEX: *Generative AI services*) lists the
large language model services of this installation. A service has:

- a **name** (upper case, e.g. `CLAUDE`) by which processes, dynamic actions and SQL refer to it;
- a **provider**: *Claude (Anthropic)* or *OpenAI*, called through their official SDKs; *Gemini*
  (Google, through its OpenAI-compatible endpoint `https://generativelanguage.googleapis.com/v1beta/openai/`,
  with the `openai` SDK); or *OpenAI-compatible*: any endpoint that speaks OpenAI's Chat Completions,
  such as Ollama (`http://localhost:11434/v1`), vLLM, Azure OpenAI (`https://<resource>.openai.azure.com/openai/v1/`)
  or a gateway. An OpenAI-compatible service needs a base URL; its key may stay empty for endpoints
  without keys (a local Ollama);
- a **model**, exactly as the provider names it (new Claude services start with `claude-opus-5-5`);
  pgkiln never changes or downgrades it;
- for Claude, the **effort** (how deeply the model thinks; current Claude models always think, lower
  effort is faster and cheaper, new services start at `medium`) and **refusal fallbacks** (when Claude
  declines a request for safety reasons, Anthropic re-runs it on its recommended fallback model; on by
  default, switch it off for models or gateways that don't support it);
- the **maximum output tokens** per request (1–128,000) and a **time limit** (5–600 seconds; pages
  wait for the answer);
- an optional **base URL** for a gateway or proxy that speaks the provider's API (calls to the AI
  service don't go through `PGKILN_REST_ALLOWED_HOSTS`: only administrators set this URL);
- the **API key**: stored encrypted with `PGKILN_SECRET_KEY`, write-only (never shown again, never
  exported or logged, not readable by applications, never sent to the browser). Without one the
  server's `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY` or `OPENAI_COMPATIBLE_API_KEY`
  (by provider) is used.

On a service's page, **Applications** sets which applications may use it, each with optional daily
limits (requests and input + output tokens per UTC day; a request over a limit fails with a message
and is logged as *limited*), and **Test** sends a prompt (logged as a builder test). Below that, and
on the list page for all services, the usage log: the last requests and the totals per application
and service of the last 30 days.

An interactive report's *Ask in your own words* doesn't need a service: without one (or when the
service is disabled or not allowed for the application) pgkiln reads the request with its built-in
phrases ([chapter 4](04-pages-and-regions.md#ask-in-your-own-words-ai-interactive-reports)).

**Prompts go to the provider.** Whatever a prompt contains, including the item values substituted
into it, is sent to the chosen provider (or the gateway of the base URL). Choose providers and
models that your organisation allows for that data. See
[Generate text with AI](06-processing.md#generate-text-with-ai).

## AI agents

Shared Components → Generative AI → **AI Agents** (APEX 26.1 / 26.2: AI Agents and AI Tools) holds an
application's agents and the tools they may use. An agent reasons over a user's request in an
[AI assistant region](04-pages-and-regions.md#ai_assistant-ai-assistant) and acts **only through the
tools you approve**; pgkiln prepares the context, runs each tool call itself under the checks below,
and composes the conversation.

An **agent** has:

- a **name** (upper case, e.g. `SALES_AGENT`) that regions refer to, and a description;
- an **AI service** the application may use, and a **system prompt** (`&ITEM.` is replaced by the item's
  value as delimited data, as in assistant regions);
- a **reasoning effort**: *low*, *medium* or *high*, or empty for the service's own. For Claude it is
  the output effort (thinking depth, `output_config.effort`); for OpenAI, Gemini and OpenAI-compatible
  services it is sent as `reasoning_effort` (leave it empty for models without reasoning: they refuse it);
- the **tools** it may use (ticked from the application's tools);
- **maximum steps** (rounds of tool calls per question, 1–20, default 5) and **maximum output tokens**
  per call (never above the service's maximum);
- an **authorization scheme**: other users see *You may not use this assistant* instead of the message
  box, and their questions are refused before anything is sent to the AI service.

A **tool** has a name the model calls it by, a description that tells the model what it does and when
to use it, optional **parameters** (JSON: `{"DNAME": {"type": "string", "description": "…", "optional": true}}`;
types string, integer, number, boolean, date, `enum` for a list of texts), an optional authorization
scheme (only users who pass it are offered the tool) and one of these types:

| Type | What runs | Checks |
|---|---|---|
| **SQL query** | one `SELECT` (or `WITH`, `VALUES`, `TABLE`) with the parameters as `:NAME` bind values, plus `:APP_USER` and items | as the application's database role (grants and row level security apply), in a **read-only transaction** (functions it calls can't write either), with a time limit (1–60 s, default 15) and at most *maximum rows* rows (default 50) back to the model |
| **PL/pgSQL function** | `schema.function` called with named arguments: each parameter name in lower case is an argument name (`P_EMPNO` → `p_empno => …`) | as the application's role; it **may change data** (committed); same time limit and rows |
| **REST data source** | a REST data source of the application; the parameters become its parameters | as in [assistant regions](04-pages-and-regions.md#ai_assistant-ai-assistant) |
| **JavaScript** | nothing on the server: after the answer the browser calls the function registered with `pgkiln.actions.register(action)` (with `{value: arguments}`) and the dynamic actions of the **custom event** of that name (the arguments as JSON) | once, right after the answer; the arguments are escaped data in the page |
| **Navigate** | the model picks one of the tool's **pages**, a link text and item values of that page; pgkiln builds the URL with the item values' **checksum** (bound to application, page and user) and shows the link under the answer | only pages the user may open are offered (the page's authorization scheme and sign-in); only items of that page; the model's values are never substituted (`&ITEM.`); nothing opens the link by itself |

The model's arguments are checked against the parameters before a tool runs; they are bind values
(escaped literals), never SQL text, and can't replace the server's own names (`:APP_USER`, `:APP_ID`, …).
Tool results go back to the model as data, with the instruction never to follow instructions inside them.

**Every tool call is logged** with the arguments the model gave, its status (*ok*, *error*, or *refused*
for a page the user may not open) and duration: in the page's debug messages (level 4) and under
Activity → **AI usage** → *Tool calls* (`meta.ai_tool_call`, kept 30 days; arguments may hold user data,
only developers see them). The token usage of each call to the model is logged as before.

Agents and tools are kept in the application (`meta.app.ai_agents`, `meta.app.ai_tools`) and **exported
with it**; an export made before they existed imports with none. The forms check each one before
saving (a SQL tool must be a query, a function `schema.name`, a navigate tool's pages must exist); the
runtime checks them again and shows *This assistant is not set up yet* for a broken one. Renaming a
tool keeps it in its agents; a tool an agent uses can't be deleted; renaming an agent renames it in
the regions that use it.

The HR example (`examples/hr/hr_64_ai_agent.sql`) has an agent `HR_AGENT` on page 46: ask *Who in Sales
earns most?* and it calls the SQL tool `top_earners` as the signed-in user's role, then offers
*Open BLAKE's record*, a link to the employee form (page 3) with a valid checksum, only to users who
may open that page.

## App Builder AI

The App Builder uses one AI service (APEX: AI Assistant in App Builder and SQL Workshop). An
administrator chooses it under **SQL Workshop → AI** (any enabled [AI service](#ai-services); *none*
switches the builder's AI off). What it is used for:

- **SQL from a question** (SQL Workshop → AI): pick a schema and ask; the answer is a statement and
  a short explanation. It is **shown, never run**: check it, change it and run it in the SQL Worksheet
  yourself (*Run in the SQL Worksheet*).
- **Explain a query or an error** (SQL Workshop → AI): paste a query, an error message or both
  (optionally with a schema for context); the explanation is shown with simple formatting.
- **Describe tables for AI** (SQL Workshop → AI → *Describe tables*): per table or view, a
  description of the table and each column (`meta.ai_table_note`). The builder sends them with the
  table list whenever it asks a model for SQL or pages, so answers use the right columns. Without a
  description the database comment is used. **Draft with AI** proposes descriptions from the names,
  types and keys (and the descriptions of referenced tables); they fill the form and are saved only
  when you save. *Also save them as database comments* writes them with `COMMENT ON` too.
- **Create pages with AI** on an application's dashboard ([see above](#create-pages-from-a-table-wizards)).

The model sees table and column names, types, keys and descriptions, and what you type; never
rows. Its answers are escaped when shown. Requests are logged in the AI usage log with the source
`builder` and no application (no application limits apply).

## Instance settings

Workspace utilities → **Instance settings** (administrators; APEX: instance administration → instance settings):

- **Sessions and sign-in**: session idle time, maximum session length, the sign-in throttling window and the number
  of failed sign-ins per user and per IP address. A value set here wins over its environment variable
  (`SESSION_IDLE_MINUTES`, `SESSION_MAX_HOURS`, `LOGIN_*`); empty uses the variable or the default. The page shows the
  value in effect and where it comes from. Other servers of the installation pick up a change within 30 seconds.
- **Configuration**: the server's environment variables (port, public URL, allow-lists, background runners, AI keys,
  …) as they are in effect; secrets (connection strings, keys) only show whether they are set.

## Installation

Workspace utilities → **Installation** (administrators only; APEX: the install/upgrade logs of
instance administration) shows the pgkiln version of the running server, the number of applied
migrations and the database, and warns when the database misses migrations of this server (run
`npm run db:migrate`) or has migrations the server does not know (an older server). A server started on a
database that misses migrations answers every request with *503* and names them, unless it was started with
`MIGRATE_ON_START=true` ([chapter 1](01-installation.md)), which applies them first. Below it:

- **Install and upgrade runs**: every run of `npm run db:migrate` / `pgkiln migrate` that applied a
  file or failed: when, *install* (an empty database) or *upgrade*, the version, the files and, for a
  failed run, the file and the error (that file was rolled back). Runs are recorded from 0.25 on.
- **Applied migrations** with the time each was applied, and the **example and seed scripts**.

## Globalization

**Shared Components → Globalization** translates the application's texts per language, exports and
imports XLIFF or CSV for translators, and manages text messages. See [chapter 14](14-globalization.md).

## REST API

Per application: the **API database role** that REST API tokens use, whether PostgREST answers
at `API_URL`, the endpoints (views and functions in the `api` schema, with the methods the role
may use), a form to **issue a token** for an account, and `curl` examples. See
[chapter 13](13-rest-api.md).

## SQL Workshop

The SQL Workshop opens on its **home** (`/builder/sql`; APEX: the SQL Workshop home): tiles for the SQL Worksheet,
the Object Browser, SQL Scripts, the utilities and Quick SQL; **Recently created tables** (the newest tables you can read:
PostgreSQL keeps no creation time, so object ids decide), your **recent SQL commands** (click one to open it in the SQL
Worksheet; other developers' are never shown) and the workspace's **recent SQL scripts**. The side column sets the
session's **schema** (APEX: the default schema): it goes first in the search path of the SQL Worksheet and SQL Scripts until
you sign out. Tasks link to Quick SQL, blueprints, table descriptions, sample data and Generate DDL.

(sprint 75) The tools are tabs: Home, SQL Worksheet, Object Browser, SQL Scripts and Utilities; **More** opens the
others (Quick SQL, Query Builder, Load and Unload Data, Sample Data, DDL, Compare, Data Modeler, AI), and the open one is a tab too.

(sprint 96; Database Actions: the Launchpad) The home page starts with **Pinned & recently visited**: the pages you
pinned (a tool, a database object from the Object Browser, a saved worksheet from its file menu; at most 24, per
workspace) and the SQL Workshop pages you opened last in this browser. Below, the tools are in three tabs,
**Development**, **Administration** and **Monitoring**, each with a line about what it does and a pin; the **More**
menu uses the same headings.

**Search** (**Ctrl/Cmd + K** on any builder page, or the field in the header) finds tools, applications, pages
(by name or number) and database objects (tables, views, materialized views, functions and procedures) by name;
the arrow keys and Enter open one. Applications and pages come from your workspace only; objects from the schemas
the SQL Workshop's connection may use. Without JavaScript the header's field opens a page of results.

- **SQL Worksheet** (`/builder/sql/worksheet`, sprint 91; Database Actions: SQL; was SQL Commands, whose address
  `/builder/sql/commands` opens the same page): one screen with a **navigator** on the left, the **editor** with a
  toolbar, **output tabs** below and a **status bar**.
  - The navigator has a schema (the same one as the Object Browser), an object type (*All Objects*, tables, views,
    materialized views, indexes, sequences, types, functions, procedures, triggers, policies) and a search field.
    A table or view opens to its columns with their types (a key marks the primary key); drag it into the editor
    for a `SELECT` of all its columns, or use its **SELECT**, **INSERT**, **UPDATE** and **DELETE** buttons, which
    insert the statement at the cursor. Columns are listed for the first 400 tables and views of a schema.
  - (sprint 94) Each object has a **⋯ menu** (or right-click it; Shift+right-click keeps the browser's menu), in
    the Object Browser's tree too: **Open** shows the Object Browser's tabs in a panel at the side, without leaving
    the worksheet; **Quick DDL** puts the object's DDL into a new worksheet tab (with the search path set to its
    schema) or downloads it as a `.sql` file; for a table **Load data**, **Add index**, **Add trigger** (a trigger
    function and the trigger) and **Add policy** (row level security on, a policy to fill in); **Drop…** writes the
    DROP statement with a comment that lists what depends on the object (views, foreign keys…). Nothing runs: you
    review the statement and run it.
    (sprint 100) Tables and views also have **REST › Enable / Disable**: it opens the object's page in **RESTful
    Services** when it is published, or the Enable form for it (below).
  - (sprint 95) **Table Properties** (a table's **Edit…**, **Use as template**, the Object Browser's *Edit table* and
    its *Table (form)* tile): a form with **Columns** (name, type, primary key, not null, default, identity,
    comment; move them up or down for a new table, remove them), **Unique keys**, **Foreign keys** (the table it refers
    to, its columns, on delete), **Checks**, **Indexes** (columns or expressions, unique; indexes with another method or
    a condition are kept as they are), the table's **comment**, **row level security** (and forcing it for the owner)
    and, for a new table, **partitioning** (range, list or hash and its key). **Preview DDL** shows the exact CREATE
    TABLE, or for an existing table the ALTER statements from what the catalog says now; **Apply** runs them in one
    transaction (nothing changes when one fails, and the error shows under *Output*); **Open in the worksheet** puts
    them there instead. *Use as template* starts a new table with the same columns and keys (names with `_copy`).
    Defaults, checks and index expressions are single expressions (no `;` or comments).
  - (sprint 119) **Security** (the Object Browser's *Security* button on a table, *Security…* in its ⋯ menu): the
    table's row level security policies, a matrix of database roles × columns with *read* and *update*, and masked
    columns per application role in a masking view; Preview SQL, Apply (one transaction, recorded in the Change Log)
    or Open in the worksheet ([chapter 8](08-security.md#data-security-per-table-rows-columns-and-values)).
  - **Run Statement** (**Ctrl/Cmd + Enter**) runs the statement at the cursor: the one the cursor is in, else the
    nearest one before it. A selection runs as it is, even when it holds several statements. The rows of the last
    query show in **Query Result**, up to 500, with row numbers, numbers right-aligned and NULL as *(null)*. The
    statement that ran is selected again afterwards. (sprint 92) Click a column heading to sort the rows, a cell to
    see its whole value (JSON indented), **Copy** for the rows as tab-separated text, and **All rows** to run the
    statement again for up to 10,000 rows. **Download** saves a SELECT as CSV, JSON, XML, Excel or SQL inserts
    through Unload Data (a read-only transaction, so the query runs once more).
  - **Run Script** (**F5**) runs every statement in order and writes **Script Output**: for each statement its line,
    the rows as text (up to 50), its notices, and its command tag like psql's (`CREATE TABLE`, `INSERT 0 2`,
    `SELECT 14`) with its time. An error says its line and column in the worksheet; the cursor goes to that line.
    The script stops at the first error unless **Continue on error** is on. psql meta-commands and `COPY … FROM
    STDIN` / `TO STDOUT` are skipped (use Load Data and Unload Data).
  - **Explain Plan** (**F10**) shows the plan of the statement at the cursor; nothing runs. **Autotrace** (**F6**) runs
    it with `EXPLAIN (ANALYZE, BUFFERS)` in a transaction that is rolled back, so an UPDATE or DELETE changes
    nothing. (sprint 92) The plan is a tree of steps: the operation, the table or index, cost, estimated rows and
    width, and the step's conditions (filter, index and join conditions, sort keys). Autotrace adds the actual time,
    rows, loops and buffers, the time spent in the step itself, marks the **slowest step**, and flags estimates that
    are 10 times too high or too low (run `ANALYZE` on the table). **Text plan** shows it like psql.
  - (sprint 97) **Chart** (**Ctrl + F11**, or *Chart* above the Query Result) draws the last query with pgkiln's
    own charts: the first text or date column gives the labels, the number columns the values; change the type (bar,
    column, stacked bar, line, area, donut, pie, scatter), the label column or the values and it draws again. Name it
    and **Save chart**: SQL Workshop → **Charts** lists the saved charts (shared by the workspace) and draws the ones
    on its dashboard; a chart's page changes its settings, opens its query in the worksheet or deletes it. A saved
    chart's SELECT runs read-only with a 10 second timeout and at most 500 rows.
  - **Notices** lists the `RAISE NOTICE`, `INFO` and `WARNING` messages of the last run with their time.
    **SQL History** (sprint 92) lists your last 200 statements in this workspace with how they ended, their rows and
    time; running the same statement again counts on its row (*3×*). Search it, show only the ones that failed or
    succeeded, click one to insert it at the cursor, **Run** to run it again, or copy it. Other developers' history
    never shows; 500 statements are kept per developer. The home page's *Recent SQL commands* opens it.
  - The status bar counts errors and warnings and shows the last message and its time.
  - (sprint 93) **Worksheets and files**: the worksheet's name is a menu with **Save** (**Ctrl/Cmd + S**), *Save as
    new*, *Rename*, **Download** (a `.sql` file), **New** and *Open…*. A worksheet is saved as a script of SQL Scripts
    (shared by the workspace's developers); the navigator's **Files** tab lists them, and SQL Scripts opens one in the
    worksheet. Several worksheets stay open as **tabs** above the editor (at most 20); a `*` marks text not saved yet.
    The tabs and their unsaved text are kept in the browser, so they survive a reload.
  - **Bind variables** (`:NAME`) and **substitution variables** (`&NAME.`) are asked for in a dialog before the run.
    A bind variable's value is a quoted literal (empty is NULL), so it can never change the statement; a substitution
    variable's text goes into the statement as it is (a table or column name, for instance). The values are
    remembered for the session; the history and the log keep the statement as written.
  - **Format** (**Ctrl + F7**) lays out the selection or the whole worksheet: a clause per line, the columns of a select
    list and the conditions of a WHERE one per line, joins and subqueries indented, keywords in lower or UPPER case
    (chosen in the **?** menu). Strings, comments and `$$` bodies stay as they are. **Convert case** (**Ctrl + B**)
    cycles the selection (or the word at the cursor) through UPPER, lower and Initial caps. **Find and replace**
    (**Ctrl + F**, **Ctrl + H**) with a regular expression or exact case, **Go to line** (**Ctrl + G**), and
    **Ctrl + /** comments the selected lines out or in. The **?** menu lists every key; **F1** opens this help. The
    upload button opens Load Data for the navigator's schema.
  - Each statement commits on its own (**Autocommit**, like Database Actions). Statements run as the **owner connection** (an isolated workspace's
    developer login for its developers), on a connection of their own that is closed afterwards, so `SET ROLE` or
    `SET search_path` doesn't leak. **Run as** picks an application of your workspace instead: the statements then
    run as its database role, with `pgkiln.app_id` set, so its grants and row level security policies apply. Use
    it to test policies; it is no security boundary, since the SQL could `RESET ROLE`. A `BEGIN` typed in
    Autocommit lasts for the run only: `begin; …; commit;` in one Run Script works, but a transaction still open at
    the end of the run is rolled back, with a warning under *Notices*.
  - (sprint 107) **Transaction mode** (more than Database Actions, which always autocommits): the toolbar's
    **Commit** menu switches a worksheet tab between *Autocommit* and *Transaction*. In Transaction mode the tab's
    statements (Run Statement and Run Script) stay in one transaction on a connection of its own until you press
    **Commit** or **Rollback**: a SELECT in the same tab sees the changes, other sessions (and your other tabs) don't
    until you commit. A badge shows *Transaction open*, the number of statements and its age; after a reload it shows
    the server's real state, and leaving the page with an open transaction asks first.
    - `COMMIT` or `ROLLBACK` typed in the editor end the transaction too (the next run starts a new one); a `BEGIN`
      typed inside it only warns. Statements PostgreSQL refuses inside a transaction (`VACUUM`, `CREATE INDEX
      CONCURRENTLY`, `ALTER SYSTEM`, `CREATE DATABASE`, …) are refused before they run, so they can't abort it.
    - A statement that fails leaves the transaction **aborted** (*Transaction failed*): every later statement fails
      until **Rollback**; Commit then rolls back as well, and says so.
    - **Explain Plan** and **Autotrace** run inside the open transaction behind a savepoint: the plan sees its changes,
      Autotrace's own changes are undone and the transaction stays as it was.
    - **Run as**: the transaction keeps the role it started with. Changing *Run as* while it is open is refused:
      commit or roll back first. `SET ROLE` typed in the editor reaches only the roles of the connection's login, as
      in Autocommit.
    - DDL reaches the **Change Log** when the transaction commits, never when it is rolled back. SQL History records
      each statement as it runs.
    - The transaction is **rolled back** when it is left without a run for `WORKSHEET_TXN_IDLE_SECONDS` (default
      300, five minutes; the badge and the next run say so), when you close its worksheet tab or switch it to
      Autocommit (after asking), sign out, switch workspaces, and when the server stops. The database ends the
      connection itself a minute later (`idle_in_transaction_session_timeout`) should the server not.
    - Each open transaction holds a database connection outside the pools: a developer has at most
      `WORKSHEET_TXN_MAX_PER_DEVELOPER` (default 3) and the server `WORKSHEET_TXN_MAX` (default 20); past that a run in
      Transaction mode is refused. A transaction belongs to the builder session, workspace and worksheet tab that
      started it: another developer, or another sign-in of yours, never reaches it. It lives in the server's memory,
      so with several pgkiln servers behind a load balancer the browser must stay on one (sticky sessions).
    - Without JavaScript the worksheet runs in Autocommit only.
  - With script, the panes fill the window. Drag the splitters (or focus one and use the arrow keys) to resize
    them, hide the navigator, or use **Fullscreen** to see only the editor (**Escape** leaves). Sizes are
    remembered in the browser. Without script, the buttons post the form and the panes stack; Run Statement then
    runs every statement. The [code editor](#the-code-editor) suggests every schema, table, column and function
    you can use.
- **Object Browser** (APEX's): the **schema** in the header and a tree with a
  folder per object type (tables, views, materialized views, indexes, sequences, types, functions, procedures,
  triggers) and a **filter** by name. pgkiln's own schemas (`meta`, `pgkiln_plugins`) and objects that belong to an
  extension show only with **Show system objects**. **Create** (and the tiles shown when nothing is selected) opens
  the SQL Worksheet with a CREATE TABLE, VIEW, FUNCTION, SEQUENCE or INDEX statement to fill in. A table opens in tabs:
  **Columns** (with comments; the toolbar's *Add*, *Modify* (type, nulls, default), *Rename* and *Drop column* write
  the ALTER TABLE statement into the SQL Worksheet to review and run: nothing changes until you press Run), **Data** (25
  rows a page; NULL is a blank cell), **Indexes**, **Constraints**
  (primary key, foreign keys with the table they refer to, unique, check), **Triggers**, **Grants**, **Row level
  security** (on or off, the policies), **Dependencies** (views and foreign keys that use it, and what it uses),
  **Statistics** (rows, sizes, analyze and vacuum times) and **DDL**. A view has the same tabs where they apply; a
  function or procedure shows its source, a trigger, index, sequence or type its definition. (sprint 89) The tabs stay
  on one row: Columns, Data, Indexes, Constraints and DDL (and the current one), the others under **More**. The
  schema shown is the one you chose last (remembered for the session), else the session's schema of the SQL Worksheet,
  else the **parsing schema** of the application changed last in your workspace (the schema its database role
  uses).
- **SQL Scripts**: saved scripts, shared by the developers of the workspace. Create one in the editor, upload a
  `.sql` file (UTF-8, up to 5 MB) or save one from Quick SQL; download it again as `.sql`. **Run**
  splits the script into statements at semicolons (outside strings, comments, quoted identifiers,
  `$$` bodies and `BEGIN ATOMIC … END`) and runs them one after another, with a **result per
  statement**: OK or the error, the command and row count, the time, and the first 10 rows of a
  query. Choose what happens when a statement fails: **stop** the script or **continue** with the
  next one. With **Run in one transaction**, *stop* rolls the whole script back and *continue*
  keeps the statements that worked (each runs in a savepoint). psql meta-commands (`\set`, `\i`,
  `\connect`) are reported as skipped. Every run is kept in the **run history** (the last 500
  runs), per script and overall, and in the activity log (`sql_script`). A script runs on a
  connection of its own that is closed afterwards, so `SET ROLE` or `SET search_path` in a script
  doesn't leak into other requests.
- **Quick SQL**: write tables in a shorthand and get the PostgreSQL DDL; save it as a script or
  run it. A table name on its own line with its columns indented below it; a table indented under
  another becomes a child table with a foreign key `<parent>_id`. Types follow the column name
  (`*_id` bigint, `*_at` timestamptz, `*_on`/`*_date` date, `is_*` boolean, `price`/`amount`
  numeric, otherwise text) or are written after it (`vc200`, `num(10,2)`, `int`, `date`, `tstz`,
  `json`, `bool`, `uuid` …). Column directives: `/nn`, `/pk`, `/unique`, `/idx`, `/fk table`,
  `/check a, b`, `/between 1 and 10`, `/default value`, `/lower`, `/upper`, `[a comment]`; table
  directive `/auditcols` (created/updated columns with a trigger). Settings: `# pk: identity | seq
  | guid | none`, `# schema: name`, `# prefix: xx`, `# drop: true`, `# auditcols: true`. `view name
  t1 t2` creates a view joining the tables by their foreign keys. Names become valid identifiers
  and values literals, so the DDL is always well-formed; problems are listed with line numbers.
- **Query Builder**: choose a schema and its tables and views. Each chosen table is a **box on a
  canvas** with its columns: tick the columns to show and pick a function (count, count distinct,
  sum, average, minimum, maximum) for any of them; with a function the other chosen columns become
  the `group by`. Joins follow the **foreign keys** and are drawn as lines between the columns.
  To join other columns, drag the dot next to a column onto a column of another table (a dashed
  line), or choose the two columns under **Joins**; a table without either is cross joined, with a
  note. Each join can be inner or left. Drag a table by its handle, or focus the handle and use
  the arrow keys (Shift for bigger steps); it stays where it was left. On phones the tables are
  stacked. Then pick conditions (`=`, `<>`, `<`, `like`, `in (a, b)`, `is null` …, combined with
  AND or OR), the sort, `distinct` and a row limit. The SELECT is shown and opens in the SQL Worksheet.
  The state is in the URL (tables in the order chosen, joins, functions and the tables' places), so
  a query can be bookmarked; everything except dragging works without JavaScript. Only names from
  the catalog and the fixed functions are used, and condition values are string literals.
- **Data Modeler** (SQL Workshop → More → Data Modeler, `/builder/sql/modeler`): named relational
  **diagrams** of a schema's tables and views, kept per workspace and shared by its developers. Create
  one with a name, a schema and, optionally, the objects (`orders, customers`, `ord*`, or `*` for all);
  **Add objects to diagram** searches the schema (part of a name, a pattern with `*`, or `*`) and adds
  the ticked ones. Each object is a box with its columns, their types, `P` (primary key), `F` (foreign
  key), `U` (unique) and `*` for not null; a foreign key between two shown tables is a line from the
  referencing table (a crow's foot: many) to the referenced one (a bar: one), dashed with a circle
  when the foreign key may be empty. A box's name opens **Table Properties** (a view: the Object
  Browser). The toolbar: **Save** (Ctrl+S), **Undo** / **Redo** (Ctrl+Z, Ctrl+Y), **Zoom out** / **Zoom
  in** (or Ctrl+wheel), **Fit**, **Auto layout** (referenced tables to the left of the tables that
  reference them; undoable), a **Mini-map** (click or drag in it to move around; the button shows when it is on),
  **SVG** and **PNG** exports of the diagram as shown (in light colours, whichever theme the builder uses; on screen the
  boxes, lines and mini-map follow the light or dark theme), **Print**, **Generate DDL** (the CREATE statements of the shown
  objects with their keys, indexes, triggers, row level security, policies, comments and grants: to
  download or open in the SQL Worksheet) and **Data dictionary** (each object's columns with type,
  nullability, default, keys and comments, its constraints and what references it; to print, save as
  PDF from the print dialog, or download as an HTML file). Drag a box to move it, or focus it and use
  the arrow keys (Shift for bigger steps). The diagram keeps only the objects' names and positions
  (`meta.sql_diagram`): columns and keys are read from the catalog each time, so it never goes stale;
  an object dropped from the schema is reported and left out on the next save. Without JavaScript the
  diagram shows at its saved positions, and adding, removing, auto layout, Export SVG, DDL and the
  dictionary all work. Diagrams are installation data, not exported with applications.
- **Load Data**: load a CSV, TSV, Excel, JSON or XML file into a new table (with inferred column
  types) or an existing one (append, merge by primary key, or replace), with a per-row error
  report, or with a saved **data load definition**; a mapping can be saved as one
  ([chapter 16](16-files.md#sql-workshop--load-data)).
- **Unload Data**: download a table or view (chosen columns, an optional WHERE and ORDER BY) or a
  query as CSV, JSON, Excel or XML, streamed from a cursor in a read-only transaction
  ([chapter 16](16-files.md#sql-workshop--unload-data)).
- **Sample Data**: generate realistic rows for one or more tables of a schema (names, e-mail
  addresses, dates and numbers in a range, values from a list, foreign keys that pick existing parent
  rows, a percentage of nulls), proposed per column from the catalog; preview them, insert them in one
  transaction (parents first) or download them as SQL or CSV, with a seed for the same rows again;
  save the definition to rerun it ([chapter 16](16-files.md#sql-workshop--sample-data)).
- **AI**: SQL from a question (shown, never run), explanations of queries and errors, and
  descriptions of tables for models ([App Builder AI](#app-builder-ai)).
- **DDL** (APEX: Generate DDL): choose a schema and the kinds of objects (types and domains,
  sequences, tables with their constraints and indexes, views and materialized views, functions
  and procedures, triggers, row level security and policies; comments and grants) and get their
  DDL from the database catalog, in an order that runs: types, sequences, PL/pgSQL functions,
  tables, SQL-standard functions, views in dependency order, constraints, foreign keys, indexes,
  triggers, RLS, comments, grants (including `revoke execute … from public` where a function's
  privileges leave PUBLIC out). Names of the schema itself are left unqualified and the script
  starts with `set search_path = <schema>`, so it also creates the same objects in another schema.
  Objects of extensions are left out. Shown in the editor and downloaded as `<schema>.sql`; not run.
- **Compare** (APEX: Schema Comparison): choose a source and a target schema of this database
  (a development copy and the schema it came from, say). Their objects are compared by their DDL
  (the order of a table's columns is not), and listed as only in the source, only in the target,
  or different, with a diff. The **change script** makes the target like the source: it creates
  what only the source has, changes tables column by column (add, type, default, not null),
  replaces views and functions, drops and creates constraints, indexes, triggers, policies and
  grants that differ, and lists for review what it doesn't change: drops of what only the target
  has (commented out), columns whose identity or generation differs, and types, domains and
  sequences that differ. (sprint 106) *Apply and record* runs the script on the target in one transaction and records
  it in the Change Log (below). The same from the command line (`pgkiln ddl`, `pgkiln compare`,
  [chapter 18](18-cli.md)) and for AI agents (`generate_ddl`, `compare_schemas`).
- **RESTful Services** (`/builder/sql/rest`, sprint 100; Database Actions: REST › AutoREST): publish a table or
  view as REST endpoints. Choose the object (of a schema the SQL Workshop may use), the **application** it is
  published through, a URL name, the **methods** (GET: rows and one row; POST; PUT; DELETE; single rows need a primary
  key), **who may call it** (a bearer token of the application, or explicitly *public*), optional application
  **roles** and the page size. The application decides the rest: the statements run as its database role (never the
  object's owner, a superuser or a role that bypasses row level security), with its tokens and OAuth clients and its
  accounts' roles. The object's page checks the role's grants per method, row level security and (for a view)
  `security_invoker`, lists the endpoints with their URLs, and shows cURL and `fetch` examples and the OpenAPI link.
  Details in [chapter 13](13-rest-api.md#autorest-tables-and-views-from-the-sql-workshop).
  (sprint 104; Database Actions: REST › Modules) The **Modules** tab edits the REST modules of the workspace's
  applications as a tree: a module (its base path and its privilege: roles every handler needs), its templates (URIs
  with `:parameters`) and their handlers (method, source type: collection query, single row, SQL, PL/pgSQL or media,
  who may call it, roles, documented parameters). Each handler has a **Try it** panel: the request goes to the real
  endpoint without a token or as an account of the application, and the response is shown in the page. Details in
  [chapter 13](13-rest-api.md#modules-templates-and-handlers-in-the-sql-workshop).
- **Change Log** (`/builder/sql/changes`, sprint 106; Database Actions: Liquibase): DDL that succeeds in the **SQL
  Worksheet**, **Table Properties** (*Apply*) and **Schema Comparison** (*Apply and record*: the change script run on
  the target in one transaction) is recorded as a *change set*: the schema it changes, its SQL, who ran it, when,
  where from and a number per schema that is never given again (deleting a change set keeps the others' numbers).
  Statements without a schema-qualified name count for the worksheet's schema. Only schema DDL is kept (CREATE,
  ALTER, DROP, COMMENT, GRANT and REVOKE on objects): no queries or data changes, and nothing about roles, databases
  or servers, so passwords never end up in the log. The page lists a schema's change sets with their SQL; rename one
  (its file name) or delete it from the log (the database is not changed). It marks which change sets were made
  before the latest **Export** of an application of the workspace (*in it*) and which after (*still to ship*).
  *Download migration* writes all of them, those not yet written to a file, or those after the latest export, as
  **Flyway** versioned migrations (`V0001__add_bonus.sql`; several in a zip), a **Liquibase** formatted SQL changelog
  (`--liquibase formatted sql`, `--changeset author:0001-add_bonus`) or one plain SQL script; each change set also
  has its own Flyway file. Change sets belong to the workspace and are not part of an application export.
- **JavaScript (MLE)**: not planned. Database Actions has a JavaScript tool for Oracle's Multilingual Engine;
  PostgreSQL runs JavaScript in the database only through the [plv8](15-extensions.md) extension. Where plv8 is
  installed, write `create function … language plv8` in the SQL Worksheet like any other function: the navigator,
  the Object Browser and Quick DDL show it. pgkiln adds no JavaScript editor of its own.
- **Utilities** (`/builder/sql/utilities`; APEX: SQL Workshop → Utilities): tiles for Load and Unload Data, Sample
  Data, the Query Builder, DDL and Compare, and three pages of their own. Each runs in a read-only transaction with a
  15-second statement timeout, on the SQL Workshop's connection (an isolated workspace's developers see only the
  schemas of its roles):
  - **Object Reports**: tables without a primary key, foreign keys without an index (with the `create index` to
    add), row-level security without policies, tables without row-level security (and to whom they are granted),
    privileges granted to PUBLIC, unused indexes, the largest tables and tables without a comment; each object links
    to the Object Browser. pgkiln's own `meta` schema and the system's are left out.
  - **About Database**: the PostgreSQL version, database size, uptime, a few settings (encoding, time zone,
    connections, memory, row security), the installed extensions and the schemas with their size.
  - **SQL Monitor** (administrators only): see [SQL Monitor](#sql-monitor) below (it replaced the Database Monitor;
    the old address `/builder/sql/utilities/monitor` redirects).
  - **Database Users** (administrators only; Administration menu → *Database users*, `/builder/db-users`; sprint 99,
    Database Actions: Database Users): see [Database users](#database-users).
  - **Schema Export / Import** (administrators only; `/builder/sql/data-pump`; sprint 103, Database Actions: Data
    Pump): see [Schema export and import](#schema-export-and-import).
  - **Scheduling** (administrators only; `/builder/sql/scheduling`, on the Launchpad under *Administration*, the
    Utilities page and the search; sprint 101, Database Actions: Scheduling): [pg_cron](#scheduling-with-pg_cron) jobs.

Because the SQL Workshop runs as the owner, restrict who gets a developer account.

### SQL Monitor

(sprint 102; Database Actions: Real Time SQL Monitor and Performance Hub) **SQL Workshop → SQL Monitor**
(`/builder/sql/monitor`, administrators only; on the Launchpad under *Monitoring*, in the Utilities and in the search,
Ctrl+K) shows what the database is doing, from PostgreSQL's statistics views:

- **Sessions**: tiles with the sessions (of `max_connections`), the active ones, those idle in a transaction, the
  blocked ones and the longest running statement; then the client sessions of this database (`pg_stat_activity`;
  idle sessions on request, *Show idle sessions*) with user, application and client address, state (idle in a
  transaction with its time), wait event, running time, the sessions that **block** it (the row is highlighted) and
  the query. A query with a `query_id` links to its statement page. **Cancel** (`pg_cancel_backend`: stop the running
  statement) and **Terminate** (`pg_terminate_backend`: roll back and disconnect) ask for a confirmation first; only
  client sessions of this database can be signalled, and the owner role needs the right to (a superuser, the
  session's own role, or `pg_signal_backend` for non-superusers' sessions).
- **Wait events**: what the active sessions of the server wait for now, counted per type and event (*CPU: running*
  when they don't wait).
- **In progress** (only when something runs): VACUUM, ANALYZE, CREATE INDEX, CLUSTER and COPY from the
  `pg_stat_progress_*` views, with the phase and a progress bar.
- The tiles and tables **refresh in place** every 5, 15 or 60 seconds, with a **Pause** button; the choice is
  remembered in the browser. Without JavaScript, *Refresh* reloads the page.
- **Top SQL**: the statements of this database from `pg_stat_statements`, every role: calls, total and mean time
  (with bars), rows, shared blocks hit and read; sort by any column (click the heading again to reverse), search the
  text, **Reset statistics** (the whole server, after a confirmation). Literals show as `$1`, `$2`….
- **A statement**: its text, its totals (calls, total and mean time, rows, blocks, temporary blocks) and a row per
  role with standard deviation, minimum and maximum; **Explain** shows its plan as a tree like the worksheet's. It is
  `EXPLAIN` only, never `EXPLAIN ANALYZE` (the statement is someone else's): a text with parameters gets a generic
  plan (`EXPLAIN (GENERIC_PLAN)`, PostgreSQL 16 or later), in a read-only transaction that is rolled back, with
  a 5-second timeout and one statement only. Choose the schema its unqualified names live in. **Open in worksheet**
  puts the text in the SQL Worksheet.

Top SQL needs the `pg_stat_statements` extension, which the server must load (`shared_preload_libraries`); pgkiln
creates the extension when it can (migration 016). Without it the page says how to turn it on. The per-application
**Top SQL** on an application's Activity page shows the same statistics for its database role only.

### Database users

(sprint 99; Database Actions: Database Users) **Administration → Database users** (administrators only; also on the
SQL Workshop's Launchpad under *Administration*) lists the PostgreSQL roles of the server (`pg_roles`; the predefined
`pg_` roles are left out): whether they can sign in, superuser / create DB / create role / bypass RLS / replication,
the connection limit, **valid until** (with *in N days* or *expired*), the roles they are a member of and what they own
(schemas, objects in this database, objects elsewhere). PostgreSQL doesn't record when a role was created.
The tiles on top filter the list: roles that can sign in, **passwords that expire within 30 days**, roles with
**BYPASSRLS**, roles **without sign-in that own objects**, and pgkiln's own roles; a search field filters by name.

**Create database user** (or a role's page) is a form: name, *Can sign in* (LOGIN), the password (*No password* /
*Set a password*; for an existing role *Keep*, *Set a new password* or *Remove*), **valid until** (a date; empty: no
expiry), the connection limit, the roles it is a **member of** (group roles and the predefined roles; not pgkiln's own,
superusers, login roles or the roles that reach the server's files), its **default schema** (the search path in this
database: `ALTER ROLE … IN DATABASE … SET search_path`), a comment, and per schema **Usage** and **Create**,
**Future tables** (default privileges, *read* or *read and write*, on what pgkiln's owner connection creates there) and
**Existing tables** (a one-off grant or revoke on the tables there now). pgkiln's own schemas aren't offered.

**Review SQL** shows the statements (only what differs from what the catalog says now), with the password as
`'********'`; the password itself is typed on that page (twice) and **Apply** runs the statements in one
transaction: all or none, and the error with the statement that failed. Apply runs only what the review showed:
when the form or the role changed in between, the review comes again. The masked statements go to the activity log
(event `db_role`).

**Drop role…** lists what the role owns and warns about objects in other databases; it reassigns them to another role
(`REASSIGN OWNED`) or, with a tick, drops them (`DROP OWNED`), revokes its privileges in this database and drops the
role, again after showing the SQL.

pgkiln's **own roles** are marked *pgkiln* and are read only here: the owner and runtime connections (`DATABASE_URL`,
`RUNTIME_DATABASE_URL`), every `pgkiln…` role (`pgkiln_runtime`, `pgkiln_app_code`, `pgkiln_authenticator`,
`pgkiln_anon`, isolated workspaces' logins) and the bootstrap superuser. Roles **in use** by an application (parsing
schema, REST API role) or an isolated workspace can be changed but not dropped. New names can't start with `pg_` or
`pgkiln`. The owner connection needs `CREATEROLE` (and, on PostgreSQL 16 and later, ADMIN on roles it didn't create)
for these changes; PostgreSQL's own error says so otherwise.

### Schema export and import

(sprint 103; Database Actions: Data Pump) **SQL Workshop → Schema Export / Import** (administrators only; on the
Launchpad under *Administration* and on the Utilities page) dumps a schema to a file with **pg_dump** and loads a
file into a schema with **pg_restore**, as background jobs. The list shows every job: export or import, the schema,
its status (*running*, *succeeded*, *failed*, *cancelled*, or *uploaded* for a file waiting for its options), the
file's size, when it started, how long it took and who ran it. A job's page has its options, pg_dump's or the
import's **log**, and **Download**, **Import…**, **Cancel** (while it runs) and **Delete** (the job and its file).

**Export a schema**: pick a schema (not pgkiln's own `meta`, PostgreSQL's or an extension's), then

- the **format**: *custom* (compressed, `pg_dump -Fc`; what Import reads) or *plain SQL* (for `psql`; not imported
  here; owners are left out);
- the **content**: definitions and data, definitions only (`--schema-only`) or data only (`--data-only`), with or
  without **grants**;
- the **tables, views and sequences**: the whole schema, only the checked ones (`--table`: the file then has no
  CREATE SCHEMA and no functions or types), or all but the checked ones (`--exclude-table`).

pg_dump runs with an argument list (no shell) on the owner connection (`DATABASE_URL`); the password goes in
`PGPASSWORD`, never on the command line. The file is kept in the dump directory for `PGKILN_DUMP_KEEP_DAYS` days
(default 7); then the scheduler removes it and the job stays in the list.

**Import**: upload a custom or tar archive of **one schema** (`pg_dump -Fc -n <schema>`, up to `PGKILN_DUMP_MAX_MB`,
default 2048 MB; the file is streamed to the dump directory), or pick a kept export. The next page shows what the
archive holds (`pg_restore --list`): the schema, the tables, the object types and how many of each, the server and
pg_dump versions. Then choose

- the **schema** to import into: the dump's own name or another one, **new or existing**. Another name renames the
  dump's schema in the same transaction (*create schema as*);
- the **content** (definitions and data, definitions only, data only: data goes into the tables that are there, in
  foreign key order, parents first);
- **Drop the dump's objects in the schema first** (`pg_restore --clean --if-exists`, to replace what an earlier import
  made) and **Grants**.

pg_restore writes the script (`pg_restore -f -`, without a connection of its own) and pgkiln runs it on one
connection in **one transaction**, so an error rolls everything back:

```sql
begin;
alter schema hr rename to pgkiln_dump_42;   -- importing hr as hr_copy while hr exists: the original steps aside
alter schema hr_copy rename to hr;          -- only when hr_copy exists: the dump's names now mean it
-- the dump's statements and COPY data (CREATE SCHEMA left out when the schema exists)
alter schema hr rename to hr_copy;
alter schema pgkiln_dump_42 rename to hr;
commit;
```

Other sessions keep seeing the original schema until the commit. Views, column defaults, triggers, policies and
SQL-standard function bodies refer to objects, so they follow the rename; **names inside PL/pgSQL bodies** and other
text (dynamic SQL, a function's `SET search_path`) still say the dump's schema after a rename. Objects are owned by
pgkiln's owner role (`--no-owner`); security labels, tablespaces, publications and subscriptions are left out.

Every statement is checked before it runs: the settings pg_dump writes, CREATE / ALTER / COMMENT / GRANT / DROP of
objects **in the dump's schema**, `COPY … FROM stdin` into its tables and `setval` of its sequences. Anything else is
refused and rolls the import back: objects in other schemas (`meta` among them), roles and role memberships, `SET
ROLE`, `OWNER TO`, `SET SCHEMA`, `DO`, `COPY` from or to files and programs, extensions, and psql meta-commands (other
than pg_dump's `\restrict`). An archive with several schemas, extensions or large objects is refused at the preview.
A dump is still code: its functions and triggers run as pgkiln's owner role. **Import only dumps you trust.**

**The client programs.** pg_dump can't dump a server newer than itself, so pgkiln looks for pg_dump and pg_restore of
the server's major version or newer, the newest it finds: `PGKILN_PG_BIN` (a directory), else
`/usr/lib/postgresql/<n>/bin` (Debian, Ubuntu), `/usr/pgsql-<n>/bin` (RHEL), Homebrew's `postgresql@<n>`, else `PATH`.
Without them the page says what to install (`postgresql-client-17` for a PostgreSQL 17 server). The Docker image
includes PostgreSQL 17's client programs and keeps the files in `/app/dumps` (a volume in `deploy/compose.yaml`).

| Variable | Default | |
|---|---|---|
| `PGKILN_PG_BIN` | (searched) | the directory of pg_dump and pg_restore |
| `PGKILN_DUMP_DIR` | `<temp>/pgkiln-dumps` | where the files are kept; one server's directory: with several pgkiln servers, a job's file is on the server that ran it |
| `PGKILN_DUMP_KEEP_DAYS` | 7 | days a file is kept |
| `PGKILN_DUMP_MAX_MB` | 2048 | the largest upload |

A job runs in the server that started it: when that server stops, the scheduler marks its running jobs *failed
(interrupted)* within two minutes. Exports, uploads, imports and downloads go to the activity log (`schema_export`,
`schema_upload`, `schema_import`, `schema_download`).

## Export and import

**Export** downloads the application as JSON: pages, all components, shared components and
settings. Since it's plain JSON you can commit it to git and review changes in pull requests.
In SQL: `select meta.export_app('hr')` and `select meta.import_app(<json>, 'new_alias')`.

For git, the [command line](18-cli.md) exports an application as a directory with one file per
component (`pgkiln export hr --format dir`), shows what differs (`pgkiln diff`) and imports it
again, also over the existing application (`pgkiln import hr/ --replace`). The builder downloads
that directory as a zip from `/builder/apps/<id>/export?format=dir`.

### Export format

The format is `"format": "pgkiln/2"`, and it's stable: files exported by pgkiln 0.2.0 and later
import into every later version. New versions only **add** sections, and a missing section
imports as empty. Import refuses other formats.

| Section | Contents |
|---|---|
| `app` | the application's settings (name, alias, home page, authentication, theme, languages, …) |
| `authz_schemes`, `app_items`, `app_processes`, `app_computations`, `shortcuts`, `report_queries`, `component_groups`, `lovs` | shared components |
| `group_roles` | identity-provider group → role mappings |
| `text_messages`, `translations` | globalization |
| `report_layouts` | report layouts; the logo as base64 |
| `template_components` | template components (regions and report columns refer to them by static id) |
| `web_credentials`, `rest_sources` | web credentials **without their secrets**, and REST data sources ([chapter 19](19-rest-data-sources.md)) |
| `data_load_definitions` | data load definitions ([chapter 16](16-files.md#data-load-definitions)) |
| `nav` | navigation menu (with ids, so parents can be linked again) |
| `lists`, `list_entries` | lists and their entries (with ids, so parents can be linked again) |
| `supporting_scripts` | supporting objects: install, upgrade and deinstall scripts (never run on import) |
| `pages` | every page with its `regions`, `items`, `buttons`, `dynamic_actions`, `validations` and `processes` |

Rows appear as they are in the `meta` tables (without their ids and the id of their parent), so a
new column travels along automatically.

**Not exported, on purpose:** accounts and who has access (they belong to an installation, not to
an app), OAuth clients and their secrets, the secrets of web credentials (enter them again after an
import), page locks and developer comments, sessions, activity logs, temporary files, and your
database objects (tables, views, functions: keep those in your own migration scripts). After an
import, check the app's database role under **Settings** and grant access under **Shared
Components**.
