# 19. REST data sources and web credentials

An application can read data from other web services and call them (APEX: REST Data Sources,
Web Credentials and the Invoke API process):

- a **web credential** says how pgapex signs in to a web service: HTTP basic authentication, an
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

Both are **Shared Components**. The server only calls hosts its administrator allows
([below](#server-configuration-and-the-allow-list)): out of the box, no outgoing request is made.

Try it with the HR example: page 23 "Web services" reads the HR example's own REST module
([chapter 13](13-rest-api.md#rest-modules-in-the-builder)), so no internet is needed. Set
`PGAPEX_REST_ALLOWED_HOSTS=127.0.0.1` and `PGAPEX_REST_PRIVATE_HOSTS=127.0.0.1` in `.env` and
restart the server.

## Server configuration and the allow-list

| Variable | Default | Meaning |
|---|---|---|
| `PGAPEX_REST_ALLOWED_HOSTS` | *(none: no calls)* | Hosts pgapex may call, comma separated: `api.example.com`, `*.example.com` (any subdomain), `api.example.com:8443` (only that port), `*` (any **public** host) |
| `PGAPEX_REST_PRIVATE_HOSTS` | *(none)* | Hosts that may resolve to private, loopback or link-local addresses (e.g. a service in your own network, or `127.0.0.1`); listing a host here also allows it |
| `PGAPEX_SECRET_KEY` | *(none)* | Encrypts the secrets of web credentials (AES-256-GCM); at least 32 characters, e.g. `openssl rand -base64 32`. Without it, secrets can't be saved or used |
| `PGAPEX_REST_MAX_BYTES` | `5000000` | Largest response pgapex reads (also after decompression) |

The checks on every outgoing request (`src/webclient.ts`), against server-side request forgery:

- only `http` and `https`; no user name or password in the URL (use a web credential);
- the host must match `PGAPEX_REST_ALLOWED_HOSTS` (or `PGAPEX_REST_PRIVATE_HOSTS`);
- the addresses the host name resolves to are checked **when the connection is made**, and the
  connection goes to the checked address, so DNS rebinding can't swap it. Private (10/8,
  172.16/12, 192.168/16, fc00::/7), loopback, link-local (169.254/16, including cloud metadata
  services, fe80::/10), carrier-grade NAT, multicast, documentation and other special ranges are
  refused, also when written as IPv4-mapped, NAT64 or 6to4 IPv6 addresses, unless the host is in
  `PGAPEX_REST_PRIVATE_HOSTS`;
- redirects are followed at most 3 times, only to URLs that pass the same checks; the
  credential's headers are dropped when a redirect leaves the original origin;
- a time limit for the whole exchange (the source's timeout, at most 60 seconds) and the size
  limit above.

Keep the allow-list as short as you can. `*` lets developers call any public host from the
server; it never opens private addresses.

**Changing `PGAPEX_SECRET_KEY`** makes the stored secrets unreadable: pgapex then reports that
the secret must be entered again. Keep the key with your other server secrets, outside the
database: a database dump alone does not reveal the secrets.

## Web credentials

Shared Components → **Web credentials** → ＋ Add.

| Property | Meaning |
|---|---|
| Name | Uppercase, e.g. `WEATHER_API`; sources and processes use the credential by this name |
| Authentication | `basic` (user name + password), `header` (an HTTP header with the secret, e.g. `X-API-Key`), `bearer` (`Authorization: Bearer <secret>`), `oauth2` |
| Grant type | `oauth2`: `client_credentials` (default), `password` or `refresh_token` ([below](#oauth2-grant-types)) |
| User name / client id | `basic`: the user name; `oauth2`: the client id |
| OAuth2 user name | `oauth2` with `password`: the user pgapex signs in as |
| Header name | `header`: the header that carries the secret |
| Token URL, Scope | `oauth2`: the token endpoint and the scope to ask for |
| Secret | The password, header value, token or client secret. **Write-only**: it is encrypted by the server, never shown again (the form says whether one is stored), never exported. Leave it empty to keep the stored one; **Remove the secret** clears it |
| OAuth2 password, Refresh token | `oauth2`: the password of the OAuth2 user (`password` grant), or a refresh token obtained elsewhere (`refresh_token` grant). Write-only like the secret, each with its own **Remove** button |
| Valid for URLs | URL prefixes the credential may be sent to, e.g. `https://api.example.com/v2/`. Recommended: a source or process that points elsewhere fails instead of sending the secret |

For `oauth2`, pgapex asks the token endpoint for an access token, keeps it until 30 seconds before
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

When the token endpoint returns a refresh token, pgapex **stores it encrypted** in the credential
(and replaces it when the endpoint rotates it), so it survives a restart and is shared by several
servers. When a refresh fails, the `password` grant signs in again; the `refresh_token` grant can't,
and the error says to enter a new refresh token in the builder.

The runtime database role can read a credential's settings but not its secret column; the server
loads the secret with the owner connection, decrypts it only for the request, and never puts it
into an error message or the activity log.

After an **import**, the credentials are there without secrets: enter them again. `pgapex import
--replace` keeps the secrets of credentials with the same name ([chapter 18](18-cli.md)).

## REST data sources

Shared Components → **REST data sources** → ＋ Add.

| Property | Meaning |
|---|---|
| Name | Uppercase, e.g. `COUNTRIES` |
| URL | `https://api.example.com/v1/cities/{city}/weather`: `{name}` is a path parameter. The host is fixed: parameters can only come after it |
| Method | `GET`, `POST`, `PUT`, `PATCH`, `DELETE` |
| Web credential | The name of a web credential, or empty |
| Parameters | JSON: `[{"name": "city", "in": "path", "default": "&P1_CITY.", "required": true}, {"name": "units", "in": "query", "default": "metric"}]`. `in` is `path`, `query`, `header` or `body`. Defaults may use `&ITEM.` substitutions |
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

## Export, import and application files

The export ([chapter 3](03-builder.md#export-format)) has two new sections: `web_credentials`
(without secrets, OAuth2 passwords or refresh tokens) and `rest_sources` (with operations and
synchronisation settings, without the synchronisation's next and last run; an import switches
the schedule off). In the directory format they are
`shared/web-credentials/` and `shared/rest-sources/` ([chapter 18](18-cli.md)). Regions, lists of
values, processes and workflow steps refer to sources and credentials by name, so nothing needs remapping.

## Security notes

- Outgoing calls are off until the administrator sets `PGAPEX_REST_ALLOWED_HOSTS`; private and
  internal addresses need `PGAPEX_REST_PRIVATE_HOSTS` as well.
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
- Treat responses as untrusted data: they are escaped like any other value in reports, cards and
  items.
