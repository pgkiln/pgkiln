# 19. REST data sources and web credentials

An application can read data from other web services and call them (APEX: REST Data Sources,
Web Credentials and the Invoke API process):

- a **web credential** says how pgkiln signs in to a web service: HTTP basic authentication, an
  HTTP header (an API key), a bearer token, or OAuth2 (client credentials, password or refresh
  token). Its secrets are stored encrypted and are never shown again;
- a **REST data source** is an endpoint (URL with parameters, method, credential, headers) whose
  JSON response becomes typed rows. Reports, cards, charts, calendars, maps, trees, template
  components and shared lists of values can read those rows like a table. Forms and interactive
  grids can also **write back** through it, and a **synchronisation** copies its rows into a local
  table;
- the **`invoke_api` process** calls a source or a URL when a page is submitted (or loaded) and
  puts values of the response into items; the **`invoke_api` workflow step** does the same on the
  server, with workflow variables ([chapter 6](06-processing.md#invoke-api-steps)).

Both are **Shared Components**, as are **JSON sources** ([below](#json-sources-and-document-views)): forms,
reports and grids over the documents in a `jsonb` column of your own tables. The server only calls hosts its administrator allows
([below](#server-configuration-and-the-allow-list)): out of the box, no outgoing request is made.

Try it with the HR example: page 23 "Web services" reads the HR example's own REST module
([chapter 13](13-rest-api.md#rest-modules-in-the-builder)), so no internet is needed. Set
`PGKILN_REST_ALLOWED_HOSTS=127.0.0.1` and `PGKILN_REST_PRIVATE_HOSTS=127.0.0.1` in `.env` and
restart the server.

From application SQL, `meta.web_request()` and `meta.web_request_source()` queue a request that
the server makes (APEX_WEB_SERVICE; [chapter 9](09-reference.md#web-requests-from-sql)).

## Server configuration and the allow-list

| Variable | Default | Meaning |
|---|---|---|
| `PGKILN_REST_ALLOWED_HOSTS` | *(none: no calls)* | Hosts pgkiln may call, comma separated: `api.example.com`, `*.example.com` (any subdomain), `api.example.com:8443` (only that port), `*` (any **public** host) |
| `PGKILN_REST_PRIVATE_HOSTS` | *(none)* | Hosts that may resolve to private, loopback or link-local addresses (e.g. a service in your own network, or `127.0.0.1`); listing a host here also allows it |
| `PGKILN_SECRET_KEY` | *(none)* | Encrypts the secrets of web credentials (AES-256-GCM); at least 32 characters, e.g. `openssl rand -base64 32`. Without it, secrets can't be saved or used |
| `PGKILN_REST_MAX_BYTES` | `5000000` | Largest response pgkiln reads (also after decompression) |

The checks on every outgoing request (`src/webclient.ts`), against server-side request forgery:

- only `http` and `https`; no user name or password in the URL (use a web credential);
- the host must match `PGKILN_REST_ALLOWED_HOSTS` (or `PGKILN_REST_PRIVATE_HOSTS`);
- the addresses the host name resolves to are checked **when the connection is made**, and the
  connection goes to the checked address, so DNS rebinding can't swap it. Private (10/8,
  172.16/12, 192.168/16, fc00::/7), loopback, link-local (169.254/16, including cloud metadata
  services, fe80::/10), carrier-grade NAT, multicast, documentation and other special ranges are
  refused, also when written as IPv4-mapped, NAT64 or 6to4 IPv6 addresses, unless the host is in
  `PGKILN_REST_PRIVATE_HOSTS`;
- redirects are followed at most 3 times, only to URLs that pass the same checks; the
  credential's headers are dropped when a redirect leaves the original origin;
- a time limit for the whole exchange (the source's timeout, at most 60 seconds) and the size
  limit above.

Keep the allow-list as short as you can. `*` lets developers call any public host from the
server; it never opens private addresses.

**A workspace's network access list** (sprint 118; APEX 26.2 workspace network ACLs) narrows this
list for one workspace: under Administration → [Network access](03-builder.md#network-access), its
administrators can limit its applications to some hosts (same entry syntax, without `*`). A call made
for an application of that workspace must then match the workspace's list *and* the installation's,
on every redirect hop; the address checks above stay with `PGKILN_REST_PRIVATE_HOSTS` alone, so a
workspace can never widen what the installation allows. It applies to every path above: REST data
sources (including write-back, synchronisation and the response cache), `meta.web_request`, invoke
API, token endpoints, object storage and REST source catalogs. Refusals are logged in the
application's debug log and listed under *Refused calls*.

**Changing `PGKILN_SECRET_KEY`** without `pgkiln admin rotate-key` ([chapter 3](03-builder.md#lockout-checks))
makes the stored secrets unreadable: pgkiln then reports that the secret must be entered again. Keep the key with your other server secrets, outside the
database: a database dump alone does not reveal the secrets.

## Web credentials

Shared Components → **Web credentials** → ＋ Add.

| Property | Meaning |
|---|---|
| Name | Uppercase, e.g. `WEATHER_API`; sources and processes use the credential by this name |
| Authentication | `basic` (user name + password), `header` (an HTTP header with the secret, e.g. `X-API-Key`), `bearer` (`Authorization: Bearer <secret>`), `oauth2`, `aws_sigv4` (an S3-compatible object store's access key: the access key id as user name, the secret access key as secret, the region as scope; signs the requests of [file items in object storage](16-files.md#object-storage), not of REST data sources) |
| Grant type | `oauth2`: `client_credentials` (default), `password` or `refresh_token` ([below](#oauth2-grant-types)) |
| User name / client id | `basic`: the user name; `oauth2`: the client id |
| OAuth2 user name | `oauth2` with `password`: the user pgkiln signs in as |
| Header name | `header`: the header that carries the secret |
| Token URL, Scope | `oauth2`: the token endpoint and the scope to ask for |
| Secret | The password, header value, token or client secret. **Write-only**: it is encrypted by the server, never shown again (the form says whether one is stored), never exported. Leave it empty to keep the stored one; **Remove the secret** clears it |
| OAuth2 password, Refresh token | `oauth2`: the password of the OAuth2 user (`password` grant), or a refresh token obtained elsewhere (`refresh_token` grant). Write-only like the secret, each with its own **Remove** button |
| Valid for URLs | URL prefixes the credential may be sent to, e.g. `https://api.example.com/v2/`. Recommended: a source or process that points elsewhere fails instead of sending the secret |

**Workspace web credentials** (sprint 141): Workspace utilities → **Web credentials** holds credentials with the same
properties for every application of the workspace ([chapter 3](03-builder.md#static-workspace-files-remote-servers-and-web-credentials)).
Wherever a credential is named (a source, the `invoke_api` process and step, `meta.web_request`, a remote server's
default credential, object storage), the application's own credential of that name is used, else the workspace's.
Another workspace's credentials are never found.

For `oauth2`, pgkiln asks the token endpoint for an access token, keeps it until 30 seconds before
it expires, renews it with the refresh token when the endpoint gave one, and asks for a new one when
the service answers 401. Access tokens are kept in the server's memory only.

### OAuth2 grant types

| Grant type | Token request |
|---|---|
| `client_credentials` | `grant_type=client_credentials`; the client id and secret with HTTP basic authentication |
| `password` | `grant_type=password` with the OAuth2 user name and password (APEX: *OAuth2 resource owner password*) |
| `refresh_token` | `grant_type=refresh_token` with the refresh token you entered, e.g. one obtained once through the service's own consent page |

With `password` and `refresh_token` the client authenticates with HTTP basic when the credential
has a client secret; without one (a public client) the client id is sent in the form.

When the token endpoint returns a refresh token, pgkiln **stores it encrypted** in the credential
(and replaces it when the endpoint rotates it), so it survives a restart and is shared by several
servers. When a refresh fails, the `password` grant signs in again; the `refresh_token` grant can't,
and the error says to enter a new refresh token in the builder.

The runtime database role can read a credential's settings but not its secret column; the server
loads the secret with the owner connection, decrypts it only for the request, and never puts it
into an error message or the activity log.

After an **import**, the credentials are there without secrets: enter them again. `pgkiln import
--replace` keeps the secrets of credentials with the same name ([chapter 18](18-cli.md)).

## REST data sources

Shared Components → **REST data sources** → ＋ Add.

| Property | Meaning |
|---|---|
| Name | Uppercase, e.g. `COUNTRIES` |
| Remote server | Optional (sprint 141): a [remote server](#remote-servers) of the workspace, e.g. `CRM`; the URL is then the path after its base URL |
| URL | `https://api.example.com/v1/cities/{city}/weather`: `{name}` is a path parameter. The host is fixed: parameters can only come after it. With a remote server: `/v1/cities/{city}/weather` |
| Method | `GET`, `POST`, `PUT`, `PATCH`, `DELETE` |
| Web credential | The name of a web credential (the application's, else the workspace's), or empty: on a remote server, the server's default credential |
| Parameters | JSON: `[{"name": "city", "in": "path", "default": "&P1_CITY.", "required": true}, {"name": "units", "in": "query", "default": "metric"}]`. `in` is `path`, `query`, `header` or `body`. Defaults may use `&ITEM.` substitutions. `key`: the service's own name for a query, header or body parameter when it isn't lower case with `_`, e.g. `{"name": "page_size", "in": "query", "key": "pageSize"}`; `Authorization`, `Cookie`, `Host` and the transport headers can't be header parameters |
| Headers | JSON: extra request headers, e.g. `{"Accept-Language": "en"}`. Not for secrets (use a web credential); `Authorization`, `Cookie`, `Host` and the transport headers can't be set |
| Body | For `POST`, `PUT`, `PATCH`: a JSON template, `{name}` becomes the parameter's value as a JSON string. Empty: the `body` parameters as a JSON object |
| Row selector | Where the rows are in the response: `items`, `data.results`, `$.list[*]`. Empty: the response itself (an array, or one object as one row) |
| Columns | JSON: `[{"name": "temp", "path": "main.temp", "type": "number"}]`. `name` is the SQL column name; `path` defaults to the name; types `text`, `number`, `integer`, `boolean`, `date`, `timestamp`, `json` |
| Cache (seconds) | `0`: every request calls the service. Otherwise responses are kept in the server's memory for that long, **shared by all users** of the application (per URL, parameters and credential): don't cache personal data |
| Timeout, Maximum rows | Per request (1–60 seconds) and per response |
| Key columns | The columns that identify a row, e.g. `id`: needed for write-back (update, delete, fetch) and for a merge synchronisation |
| Operations | JSON: how forms and grids write rows back ([below](#writing-back-from-forms-and-grids)) |
| Synchronisation | The local table, mode, schedule ([below](#synchronisation-into-a-local-table)) |

Paths: `a.b.c`, `items[0].name`, `$["a key"]`, `list[*]`. Values that don't fit their type become
NULL (a text `"12.5"` is a number, `"yes"` a boolean, a date takes the first ten characters).

**Test** under the source's properties calls the service with the parameter values you type and
shows the status, the first rows, the start of the response and **suggested columns** guessed from
the first rows; **Use these columns** stores them. A source without columns guesses them on every
call; define them so reports keep their columns when the service changes.

Path parameters are URL-encoded (`.` and `..` are refused), query parameters appended, header
parameters sent as headers (one line only), so a value from an item can never change the host.

### Remote servers

A **remote server** (sprint 141; APEX: Remote Servers) is a named base URL of the workspace, kept under Workspace
utilities → **Remote servers** ([chapter 3](03-builder.md#static-workspace-files-remote-servers-and-web-credentials)):
a static id (`CRM`), this installation's base URL (`http://127.0.0.1:3100`) and/or an environment variable
`PGKILN_SERVER_CRM` that wins when set, and an optional default web credential. A source on a server keeps only its
path (`/a/hr/rest/v1/departments`); every call uses the server's URL **of that moment**, so changing the server (or
setting `PGKILN_SERVER_CRM=https://crm.example.com` on the production server) moves every source on it at once,
including write-back, synchronisation, the builder's *Test* and `invoke_api`.

- The resolved URL passes every check a full URL does: the allow-list, the workspace's
  [network access list](03-builder.md#network-access) (whose page lists each server's host) and the address checks
  when the connection is made. A server pointed at a private address is refused unless the installation allows it.
- The path is a path: it starts with `/` or `?` (or is empty), with no `//` or `..` segments, so it can't name another
  host.
- A server that doesn't exist in the application's workspace fails the call with *Remote server X does not exist in
  this application's workspace*. An application export names the server; it imports where the server is missing, and
  the import message and the [Advisor](03-builder.md#advisor) (a warning) name it.
- A [REST source catalog](#rest-source-catalogs) can be on a server too, and so can an
  [AI service](03-builder.md#ai-services).

HR example (part 76): server **CRM** stands for the HR API on `http://127.0.0.1:3100`; DEPARTMENTS, DEPARTMENT and
EMPLOYEES_API name it.

### Regions on a REST data source

A region's **REST data source** property (page designer → Source) makes it read the source's
rows instead of a table. The region's **Source** is then optional SQL over a CTE named `rest`:

```sql
select dname, deptno, location from rest where location <> 'Boston' order by dname
```

Empty means `select * from rest`. Because the rows become SQL (a `jsonb_to_recordset` over the
response, typed by the columns), everything about the region type keeps working: the report's
search, filters, sorting, paging, computed columns, CSV/Excel/PDF downloads, facets, cards,
charts, calendars, maps and template components. The SQL runs as the application's database
role like any region SQL.

Parameter values for the region go into its attributes (`config`):

```json
{"rest_params": {"city": "&P10_CITY.", "units": "imperial"}}
```

Parameters without a value take their default. The service is called once per page view (or
not at all while the cached response is fresh). When it fails, the region shows an error with a
reference; the details (status, message) are in the activity log.

In the builder, the region's column lists (report settings, facets, map, cards) come from the
source's columns, without calling the service.

### Lists of values

A shared list of values with a **REST data source** reads the source's rows from `rest`:

```sql
select name, code from rest order by name
```

Items use it as `LOV:NAME`, as usual ([chapter 5](05-items.md)). Its parameters take their
defaults (which may use `&ITEM.` substitutions).

### Writing back from forms and grids

A source's **Operations** say how a row is inserted, updated, deleted and fetched (APEX: the
operations of a REST Data Source):

```json
{"insert": {"method": "POST", "path": ""},
 "update": {"method": "PUT", "path": "/{id}"},
 "delete": {"method": "DELETE", "path": "/{id}"},
 "fetch":  {"method": "GET", "path": "/{id}"}}
```

| Key | Meaning |
|---|---|
| `method` | Default `POST` (insert), `PUT` (update), `DELETE` (delete), `GET` (fetch); any of `GET`, `POST`, `PUT`, `PATCH`, `DELETE` |
| `path` | Follows the source's URL (without its query): `/{id}`, `?id={id}`. `{column}` takes the row's value, `{param}` a parameter's value, both URL-encoded. No host, no `..`: the host stays the source's |
| `body` | A JSON template: `{column}` becomes the value as JSON (`{"name": {name}}`). Empty: the row's columns as a JSON object, each at its column path (`address.city` becomes nested) |
| `row_selector` | fetch / insert: where the row is in the response (default: the response itself) |

Only the operations you define are offered. Update, delete and fetch need the **key columns**.

- A **form region** on the source (region property *REST data source*, `pk_item` as usual; the key
  column is the region's primary key column or the source's first key column) fetches its row with
  the `fetch` operation, or else by searching the source's rows for the key. Its `form_dml`
  process calls insert, update or delete by the pressed button. A `PUT` update sends the row as the
  service has it with the items' values on top, so columns without an item are kept; after an
  insert, the new key from the response goes into the primary key item.
- An **interactive grid** on the source offers **Add row**, **Save** and **Delete** only for the
  operations the source has. Its `grid_dml` process sends one call per changed row; an update
  sends the row as it was read in this request with the changed columns, so key and read-only
  columns can't be changed from the browser. A failing call stops the save with the service's
  status; rows already sent stay sent (a web service has no transaction).

Every call goes through the allow-list and address checks with the source's web credential, like
a read. Try it with the HR example: page 34 "Contacts (REST)".

### Synchronisation into a local table

A **synchronisation** copies the source's rows into a table of the application (APEX: REST Source
Synchronization), so reports, searches and joins work on a local copy and the service is called
once per run instead of once per page view.

| Property | Meaning |
|---|---|
| Local table | The table, e.g. `app.country_copy`. Columns are matched by name with the source's columns; the others (and identity or generated columns) are left alone, values are cast to the table's types |
| Mode | `merge`: match rows on the key columns, update changed ones, insert new ones. `replace`: delete every row, insert the rows. `append`: insert the rows |
| Delete rows the service no longer returns | `merge` only |
| Schedule, Time zone, Scheduled | A cron schedule (`@hourly`, `0 6 * * 1-5`) run by the automations scheduler ([chapter 6](06-processing.md#automations)) when *Scheduled* is on |

A run happens:

- with **Synchronise now** on the source's page in the builder, which also shows the last runs
  (rows fetched, inserted, updated, deleted, time, message);
- on the schedule;
- from SQL: `select meta.request_rest_sync('CRM_CONTACTS')` queues a run of a source of the
  current application and returns its id; the server's scheduler runs it within its next pass
  (about half a minute) after your transaction commits. `meta.rest_sync_status(id)` returns the
  run as JSON (`status` `queued`, `running`, `ok` or `error`, the counts, `message`). A run
  already waiting is reused.

The table is written in **one transaction as the application's database role** (grants and row
level security apply) with `meta.app_user()` = `rest_sync:<SOURCE>`; a failing run changes
nothing. Two runs of one source never overlap. The last 100 runs per source are kept. An imported
application's synchronisations start switched off. `AUTOMATIONS=off` stops scheduled and queued
runs on that server.

## REST source catalogs

Workspace utilities → **REST Source Catalogs** (APEX: REST Source Catalogs) describes a web service once for the
workspace: a **base URL** (e.g. `https://api.example.com/v1`) and its **services**, each an endpoint with a path after
the base URL (`/pets/{pet_id}`), a method, and the same parameters, headers, body, row selector, columns, key columns
and operations as a [REST data source](#rest-data-sources). Every developer of the workspace manages its catalogs.

A catalog comes from:

- an **OpenAPI 3.x or Swagger 2.0 document** in JSON (*Import a catalog*: upload `openapi.json`, paste it, or give its
  URL, which the server reads, so the host must be on the [allow-list](#server-configuration-and-the-allow-list));
- a **catalog file** downloaded from another workspace or installation (*Download* on the catalog's page);
- **by hand**: a name and base URL, then *Add a service*.

A catalog may name a **remote server** of the workspace (the catalog's page, *Remote server*; sprint 141): its services
are then paths after the server's URL, and the base URL is optional.

Reading an OpenAPI document, pgkiln takes for each `GET`, `POST`, `PUT`, `PATCH` and `DELETE` operation:

| From the document | Becomes |
|---|---|
| `operationId` (or the method and path) | The service's name, e.g. `listPets` → `LIST_PETS` |
| `servers[0].url` (variables at their defaults; Swagger 2: `schemes`, `host`, `basePath`) | The base URL. A relative one is read against the document's URL; or type the base URL |
| `path`, `query` and `header` parameters (also the path's own) | Parameters: `petId` → `pet_id`, with `"key": "petId"` when the service's name differs; a schema `default` (or an `example`) as the default |
| The scalar properties of a JSON request body | `body` parameters (nested objects and lists need a body template) |
| The JSON schema of the `200`/`201` (or `default`) response | The row selector (a list, or the list property of an object such as `items`, `data` or `results`) and the columns with their types (`integer`, `number`, `boolean`, `date`, `date-time` → `timestamp`, objects and lists → `json`) |
| A collection `GET /pets` with `GET`, `PUT`/`PATCH`, `DELETE /pets/{petId}` and `POST /pets` | Key columns and [write-back operations](#writing-back-from-forms-and-grids) on the collection's service, when the item's parameter names a column (`pet_id`, else `id`) |

`$ref`s inside the document and `allOf` are followed. What a data source can't use (cookie and form parameters, the
`Authorization` header, external `$ref`s, `HEAD` and `OPTIONS`) is listed after the import, never dropped silently.
YAML documents: convert them to JSON first (most services offer `openapi.json` too).

**Making a data source from a catalog**: an application's Shared Components → REST data sources → ＋ Add shows *From a
REST source catalog* when the application's workspace has catalogs: pick a service, optionally another name and one
of the web credentials (the application's or the workspace's). The data source is a **copy** (URL = base URL + path; on a
catalog with a **remote server**, sprint 141: the server and the path, so the source moves with the server): changing or deleting the
catalog later doesn't change it, and *Replace from a document* on a catalog's page replaces only the catalog's
services. Credentials never belong to a catalog: each application signs in with its own web credential.

Catalogs belong to the workspace (migration 095): they are not part of an application's export, but of the
[workspace export](03-builder.md#export-and-import).

## The `invoke_api` process

A page process of type `invoke_api` ([chapter 6](06-processing.md#processes)) calls a web service.
Its **Configuration** (JSON) names a source:

```json
{"source": "DEPARTMENT", "params": {"deptno": "&P23_DEPTNO."},
 "items": {"P23_DNAME": "dname", "P23_LOCATION": "location"}}
```

or a URL, with method, credential and body:

```json
{"url": "https://api.example.com/orders/&P5_ID./notes", "method": "POST", "credential": "SHOP_API",
 "body": "{\"note\": &P5_NOTE.}", "items": {"P5_NOTE_ID": "id"}, "status_item": "P5_STATUS"}
```

| Key | Meaning |
|---|---|
| `source` / `params` | A REST data source and its parameter values (`&ITEM.` substitutions) |
| `url` | Instead of a source: the URL. `&ITEM.` substitutions only after the host, URL-encoded |
| `method`, `credential` | With `url`: `GET` (default), `POST`, `PUT`, `PATCH`, `DELETE`; a web credential's name |
| `body` | With `url`: a JSON template; each `&ITEM.` becomes the item's value as a JSON string |
| `items` | Item → JSON path in the response. Without it (and with a source), the first row's columns set the items named like them |
| `status_item` | An item for the HTTP status. With it, an error status does not fail the process (the page can react to it); without it, a status outside 200–299 fails the process |

Only items of the page and application items can be set. A failing call stops the processing
like a failing SQL process: the user sees a message with a reference, the details go to the
activity log ([chapter 6](06-processing.md#error-handling)).

A workflow calls a web service with an **`invoke_api` step** instead: the same keys, with
`variables`, `status_variable` and `response_variable` for the items, `&VAR.` for workflow
variables and an optional `timeout` ([chapter 6](06-processing.md#invoke-api-steps)).

## JSON sources and document views

(Sprint 142; APEX: Shared Components → Data Sources → **JSON Sources**, and JSON Relational **Duality Views**.)
A `jsonb` column is a single text item to a form, and one cell to a report. A **JSON source** describes the
documents in such a column with a **data profile**, and pgkiln makes updatable views from it, so forms, reports,
interactive grids, master-detail pages, REST (AutoREST) and MCP read and write the documents' values like columns
of a table.

### A JSON source

Shared Components → Data Sources → **JSON Sources** → *Add JSON source*:

- **Table and jsonb column**: a column of an ordinary table (`hr.emp.profile`), or the one document column of a
  *table of documents* (`id`, `doc`). The table needs a primary key: the views find their row by it. The list
  shows the json and jsonb columns of the tables your SQL Workshop connection may use (an isolated workspace: its
  own schemas).
- **View**: the name of the view, made in the table's schema.
- **The view also adds and deletes rows of the table**: for a table of documents. Off (the default), the view
  only changes the documents of existing rows; an insert or delete through it is refused.
- **Propose from the data** reads up to 200 documents and proposes the profile: a **column** per path to a value
  (nested objects become `office_city` for `office.city`), typed from the values it found (`integer`, `numeric`,
  `boolean`, `date`, `timestamptz` for ISO date-times, `text`, `jsonb` for mixed or nested values), and an **array**
  per list in the documents: a list of objects gets a column per key, a list of values (`["en", "nl"]`) one column
  for the value itself (an empty path). Names, paths and types stay editable; columns you already named are kept.
  A column can be **read only**.

**Create views** (the source's page) makes them in one transaction with your SQL Workshop connection and records
the statements in the [Change Log](03-builder.md#change-log); *Open in the SQL Worksheet* shows them first. After
changing the profile, *Make the views again* drops and makes them (a view other objects depend on can't be
dropped: the error says which). The views are ordinary database objects of your application, like the table:
put the statements in your own migration scripts for the other environments (the source itself travels with the
application's export as `json_sources`).

For `hr.emp.profile` with `{"title": "Analyst", "since": "1987-04-19", "office": {"city": "Dallas"},
"skills": [{"name": "SQL", "level": 5}], "badge": {"color": "blue"}}` the HR example's source EMP_PROFILE makes:

| View | Columns | One row per |
| --- | --- | --- |
| `hr.emp_profile` | `empno`, `title`, `since` (date), `office_city`, `office_floor` (integer), `remote` (boolean) | employee |
| `hr.emp_profile_skills` | `empno`, `row_key`, `position`, `skill`, `level` (integer) | element of `skills` |
| `hr.emp_profile_languages` | `empno`, `row_key`, `position`, `language` | element of `languages` |

- A value that doesn't read as its column's type (`"floor": "ground"`) shows **NULL** in that column instead of
  failing the whole query (`meta.input_ok`, PostgreSQL's `pg_input_is_valid`).
- **Writing keeps what the profile doesn't know.** An `UPDATE` of the view writes only the paths whose values
  changed, into the row's document, in one `UPDATE` of the table (`meta.jsonb_patch`): `badge` above, or any key a
  newer version of another program added, stays. Setting a column to NULL removes its key; a path to a nested
  object makes the objects on the way. The key columns are never changed through the view.
- **Arrays as rows.** An array view has the table's key, `row_key` and `position` (1, 2 …) and the element's
  columns. `row_key` is the element's contents (an md5) and its occurrence among equal elements: it stays the same
  when other elements are added, changed or removed, so deleting two rows of a grid in one save removes the right
  two. An `INSERT` appends an element (the table's key column says to which row), an `UPDATE` patches one
  (unknown keys of the element stay), a `DELETE` removes it. An element that someone changed meanwhile is no
  longer found and the statement fails (*Reload and try again*): nothing is overwritten.
- **Security.** The views are `security_invoker` and get the table's grants (SELECT, INSERT, UPDATE, DELETE of each
  role that has them on the table). Their INSTEAD OF triggers (`meta.json_source_write`, `meta.json_array_write`)
  are SECURITY INVOKER too: they write the table as the role that writes the view, so its grants and the table's
  row level security apply, exactly as for a direct `UPDATE`.

### Pages on a JSON source

The views work everywhere a table does: Create Page, a form's or report's source, the interactive grid, AutoREST
and MCP. **Create page** on the source's page makes a form on the view with a **detail grid per array** (the
grid's master is the form's key item, `position` read only, `row_key` hidden) and their save processes; open it
with the key in the URL, for example from a report's link. HR page 51 *Employee profiles* (Administration) is
such a page with a report on top:

```sql
-- the report's source: hr.emp with its jsonb column
select empno, ename, job, profile from hr.emp order by profile is null, ename
```

### JSON path columns in reports

A report region's **JSON path columns** (Page Designer → the report's settings) add columns read from a json or
jsonb column of its query, without writing the SQL: `name=column:path[:type]`, separated by `;`:

```
title=profile:title; first_skill=profile:skills.0.name; since=profile:since:date
```

A path is keys separated by dots; a number picks an element of an array (`skills.0.name`). They are columns like
the others: search, filters, sorting, control breaks, aggregates, headings, format masks and downloads. In the
region's JSON: `"json_columns": [{"name": "title", "column": "profile", "path": "title", "type": "text"}]`.

### Document views (duality views)

SQL Workshop › Table Properties → **Document view…** (or a table's ⋯ menu) makes a view with the table's key and a
`jsonb` document per row: the row's columns and, per **child table** you tick (tables whose foreign keys reference
it), a list of its rows without the foreign key columns:

```json
{"deptno": 10, "dname": "ACCOUNTING", "loc": "NEW YORK",
 "emp": [{"empno": 7782, "ename": "CLARK", "job": "MANAGER", "sal": 2450}, …]}
```

Writing the document back (`update hr.dept_doc set doc = $1 where deptno = 10`, or a PUT through AutoREST on the
view) updates the row's columns the document names, **upserts** the children it lists (by their key; one without
a key is inserted) and **deletes** the children it leaves out. A document without the list leaves the children
alone. An `INSERT` of a document inserts the row and its children, a `DELETE` removes the children and the row.
Full-text and vector columns are left out of the documents. Like APEX's duality views this gives REST clients and
MCP tools one document per business object; the trigger (`meta.json_document_write`) is SECURITY INVOKER, so the
tables' grants and row level security apply to every row it touches.

## Export, import and application files

The export ([chapter 3](03-builder.md#export-format)) has two new sections: `web_credentials`
(without secrets, OAuth2 passwords or refresh tokens) and `rest_sources` (with operations and
synchronisation settings, without the synchronisation's next and last run; an import switches
the schedule off). In the directory format they are
`shared/web-credentials/` and `shared/rest-sources/` ([chapter 18](18-cli.md)). Regions, lists of
values, processes and workflow steps refer to sources and credentials by name, so nothing needs remapping.
JSON sources are part of the application (`json_sources`, in `app.yaml` of the directory format); their
views are not: they belong to your schema's migration scripts, like the table.

## Security notes

- Outgoing calls are off until the administrator sets `PGKILN_REST_ALLOWED_HOSTS`; private and
  internal addresses need `PGKILN_REST_PRIVATE_HOSTS` as well.
- A workspace's [network access list](03-builder.md#network-access) narrows the allow-list for its
  applications (it can't widen it).
- A [remote server](#remote-servers)'s URL is checked like any other URL; its environment variable can only be a
  `PGKILN_SERVER_…` name, so no other part of the server's environment becomes a URL. Only the workspace's
  administrators change its servers and credentials.
- Secrets are encrypted with a key outside the database, write-only in the builder, excluded from
  exports and from the runtime role, and never logged. Use **Valid for URLs** so a credential is
  only ever sent to its own service.
- A cached response is shared by every user of the application. Cache only data every user of
  the region may see, or set the cache to 0.
- Developers decide which services an application calls (like the SQL it runs); end users only
  supply parameter values, which are encoded and can't change the host.
- Write-back operations only take a path after the source's URL; row values in it are
  URL-encoded. End users can only write back through a form or grid a page offers them, with the
  operations the source defines; authorization of the page, region and process applies as usual,
  and the service itself still decides what the credential may change.
- A synchronisation writes as the application's role: grant it only the table it fills.
  `meta.request_rest_sync()` works only for the current application's sources.
- [`meta.web_request()`](09-reference.md#web-requests-from-sql) (requests from application SQL)
  goes through the same allow-list, address checks, size limit and credential URL limits; it names
  a credential of the current application and never sees its secret. Requests and responses are
  stored for 24 hours, readable through `meta.web_response()` by the application's code only.
- Treat responses as untrusted data: they are escaped like any other value in reports, cards and
  items.
