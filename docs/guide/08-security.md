# 8. Users, authentication and authorization

This chapter is about securing *your applications*. How pgapex itself is protected (and the
security review) is in [SECURITY.md](../../SECURITY.md).

## Authentication: who is the user?

Each application chooses its **authentication** in **Settings**:

| Authentication | Behaviour |
|---|---|
| **App users** | A login page at `/a/<alias>/login`, checked against the **user directory** |
| **None** | A public application. Everybody is `nobody` |

In an app with a login, pages require sign-in unless *Requires authentication* is unchecked on
the page (for a public start page, for example).

### The user directory

Like APEX's workspace accounts, pgapex has **one account per person** for the whole installation
(**Builder → Users**, table `meta.account`):

| Field | Meaning |
|---|---|
| Username | Unique, not case-sensitive; no spaces or colons |
| Name, e-mail | For display |
| Password | bcrypt hash, following the password rules below. May be empty for accounts that only sign in through single sign-on |
| Active | Inactive accounts can't sign in anywhere; deactivating ends their sessions |

### Passwords and My account

The builder and the runtime cover what APEX offers for its accounts:

| APEX | pgapex |
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

pgapex doesn't send e-mail, so there is no self-service "forgot password" link (APEX apps don't
have one out of the box either). A user who forgot their password asks an administrator, who
sets a temporary one under **Users → account → Set password**, with *Require change of password
on first use* ticked (the default).

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

**1. Register pgapex at the provider** as a *web application* (confidential client) using the
authorization code flow. The redirect URI is `<PUBLIC_URL>/sso/callback/<name>`, for example
`https://apps.example.com/sso/callback/entra`. Note the client ID and secret, and ask for a
**groups** claim in the ID token if you want to map groups to roles.

**2. Add the provider** under **Builder → Users → Identity providers**:

| Field | Meaning |
|---|---|
| Name | Used in URLs (`entra`, `google`, `keycloak`) |
| Button label | "Sign in with …" |
| Issuer URL | e.g. `https://login.microsoftonline.com/<tenant>/v2.0`, `https://accounts.google.com`, `https://keycloak.example.com/realms/acme`. pgapex reads `<issuer>/.well-known/openid-configuration` |
| Client ID / secret | From the registration. The secret is write-only in the builder and readable only by the owner connection |
| Scopes | Default `openid profile email` |
| Username claim | The claim that becomes the pgapex username. Choose one users **cannot change themselves**: `preferred_username` (Keycloak), `upn` or `email` (Entra), `email` (Google) |
| Groups claim | Default `groups`; dot paths work (`realm_access.roles`) |
| Create accounts automatically | Create a directory account on first sign-in; otherwise only people with an existing account can sign in |

Use **Test discovery** to check the issuer URL.

**3. Enable it per application** under **Settings → Sign-in methods** (tick the provider; untick
*Username and password* for SSO-only apps).

**4. Map groups to roles** (optional) under **Shared Components → Access control → Identity-provider
groups → roles**, e.g. `hr-managers → manager`. Members of a mapped group get the role in that app
for their session, and may sign in even when they aren't listed individually.

How accounts are matched:

- The first sign-in links the identity (the provider's stable subject id, `sub`) to the account
  with the same username, or creates the account when *Create accounts automatically* is on.
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
she has no pgapex account yet and is created on first sign-in).

### Single sign-on (SAML 2.0)

For identity providers that speak SAML (ADFS, Shibboleth, Entra ID, Okta, Keycloak, …), add the
provider under **Users → Identity providers** with protocol **SAML 2.0**:

| Field | Meaning |
|---|---|
| Issuer | The IdP's **entity ID** (from its metadata). Assertions from any other issuer are refused |
| Client ID | pgapex's entity ID at the IdP. Empty: `<PUBLIC_URL>/sso/saml/<name>/metadata` |
| IdP sign-in URL | The IdP's `SingleSignOnService` location (HTTP-Redirect binding) |
| IdP signing certificate | The IdP's certificate (PEM, or the base64 from its metadata). Assertions **must** be signed with it |
| Username claim | `nameID`, or the name of an attribute (e.g. `uid`, `email`) |
| Groups claim | The attribute holding the groups (e.g. `groups`, `memberOf`) |

At the IdP, register pgapex with the metadata at `<PUBLIC_URL>/sso/saml/<name>/metadata` (entity
ID and assertion consumer service `<PUBLIC_URL>/sso/saml/<name>`, HTTP-POST binding), sign the
assertions, and add a group attribute. Enable the provider per application and map its groups to
roles exactly as for OpenID Connect; accounts are linked by the NameID.

pgapex checks the assertion's signature, issuer, audience, recipient and validity period, and that
the response answers an AuthnRequest this browser started, once (`InResponseTo`, a one-time
`RelayState` and the browser-binding cookie, as for OpenID Connect). Because the IdP posts the
response from another site, where `SameSite=Lax` cookies aren't sent, pgapex answers with a short
page that posts it on to itself (submitted by `app.js`; a *Continue* button without script).

**Try it locally:** the bundled Keycloak realm has a SAML client for pgapex.

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
| Username attribute | The pgapex username (`uid`, AD `sAMAccountName`) |
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

### What sign-in protects against

- **Brute force**: after 5 failed attempts for a username (or 50 from one IP address) within 15
  minutes, sign-in is refused for the rest of the window, even with the right password.
- **User enumeration**: unknown users and wrong passwords get the same message and take the same
  time.
- **Session fixation**: the session token is replaced at sign-in.
- **Stale sessions**: 60 minutes idle or 8 hours total (configurable).

All sign-ins, failures and lockouts appear in the **Activity** monitor.

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

## Session state protection

- **URL items**: on pages with protection *Arguments must have checksum* (the default), item
  values in a URL are accepted only with a valid checksum. It's an HMAC bound to the application,
  page and **user**, so a link can't be edited (`?P3_EMPNO=7839` → `7902`) and one user's links
  don't work for another. Build links in SQL with `meta.page_url(3, '{"P3_EMPNO": 7839}')`.
- **Submitted values**: only editable, visible items are taken from a submit. Hidden, display-only,
  read-only and unauthorized items keep their server-side values.
- **Grid rows**: every row's primary key is signed the same way.
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
6. Debug mode off.
7. Review the app's **Settings → Security checklist** and **Activity** monitor now and then.
