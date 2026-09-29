# 10. Tutorial: build a Tasks app

In this tutorial you build a personal task list:

- every user sees **only their own tasks** (row level security);
- tasks are created and edited in a **modal form**;
- a **"Mark done"** button calls a **PL/pgSQL function**;
- a **validation** refuses due dates in the past;
- a **dynamic action** suggests a due date for high-priority tasks;
- **KPI cards** show open, overdue and done tasks.

You can follow it in the builder, or run the finished result in one go:

```bash
psql "postgres://pgapex:pgapex@localhost:5434/pgapex" -f examples/tasks-app.sql
```

Then open http://127.0.0.1:3100/a/tasks and sign in as `ann` / `ann-password` or
`bob` / `bob-password`. Each only sees their own tasks.

## Step 1: the table and the business logic

Open **SQL Workshop → SQL Commands** and run:

```sql
create schema tasks;

create table tasks.task (
  id         int generated always as identity primary key,
  owner      text not null default meta.app_user(),   -- filled in with the signed-in user
  title      text not null,
  priority   text not null default 'NORMAL' check (priority in ('LOW', 'NORMAL', 'HIGH')),
  due_date   date,
  done       boolean not null default false,
  done_at    timestamptz,
  created_at timestamptz not null default now()
);

create function tasks.complete(p_id int) returns void
language plpgsql as $$
begin
  update tasks.task set done = true, done_at = now()
   where id = p_id and not done;
  if not found then
    raise exception 'This task is already done (or it is not yours).';
  end if;
end
$$;
```

Note the default `owner = meta.app_user()`: whoever inserts a row owns it, without any code in
the application.

## Step 2: the application

On the **App Builder** home, fill in *Create application*:

| Field | Value |
|---|---|
| Name | `Tasks` |
| Alias | `tasks` |
| Parsing schema | `tasks` |
| Authentication | App users |
| First user / Password | `ann` / `ann-password` |

This creates the role `app_tasks` with access to schema `tasks` (including the function), page 1,
and the user `ann`. Add `bob` under **Shared Components → Application users**.

> The SQL script creates the role itself instead: `create role app_tasks nologin; grant app_tasks to pgapex_runtime; grant …`.

## Step 3: row level security

Back in the SQL Workshop:

```sql
alter table tasks.task enable row level security;
create policy own_tasks on tasks.task
  using (owner = meta.app_user())
  with check (owner = meta.app_user());
```

From now on every query the app runs, whether a report, form fetch, update or the `complete`
function, only sees the current user's rows. There is nothing to remember in the application itself.

## Step 4: report and form pages

Open the app and use **Create pages from a table**: page type *Report and form*, table
`tasks.task`, label `My tasks`, report page `1`, form page `2`, icon `check`.

> The app already has a page 1 (*Home*). Delete it first (open it, **Delete page**), or use pages 2 and 3.

You now have an interactive report with a *Create* button and a modal dialog form. Tidy up:

1. **Report source** (page 1 → region *My tasks* → Source):
   ```sql
   select id, title, priority, due_date, done
     from tasks.task
    order by done, due_date nulls last, id
   ```
2. **Form items** (page 2): delete `P2_OWNER`, `P2_DONE`, `P2_DONE_AT` and `P2_CREATED_AT` (the
   database manages them). Change `P2_PRIORITY` to type `radio` with LOV
   `STATIC:Low;LOW,Normal;NORMAL,High;HIGH` and default `NORMAL`.

Run the app, sign in as `ann`, and create a task.

## Step 5: a button that calls PL/pgSQL

On page 2 add a **button** in the form region:

| Property | Value |
|---|---|
| Name | `COMPLETE` |
| Label | `Mark done` |
| Action | submit |
| Target page | 1 |
| Condition | `:P2_ID is not null and not exists (select 1 from tasks.task where id = :P2_ID::int and done)` |

and a **process**:

| Property | Value |
|---|---|
| Name | `Complete task` |
| Type | sql |
| Code | `select tasks.complete(:P2_ID::int)` |
| When button | `COMPLETE` |
| Success message | `Nice work!` |

The button only appears for existing, open tasks, and pgapex re-checks that condition when it's
pressed. The function checks again in the database, and its `raise exception` message would be
shown to the user.

## Step 6: a validation

On page 2 add a **validation**:

| Property | Value |
|---|---|
| Name | `Due date not in the past` |
| Type | sql |
| Associated item | `P2_DUE_DATE` |
| Expression | `:P2_DUE_DATE is null or :P2_DUE_DATE::date >= current_date or :P2_ID is not null` |
| Message | `The due date cannot be in the past.` |

## Step 7: a dynamic action

On page 2 add a **dynamic action**:

| Property | Value |
|---|---|
| Name | `Suggest due date for high priority` |
| Event / Item(s) | change / `P2_PRIORITY` |
| Client-side condition | equals `HIGH` |
| Action | set_value |
| Affected items | `P2_DUE_DATE` |
| SQL | `select coalesce(:P2_DUE_DATE::date, current_date + 1)` |
| Items to submit | `P2_DUE_DATE` |

Choosing *High* now fills in tomorrow's date if none was set.

## Step 8: KPI cards

On page 1 add a **region** of type `cards`, template `plain`, sequence `5`, attributes
`{"style": "metric"}`, source:

```sql
select 'Open' as title, count(*) filter (where not done)::text as badge, 'list' as icon from tasks.task
union all
select 'Overdue', count(*) filter (where not done and due_date < current_date)::text, 'calendar' from tasks.task
union all
select 'Done', count(*) filter (where done)::text, 'check' from tasks.task
```

Thanks to RLS the numbers are per user without a `where owner = …`.

## Step 9: try it

1. Sign in as `ann`, create a few tasks (try a due date in the past, and choose *High*).
2. Open a task and press **Mark done**.
3. Sign in as `bob` in another browser: his list is empty.
4. Look at **Builder → Tasks → Activity** to see the sign-ins and page views.
5. **Export** the app and commit the JSON to your repository.

## Where to go next

- Put the SQL from steps 1 and 3 in a migration of your own project so it's versioned.
- Add a `category` column and a faceted search region ([chapter 4](04-pages-and-regions.md#facets-faceted-search)).
- Add a calendar of due dates: a `calendar` region with `select due_date as start_date, title, id from tasks.task`.
- Share tasks with a team: add a `team` column and change the policy to `using (team = any (…))`.
