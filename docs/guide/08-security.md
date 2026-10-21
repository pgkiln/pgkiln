# 8. Users, authentication and authorization

This chapter is about securing *your applications*. How pgkiln itself is protected (and the
security review) is in [SECURITY.md](../../SECURITY.md).

## Authentication: who is the user?

Each application chooses its **authentication** in **Settings**:

| Authentication | Behaviour |
|---|---|
| **App users** | A login page at `/a/<alias>/login`, checked against the **user directory** |
| **HTTP header** | A trusted reverse proxy names the user ([below](#http-header-authentication-reverse-proxy)) |
| **Database accounts** | PostgreSQL login roles and their passwords ([below](#database-accounts-postgresql-roles)) |
| **Custom** | Your own PL/pgSQL checks the user name and password ([below](#custom-authentication-a-plpgsql-function)) |
| **None** | A public application. Everybody is `nobody` |

In an app with a login, pages require sign-in unless *Requires authentication* is unchecked on
the page (for a public start page, for example).

### The user directory

Like APEX's workspace accounts, pgkiln has **one account per person** for the whole installation
(**Builder → Users**, table `meta.account`):

| Field | Meaning |
|---|---|
| Username | Unique, not case-sensitive; no spaces or colons |
| Name, e-mail | For display |
| Password | bcrypt hash, following the password rules below. May be empty for accounts that only sign in through single sign-on |
| Active | Inactive accounts can't sign in anywhere; deactivating ends their sessions |

### Passwords and My account

The builder and the runtime cover what APEX offers for its accounts:

| APEX | pgkiln |
|---|---|
| `APEX_UTIL.CHANGE_CURRENT_USER_PW` | **My account** (user menu → *My account*, `/a/<alias>/account`): current password, new password twice. Other sessions of the account end |
| *Require Change of Password on First Use* | Checkbox when creating an account or setting its password in the builder (on by default). The next sign-in asks for a new password before continuing |
| `APEX_UTIL.RESET_PASSWORD` | **Users → account → Set password**, or `meta.set_password(username, password, change_on_first_use default true)` |
| `APEX_UTIL.EXPIRE_END_USER_ACCOUNT` / `UNEXPIRE_…` | **Expire password** / **Unexpire password**, or `meta.expire_password(username)` / `meta.unexpire_password(username)` |
| *Account Password Lifetime (days)* | **Users → Account settings → Password lifetime** (0 = never). Expired passwords must be changed at sign-in; My account shows the days left |
| Password complexity rules | Minimum length, *letters and digits*, and never containing the username (Account settings) |
| *Maximum Login Failures* / unlock | Sign-in locks for `LOGIN_WINDOW_MINUTES` after `LOGIN_MAX_FAILURES_PER_USER` failures. **Unlock sign-in** on the account lifts it at once |

The `meta.set_password`/`expire`/`unexpire` functions are owner-only. Grant them to an app role if
you want to build user administration pages inside an application.

A user who forgot their password asks an administrator, who sets a temporary one under
**Users → account → Set password**, with *Require change of password on first use* ticked (the
default), or uses **Forgot password?** when the application offers it (below).

### Forgot password

With **Application settings → Sign-in methods → Offer "Forgot password?"** the sign-in page (the
built-in one or the application's [own login page](#the-login-page)) has a *Forgot password?* link
(APEX apps don't have one out of the box). It needs an enabled [mail service](06-processing.md#sending-e-mail)
with a From address for the application; without one the link isn't shown. It is for passwords
of the user directory only: not for LDAP, single sign-on, database accounts or custom
authentication.

1. The user types their user name or e-mail address. The answer is always the same, whether or
   not an account matched, so the page doesn't tell who has an account.
2. An active account with a password and an e-mail address that may use the application gets an
   e-mail (in the user's language) with a link to `/a/<alias>/password/reset?token=…`, built from
   `PUBLIC_URL`, never from the request's `Host` header.
3. The link works **once**, for **30 minutes**, in this application only. Opening it moves the
   token into the session and out of the address bar; the user chooses a new password (the
   [password policy](#passwords-and-my-account) applies).
4. The new password ends every session and *Keep me signed in* token of the account, and makes
   the account's other open links useless.

Only a SHA-256 hash of each token is stored (`meta.password_reset`, owner only). Requests are
limited to 5 per address in 15 minutes and 3 mails per account per hour; they count towards the
application's daily mail limit and show in the activity log (`password_reset_request`,
`password_reset`).

### The login page

`/a/<alias>/login` shows pgkiln's sign-in page: the application's name, the sign-in methods and,
when the application has several languages, a language picker. To design your own (APEX: the
login page, usually page 9999), choose **Application settings → Sign-in methods → Create a login
page**: it adds page 9999 (or the next free number) that doesn't require authentication, with
page template *Minimal (no navigation)* and a **Login** region, and makes it the application's
**Login page**. From then on `/a/<alias>/login` (and every page that needs a signed-in user)
sends visitors there.

Edit it like any page: add static content, images, lists of links or any other region around the
Login region, which is the sign-in form (identity providers, user name and password, *Keep me
signed in*, *Forgot password?*). The form still posts to `/a/<alias>/login`, so throttling, the
CSRF check and every sign-in method work as on the built-in page; a failed sign-in comes back to
the login page with its message and the user name. A login page that requires authentication,
or doesn't exist, is ignored (the built-in page shows) and the Advisor reports it; so does a
login page without a Login region.

With single sign-on, password changes happen at the identity provider; My account says so.

**My account** also holds the user's **preferences**: light or dark (when the app allows it) and
the language (when the app has translations). See [chapter 14](14-globalization.md).

### Access control per application

Each application decides who may use it (**Shared Components → Access control**, like APEX's
*Application Access Control*):

| Setting | Who may sign in |
|---|---|
| **Only accounts listed** (default) | Accounts that have been granted access to this application |
| **Any active account** | Every active account in the directory |

Granting access assigns **roles for that application** (`admin, manager`, …), which authorization
schemes and `meta.has_role()` check. The same person can be an administrator in one app and a
plain user in another. Grant access from the application (Access control) or from the account
(**Users → account → Application access**).

Role names are free text, so under each roles field the builder lists the roles the application
actually checks: role-type authorization schemes, `meta.has_role('…')` calls in SQL schemes and
page components, identity-provider group mappings, and roles already given to other users. Click
one to add it; hover over it to see where it is checked. A role that nothing checks has no effect.

Roles are resolved **at sign-in** and kept with the session. When you change someone's roles or
revoke access, their sessions in that app end, so the change applies at their next sign-in.

An account without access to an app gets the same "Invalid username or password" as a wrong
password, so the login page doesn't reveal which accounts exist or which apps they use.

In SQL (for scripts and migrations):

```sql
insert into meta.account (username, display_name, password_hash)
values ('alice', 'Alice Example', meta.hash_password('a-strong-password'));

insert into meta.app_access (app_id, account_id, roles)
select a.id, u.id, '{manager}'
  from meta.app a, meta.account u
 where a.alias = 'hr' and u.username = 'alice';
```

Scripts written for older versions keep working: `meta.app_user` is now a view, and inserting into
it creates the account (if needed) and grants access:

```sql
insert into meta.app_user (app_id, username, password_hash, roles)
select id, 'alice', meta.hash_password('a-strong-password'), '{manager}' from meta.app where alias = 'hr';
```

### Single sign-on (OpenID Connect)

Applications can let people sign in with your organisation's identity provider: Microsoft Entra
ID, Google Workspace, Okta, Keycloak, Auth0 or any other OpenID Connect provider.

**1. Register pgkiln at the provider** as a *web application* (confidential client) using the
authorization code flow. The redirect URI is `<PUBLIC_URL>/sso/callback/<name>`, for example
`https://apps.example.com/sso/callback/entra`. Note the client ID and secret, and ask for a
**groups** claim in the ID token if you want to map groups to roles.

**2. Add the provider** under **Builder → Users → Identity providers**:

| Field | Meaning |
|---|---|
| Name | Used in URLs (`entra`, `google`, `keycloak`) |
| Button label | "Sign in with …" |
| Issuer URL | e.g. `https://login.microsoftonline.com/<tenant>/v2.0`, `https://accounts.google.com`, `https://keycloak.example.com/realms/acme`. pgkiln reads `<issuer>/.well-known/openid-configuration` |
| Client ID / secret | From the registration. The secret is write-only in the builder and readable only by the owner connection |
| Scopes | Default `openid profile email` |
| Username claim | The claim that becomes the pgkiln username. Choose one users **cannot change themselves**: `preferred_username` (Keycloak), `upn` or `email` (Entra), `email` (Google) |
| Groups claim | Default `groups`; dot paths work (`realm_access.roles`) |
| Create accounts automatically | Create a directory account on first sign-in; otherwise only people with an account linked to the provider (or linked below) can sign in |
| Link existing accounts | On the first sign-in, link an existing account with the same username. Turn it on only when users **can't choose** the username claim at the provider, and off again once accounts are linked: otherwise someone could register an existing account's name there and sign in as that account. With the `email` claim only addresses the provider marks verified (`email_verified: true`) link |

Use **Test discovery** to check the issuer URL.

**3. Enable it per application** under **Settings → Sign-in methods** (tick the provider; untick
*Username and password* for SSO-only apps).

**4. Map groups to roles** (optional) under **Shared Components → Access control → Identity-provider
groups → roles**, e.g. `hr-managers → manager`. Members of a mapped group get the role in that app
for their session, and may sign in even when they aren't listed individually.

How accounts are matched:

- The first sign-in links the identity (the provider's stable subject id, `sub`) to the account
  with the same username when *Link existing accounts* is on, or creates the account when
  *Create accounts automatically* is on. Otherwise an existing account of that name is refused
  ("not linked to this identity provider").
- Identity providers, LDAP directories and the password policy are changed by **administrators**
  only (they decide who can sign in to every application).
- Later sign-ins use the link, so a user renaming themselves at the provider can't take over
  another account. An account can be linked to only one identity per provider.
- Access follows the same rules as passwords: the app's access control, the account's roles in the
  app, plus roles from mapped groups. Inactive accounts can't sign in.

Protections built in: PKCE (S256), a one-time `state` bound to the browser that started the sign-in
(stops login CSRF and replay), a `nonce` in the ID token, and signature verification against the
provider's published keys with issuer, audience and expiry checks.

Signing in to a second application with the same provider is silent: the provider's own session
answers without asking for a password again.

**Try it locally** with the bundled Keycloak:

```bash
docker compose --profile sso up -d keycloak      # http://127.0.0.1:8180 (admin / admin)
psql "$DATABASE_URL" -f examples/keycloak-sso.sql
```

The HR sample's login page then shows *Sign in with Keycloak*. Keycloak users: `king` / `king-sso`
(groups hr-admins and hr-managers), `allen` / `allen-sso`, and `carol` / `carol-sso` (hr-managers;
she has no pgkiln account yet and is created on first sign-in).

### Single sign-on (SAML 2.0)

For identity providers that speak SAML (ADFS, Shibboleth, Entra ID, Okta, Keycloak, …), add the
provider under **Users → Identity providers** with protocol **SAML 2.0**:

| Field | Meaning |
|---|---|
| Issuer | The IdP's **entity ID** (from its metadata). Assertions from any other issuer are refused |
| Client ID | pgkiln's entity ID at the IdP. Empty: `<PUBLIC_URL>/sso/saml/<name>/metadata` |
| IdP sign-in URL | The IdP's `SingleSignOnService` location (HTTP-Redirect binding) |
| IdP signing certificate | The IdP's certificate (PEM, or the base64 from its metadata). Assertions **must** be signed with it |
| Username claim | `nameID`, or the name of an attribute (e.g. `uid`, `email`) |
| Groups claim | The attribute holding the groups (e.g. `groups`, `memberOf`) |

At the IdP, register pgkiln with the metadata at `<PUBLIC_URL>/sso/saml/<name>/metadata` (entity
ID and assertion consumer service `<PUBLIC_URL>/sso/saml/<name>`, HTTP-POST binding), sign the
assertions, and add a group attribute. Enable the provider per application and map its groups to
roles exactly as for OpenID Connect; accounts are linked by the NameID.

pgkiln checks the assertion's signature, issuer, audience, recipient and validity period, and that
the response answers an AuthnRequest this browser started, once (`InResponseTo`, a one-time
`RelayState` and the browser-binding cookie, as for OpenID Connect). Because the IdP posts the
response from another site, where `SameSite=Lax` cookies aren't sent, pgkiln answers with a short
page that posts it on to itself (submitted by `app.js`; a *Continue* button without script).

**Try it locally:** the bundled Keycloak realm has a SAML client for pgkiln.

```bash
docker compose --profile sso up -d keycloak
psql "$DATABASE_URL" -f examples/keycloak-saml.sql    # reads Keycloak's signing certificate
```

The HR login page then offers *Sign in with Keycloak (SAML)*, with the same Keycloak users.

### LDAP and Active Directory

Applications can check passwords against **LDAP directories** (OpenLDAP, Active Directory,
389 Directory Server, …), APEX's *LDAP Directory* scheme. The username and password form checks
local accounts first, then the directories enabled for the app, in order.

Add a directory under **Users → LDAP directories**:

| Field | Meaning |
|---|---|
| URL | `ldaps://host` (TLS) or `ldap://host:389`; tick **StartTLS** to upgrade `ldap://`. Plain `ldap://` sends passwords unencrypted |
| Service account DN / password | Searches users and groups. Empty: an anonymous search. The password is write-only |
| User search base / filter | Where users are and how to find one: `(uid={username})`, Active Directory `(sAMAccountName={username})`. `{username}` is escaped (RFC 4515) |
| Username attribute | The pgkiln username (`uid`, AD `sAMAccountName`) |
| Group attribute | e.g. `memberOf` (group DNs; the first value of each is the group name) |
| Group search base / filter | Optional: search groups too, e.g. `(member={dn})` |
| Create accounts automatically | As for single sign-on |

**Test connection** binds as the service account and checks the search base (or looks a user up).
Then tick the directory under the app's **Settings → Sign-in methods** (keep *Username and
password* on) and map groups to roles under **Access control**, as for single sign-on.

Signing in searches the user, then binds as that user with the password given. Empty passwords
are refused before that (LDAP treats them as an anonymous bind). Accounts are linked by the
entry's `entryUUID` (or its DN), with the same rules as single sign-on; a local password keeps
working next to the directory one. When a directory can't be reached, users see that, and the next
directory is tried. **Try it locally:** `docker compose --profile ldap up -d ldap`, then
`psql "$DATABASE_URL" -f examples/ldap-directory.sql` (users `blake` / `blake-ldap`, `dora` /
`dora-ldap`).

### HTTP header authentication (reverse proxy)

Behind a reverse proxy or single sign-on gateway that already authenticates users (Apache
`mod_auth_mellon`, oauth2-proxy, an Entra ID application proxy, Kerberos at the proxy, …), an
application can take the user name from a request header, APEX's *HTTP Header Variable* scheme.
In **Settings → Security** choose Authentication **HTTP header (reverse proxy)** and set:

- **User name header**: the header the proxy sets (empty: `X-Remote-User`);
- **Create accounts automatically**: an unknown user name gets a new account with access to this
  app. Off: the account must exist, be active and have access (Users → Accounts), as for the other
  sign-in methods;
- **Sign-out URL**: where *Sign out* goes after the session ends, usually the proxy's own sign-out
  page (an `http(s)://` URL or a path). Without it the user sees a "signed out" page; the next page
  they open signs them in again through the proxy.

Anyone can send a header, so pgkiln trusts it **only from the proxies** listed in the environment
variable `PGKILN_AUTH_HEADER_PROXIES` (comma-separated IPs and CIDRs, e.g.
`PGKILN_AUTH_HEADER_PROXIES=10.0.0.5, 192.168.10.0/24`). The check uses the address of the TCP
connection itself, never `X-Forwarded-For`, so `TRUST_PROXY` doesn't change it. Unset, or a
request from any other address: the app shows an error page and the activity log records a
`login_failed` entry (`header: untrusted peer …`). Make sure users can't reach pgkiln directly,
bypassing the proxy, and that the proxy **removes** the header from incoming requests before it
sets its own.

The first request with the header signs the user in (activity log: `login`, detail `header`) and
the session is bound to the header value: when a later request carries another user name, or none,
the session ends (and, with another name, a new one starts for that user). The value must be 1 to
100 printable ASCII characters without spaces, colons or commas; a repeated header is refused.
The password form, LDAP, single sign-on buttons and *Keep me signed in* are not used by these apps,
and form submissions still need the session's CSRF token.

### Database accounts (PostgreSQL roles)

APEX's *Database Accounts* scheme: users sign in with the name and password of a PostgreSQL
**login role**. In **Settings → Security** choose Authentication **Database accounts** and set
who may sign in:

- **Allowed roles**: login role names, comma separated (exact, case-sensitive names); and/or
- **Or members of role**: every member (direct or inherited) of this role may sign in too.

With neither set nobody can sign in. pgkiln never reads `pg_authid`: it checks the password by
opening a short-lived connection **as that role** to its own database (host, port, database and
SSL settings of `DATABASE_URL`), asks PostgreSQL whether the role is a superuser and a member of
the membership role, and closes the connection. So PostgreSQL applies its own rules: the
password, `NOLOGIN`, `VALID UNTIL`, `CONNECTION LIMIT` and `pg_hba.conf` (which must allow
password logins for these roles from the pgkiln server). Superusers and pgkiln's own connection
roles (the users of `DATABASE_URL` and `RUNTIME_DATABASE_URL`) are always refused, even when
listed. An unlisted name is refused before any connection is made (unless a membership role is
set).

The session's user (`:APP_USER`) is the role name; app roles come from **Access control** like for
other users (an account of the same name, if there is one). The application's SQL still runs as
the app's database role (*parsing schema*), not as the signed-in role. Wrong passwords, unknown,
unlisted or refused roles all get the same "invalid" answer and count towards the sign-in
throttling (`LOGIN_MAX_FAILURES_PER_USER`, `LOGIN_MAX_FAILURES_PER_IP`); the activity log has
`login` (detail `database`) and `login_failed` with the reason (`database: role not allowed`,
`superuser refused`, `connection refused (28P01)`, …), never the password. When the database
can't be reached the page says so (503). *Keep me signed in*, LDAP, single sign-on and the
password-change form are not used by these apps.

### Custom authentication (a PL/pgSQL function)

APEX's *Custom* authentication scheme: your own code decides whether a user name and password are
valid, e.g. against a users table of your application. In **Settings → Security** choose
Authentication **Custom** and fill in, under *Custom authentication*, one of:

- **Function name**: a function `(p_username text, p_password text) returns boolean`, in lower case,
  optionally with its schema (`app.check_login`). The app's database role needs `EXECUTE` on it. It
  takes precedence over the body.
- **Or function body**: PL/pgSQL with `p_username` and `p_password`, returning `true` for a valid
  sign-in, either a bare `return …;` or a whole `declare … begin … end` block:

```sql
return exists (select 1 from app.users
                where name = p_username and not locked
                  and pw_hash = crypt(p_password, pw_hash));
```

Optionally, **Post-authentication code** runs after a successful check with `p_username` (and
`meta.app_user()` set to it), e.g. to record the last sign-in; raising an exception refuses the
sign-in. *After login* application processes run afterwards as usual.

Both run **as the application's database role**, in one transaction, in a temporary function that is
dropped again; nothing is kept unless the check returns `true` and the post-authentication code
succeeds. The password is only ever a query parameter: it is never part of the SQL text, never
stored and never logged. A check that returns `false` or `null`, or raises an error, gets the same
"invalid" answer as a wrong password and counts towards the sign-in throttling; the activity log has
`login` (detail `custom`) and `login_failed` with `custom: check returned false`, `check failed
(<SQLSTATE>)` or `post-authentication failed (<SQLSTATE>)`, never the error message (it could repeat
the password). With neither a function nor a body nobody can sign in.

The session's user (`:APP_USER`) is the user name as typed; app roles come from **Access control**
like for other users (an account of the same name, if there is one), or from the app's own tables
in authorization schemes. The login page has the user name and password form only: *Keep me signed
in*, LDAP, single sign-on and the password-change form are not used by these apps.

### Session timeout warning

Sessions end after the idle time (`SESSION_IDLE_MINUTES`, or Instance settings) and at their maximum
length (`SESSION_MAX_HOURS`). Signed-in users are warned before (Settings → *Errors and sessions* →
*Session timeout warning*, default 120 seconds; 0: no warning; APEX: Session Timeout Warning): a
dialog says when the session ends and offers **Stay signed in**, which marks the session active
(POST `/a/<alias>/session/extend`, with the session's CSRF token). At the maximum length the user can
only save their work; when the session has ended the dialog offers to sign in again and comes back
to the page.

### Keep me signed in

Under **Settings → Sign-in methods**, *"Keep me signed in" for (days)* (1–365) adds a checkbox to the
password form (APEX: persistent authentication). A browser that ticked it stays signed in for that
many days after the sign-in, also after the session's idle or maximum time: a long-lived cookie
holds a random token (only its SHA-256 is stored, in `meta.persistent_login`, readable by the owner
connection only), which starts a new session and is then **replaced** by a fresh token, so a copied
cookie works once at most. The expiry stays that of the original sign-in.

Each use checks the account again (active, access to the app, roles; directory and identity-provider
groups from the sign-in are mapped to roles again). Signing out, a new password, deactivating the
account or removing its access ends it, and **My account → Sign out on all devices** ends it for every
browser. An expired password always needs the password form.

### Session sharing between applications

Applications that use the user directory (*App users*) and have the same **Session sharing group** (Settings →
Sign-in methods; lower case letters, digits and `_`) share a sign-in (APEX: session sharing). After signing in to one,
opening another application of the group signs the user in there without the sign-in page:

- each application still checks **its own access** (an access row, *any active account* or mapped directory/identity
  provider groups) and gives **its own roles**; without access the user gets that application's sign-in page;
- the shared sign-in is a cookie for the whole site (path `/`, `HttpOnly`, `SameSite=Lax`, `Secure` behind HTTPS) with
  a random token; only its SHA-256 is stored (`meta.shared_login`, readable by the owner connection only);
- it ends after the session idle time without use or the maximum session length (Instance settings), when the
  account is deactivated, and when the user **signs out of any application of the group**, which also ends the
  sessions of the other applications that came from it.

Applications of different groups, and applications without a group, sign in on their own.

### What sign-in protects against

- **Brute force**: after 5 failed attempts for a username (or 50 from one IP address) within 15
  minutes, sign-in is refused for the rest of the window, even with the right password.
- **User enumeration**: unknown users and wrong passwords get the same message and take the same
  time.
- **Session fixation**: the session token is replaced at sign-in.
- **Stale sessions**: 60 minutes idle or 8 hours total (configurable).

All sign-ins, failures and lockouts appear in the **Activity** monitor.

A second factor for an application's users comes from the identity provider ([OpenID Connect](#single-sign-on-openid-connect),
[SAML](#single-sign-on-saml-20)). Developers can use an authenticator app for the builder itself:
[two-factor sign-in](03-builder.md#two-factor-sign-in).

## Authorization: what may the user do?

### Authorization schemes

An authorization scheme is a named rule (**Shared Components → Authorization schemes**):

| Type | `value` | Passes when |
|---|---|---|
| `role` | a role name, e.g. `admin` | the user has that role |
| `sql` | a SQL boolean expression | the expression is true, e.g. `meta.has_role('manager') or meta.has_role('admin')` |

Plus the built-in `MUST_NOT_BE_PUBLIC_USER` (signed in). Reference a scheme by name in the
`authz` property of a page, region, item, button, process, dynamic action or navigation entry;
prefix it with `!` to negate (`!ADMIN`). Unknown schemes **fail closed** (deny). Each scheme is
evaluated at most once per request, and its `error_message` is shown when a page is refused.

What happens when a scheme fails:

| On | Effect |
|---|---|
| Page | 403 page with the scheme's error message; links and menu entries to the page are hidden |
| Region | Not rendered, together with its items and buttons |
| Item | Not rendered, and **cannot be set** by a submit |
| Button | Not rendered, and **cannot be pressed** (a forged request gets 403) |
| Process | Skipped |
| Dynamic action | Not sent to the browser, and refused by the server |
| Navigation entry | Hidden |

### Conditions

`condition` (regions, buttons) and `readonly_condition` (items) are SQL expressions evaluated per
request. They're for *state* ("show *Approve* only while the request is pending") rather than
*identity*, but they're enforced the same way: a hidden button can't be pressed.

## Row level security: the database decides

Authorization schemes control the **user interface**. For **data**, the strongest and simplest
protection is PostgreSQL's row level security, because it applies to every region, grid, list of
values, process and dynamic action at once, and to any other tool that uses the same role.

The app's queries run as its database role with `meta.app_user()` and `meta.has_role()`
available, so policies can reference the application user:

```sql
alter table tasks.task enable row level security;

-- everyone sees only their own tasks; admins see everything
create policy own_tasks on tasks.task
  using (owner = meta.app_user() or meta.has_role('admin'))
  with check (owner = meta.app_user());
```

Patterns from the HR sample:

```sql
-- employees see their own leave requests, managers those of their team
create policy leave_visible on hr.leave_request for select
  using (empno = hr.current_empno() or hr.is_manager_of(empno) or meta.has_role('admin'));
```

A row hidden by RLS is simply absent: a report doesn't show it, and a form says "record not found"
(identical to a row that doesn't exist, so nothing leaks).

Keep in mind:

- The table owner bypasses RLS (unless `FORCE ROW LEVEL SECURITY`), so don't make the app role the owner.
- Functions declared `SECURITY DEFINER` run as their owner and bypass RLS on purpose, which is
  useful for triggers that must write notifications for *other* users (`hr.notify_leave_decided`).
  Keep them small and set `search_path`.

## Database privileges

Give the app role only what the app needs:

```sql
grant usage on schema hr to hr_app;
grant select, insert, update on hr.leave_request to hr_app;   -- no delete
grant select, update (read_at) on hr.notification to hr_app; -- column-level
grant execute on function hr.request_leave(date, date, text) to hr_app;
```

Apps created in the builder get full DML on their schema by default; tighten this as the app
matures. Privileges show up in **SQL Workshop → Object Browser**.

A `data_load` process loads files as the app role too, also with a data load definition: a
definition naming a table the role can't write fails like any other insert, and a process only
finds the definitions of its own application. XML files with a document type declaration are
refused ([chapter 16](16-files.md#data-loading)). The SQL Workshop (the SQL Worksheet, SQL Scripts,
Quick SQL, Load Data, Unload Data, Sample Data) runs as the owner instead, so every developer can change any table: keep
developer accounts to people you trust with the database.

The REST endpoints pgkiln serves (an application's REST modules and the tables and views published with **SQL
Workshop → RESTful Services**, AutoREST) run as the app role too, never as the owner: these grants, column grants
and the row level security below decide what an API caller may read and change. AutoREST refuses a role that owns
the published object or bypasses row level security, and an object answers only to a bearer token of its application
unless the developer chose *public* for it ([chapter 13](13-rest-api.md#autorest-tables-and-views-from-the-sql-workshop)).
(sprint 104) REST module handlers refuse to run as a superuser, a role that bypasses row level security or a member
of pgkiln's owner (403). Their parameters are bound: SQL handlers get escaped literals, PL/pgSQL handlers read
transaction-local settings through `meta.rest_param()`; a request can't set the server's binds (`APP_USER`, …) or
real settings. Media handlers are served with a sandboxing Content-Security-Policy and `nosniff`. *Try it* in the
SQL Workshop calls an endpoint as an account of the application, as a developer issuing a token could
([chapter 13](13-rest-api.md#modules-templates-and-handlers-in-the-sql-workshop)).

(sprint 106) The SQL Workshop's **Change Log** keeps the schema DDL developers run from the worksheet, Table
Properties and Schema Comparison, per workspace (only the workspace's developers see it). Statements about roles,
databases, servers, user mappings and subscriptions are never recorded, so passwords and connection strings stay
out of it; it holds what the DDL says otherwise (defaults, comments, function bodies).

### Database users and their passwords

(sprint 99) Administrators create and change PostgreSQL roles in the builder (**Administration → Database users**,
[chapter 3](03-builder.md#database-users)). Passwords never reach PostgreSQL or a page in plain text: pgkiln hashes
a new password itself into a **SCRAM-SHA-256 verifier** (random salt, 4096 iterations, SASLprep, like psql's
`\password`) and the statement carries only that verifier, as a literal built with pg's `escapeLiteral`. The review
and the activity log show `PASSWORD '********'`; the password is typed on the review page, posted once with Apply and
not stored, echoed or logged. A server with `log_statement = ddl` logs the verifier, not the password. Every name is
quoted with `escapeIdentifier`, every value is checked (dates, numbers, schema names, grantable roles) and quoted.
The page is for administrators only (others get 403), every change needs the CSRF token, and pgkiln's own roles can't
be changed, dropped or granted from it, so the page can't take pgkiln's own connections away.

## Data security per table: rows, columns and values

(sprint 119) PostgreSQL has row level security but no column masking, so pgkiln puts a table's security in three
layers, all ordinary database objects, and shows them on one page: **SQL Workshop → Object Browser → a table →
Security** (also *Security…* in the table's ⋯ menu). It is pgkiln's answer to APEX 26.2's Deep Data Security.

- **Rows**: the table's row level security policies (above), listed with a link to Table Properties to switch row
  level security on and to *Add policy*.
- **Columns**: a matrix of **database roles × columns** with *read* and *update* per cell. The rows are the roles
  that have privileges on the table and the database roles of the workspace's applications (with the applications
  that run as them). Apply writes `GRANT` / `REVOKE SELECT (c, …)` and `UPDATE (c, …)`. A column a role may not read
  is refused by PostgreSQL ("permission denied") whoever sends the query. The table's owner, superusers and roles that
  bypass row level security are listed apart: column privileges can't restrict them.
- **Values**: masked columns per **application role** (`meta.has_role()` of the signed-in user). A column's mask is
  *empty (null)*, `***` or `***` plus the last four characters; tick the application roles that see the real value,
  and *Everyone else* for users with none of the listed roles. The masks live in a **masking view** next to the table
  (default name `<table>_masked`):

  ```sql
  create view sales.orders_masked with (security_barrier) as
  select t.id, t.customer,
         case when (select meta.has_role('manager')) then t.amount end as amount,
         case when false then t.iban::text else '***' || right(t.iban::text, 4) end as iban
    from sales.orders t;
  ```

  The view is owned by a role per schema, `<schema>_masking` (nologin), which pgkiln creates the first time. That
  role is no owner, superuser or role that bypasses row level security (Apply checks it), so the table's policies
  still apply inside the view; and it is a member of the database roles that read the table, so policies written
  `to <role>` apply as well. The configuration is kept in the view's comment, so it travels with `pg_dump`,
  Generate DDL and the change log; there is no `meta` table for it.

**Preview SQL** shows the statements, **Apply** runs them in one transaction (and records a change set in the
Change Log), **Open in the worksheet** puts them there. Nothing is changed when one statement fails.

**The mask holds only where the view is read.** As long as a role may still read the raw column on the table, its
queries on the table see the value; the preview warns about each such column. Point the application's pages,
REST handlers and AI tools at the view, then untick *read* of the masked columns for the role, and the value is
masked everywhere that role connects.

Every client meets the same rules because they all run as the application's database role with the same identity:

| Client | Runs as | `meta.app_user()` / `meta.has_role()` from |
|---|---|---|
| Pages, processes, dynamic actions, AI assistant and AI agent tools | the application's role (`appTx`) | the session |
| REST module handlers, AutoREST | the application's role | the bearer token (its user, the user's roles) |
| The MCP server's `run_query` with `alias` (and `user`) | the application's role | the user's roles in the application ([chapter 20](20-ai-agents.md#safety)) |
| psql, other tools | whatever role they log in as | — (only grants and policies apply) |

Policies and masks that use `meta.has_role()` can be combined: with a policy that shows a manager the rows of their
department, and `amount` masked for everyone but `manager`, a clerk reads their own rows with an empty amount.
Policies written per database role (`to sales_app`) apply to the masking role for every role it is a member of, so
prefer policies on `meta.app_user()` / `meta.has_role()` on tables with a masking view. The HR example's page 48
*Salaries (masked)* reads `hr.emp_masked` (`examples/hr/hr_70_data_security.sql`).

## Session state protection

- **URL items**: on pages with protection *Arguments must have checksum* (the default), item
  values in a URL are accepted only with a valid checksum. It's an HMAC bound to the application,
  page and **user**, so a link can't be edited (`?P3_EMPNO=7839` → `7902`) and one user's links
  don't work for another. Build links in SQL with `meta.page_url(3, '{"P3_EMPNO": 7839}')`.
- **Submitted values**: only editable, visible items are taken from a submit. Hidden, display-only,
  read-only and unauthorized items keep their server-side values.
- **Grid rows**: every row's primary key is signed the same way.
- **Master-detail selection**: a master grid's select links carry a signature bound to the
  application, page, user, region and value; only then does the value go into the item (hidden
  items are never taken from a submit, and URL items need the page checksum). The detail
  endpoint `GET …/region/:id` serves only lazy regions and details of a visible master, after
  the page's and region's authorization and conditions. A detail grid's master column is filled
  from the session item on insert and can't be edited.
- **Grid layouts and saved grid reports**: the layout endpoints (`POST …/grid/:id/layout`,
  `…/layout/reset`, `…/saved/:sid/apply`) check the CSRF token, page access and that the grid is
  on the page and visible to the user. The layout is cleaned on the server (known shapes only,
  widths numbers between 40 and 1000, at most 5 frozen columns, at most 6000 characters) and
  only ever reorders columns the query returns anyway. In the database, `meta.save_grid_layout` /
  `meta.reset_grid_layout` (security definer) only touch the signed-in user's own row of a grid
  of the current application; layout rows are never visible to other users, even if marked
  public. Applying a saved report works for the user's own and public reports of that grid only.
- **Calendar drag and drop**: the browser only names an event (its key) and a slot. The server
  checks the token, the page's and region's authorization and condition and the region's
  `move_authz`, and that the event is in the region's query for this user (as the application's
  database role, with RLS), validates the slot as a date, and passes the new start and end to the
  `move` SQL as literals. Your function still decides who may move what (e.g. only the organizer).
- **Chart and calendar links** (drill-down, create on click) are checksummed like report links.
- **CSRF**: every POST carries a per-session token.

Checksums prevent tampering but aren't a substitute for RLS. A user who legitimately received a
link for record 7839 can open it. Whether they may see record 7839 at all is the database's
decision.

## Checklist for a new application

1. A dedicated `db_role` with minimal grants.
2. RLS on tables where rows belong to users or teams.
3. Authorization schemes on pages and buttons that change data.
4. Checksum protection on pages (the default).
5. Business rules in constraints, triggers or functions, not only in validations.
6. Debug mode and debug messages off.
7. Review the app's **Settings → Security checklist** and **Activity** monitor now and then.
