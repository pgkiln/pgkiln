# 8. Users, authentication and authorization

This chapter is about securing *your applications*. How pgapex itself is protected (and the
security review) is in [SECURITY.md](../../SECURITY.md).

## Authentication: who is the user?

Each application chooses its **authentication** in **Settings**:

| Authentication | Behaviour |
|---|---|
| **App users** | A login page at `/a/<alias>/login`, checked against the application's user list |
| **None** | A public application. Everybody is `nobody` |

In an app with a login, pages require sign-in unless *Requires authentication* is unchecked on
the page (for a public start page, for example).

### Application users

Users are managed per application under **Shared Components → Application users** (or in the
table `meta.app_user`):

| Field | Meaning |
|---|---|
| Username | Case-insensitive, unique within the app |
| Password | Stored as a bcrypt hash; at least 8 characters when set in the builder |
| Roles | Free-form role names, e.g. `admin, manager`, used by authorization schemes and `meta.has_role()` |
| Active | Inactive users can't sign in; deactivating ends their sessions |

In SQL (for scripts and migrations):

```sql
insert into meta.app_user (app_id, username, password_hash, roles)
select id, 'alice', meta.hash_password('a-strong-password'), '{manager}'
  from meta.app where alias = 'hr';
```

> **pgapex vs Oracle APEX.** In APEX, "APEX accounts" belong to the **workspace**, and every
> application in the workspace can use them. Access per app is then limited with roles
> (Application Access Control) and authorization schemes. In pgapex, users belong to **one
> application**, which is simpler and isolates apps completely, but means a person who uses
> three apps needs three accounts. A shared user directory with per-app role assignments, plus
> single sign-on (OpenID Connect), is on the roadmap. See [chapter 11](11-from-apex.md#users-per-application).

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
