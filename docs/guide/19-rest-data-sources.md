# 19. REST data sources and web credentials

An application can read data from other web services and call them (APEX: REST Data Sources,
Web Credentials and the Invoke API process):

- a **web credential** says how pgapex signs in to a web service: HTTP basic authentication, an
  HTTP header (an API key), a bearer token, or OAuth2 client credentials. Its secret is stored
  encrypted and is never shown again;
- a **REST data source** is an endpoint (URL with parameters, method, credential, headers) whose
  JSON response becomes typed rows. Reports, cards, charts, calendars, maps, trees, template
  components and shared lists of values can read those rows like a table;
- the **`invoke_api` process** calls a source or a URL when a page is submitted (or loaded) and
  puts values of the response into items.

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
| Authentication | `basic` (user name + password), `header` (an HTTP header with the secret, e.g. `X-API-Key`), `bearer` (`Authorization: Bearer <secret>`), `oauth2` (client credentials) |
| User name / client id | `basic`: the user name; `oauth2`: the client id |
| Header name | `header`: the header that carries the secret |
| Token URL, Scope | `oauth2`: the token endpoint and the scope to ask for |
| Secret | The password, header value, token or client secret. **Write-only**: it is encrypted by the server, never shown again (the form says whether one is stored), never exported. Leave it empty to keep the stored one; **Remove the secret** clears it |
| Valid for URLs | URL prefixes the credential may be sent to, e.g. `https://api.example.com/v2/`. Recommended: a source or process that points elsewhere fails instead of sending the secret |

For `oauth2`, pgapex asks the token endpoint for an access token (`grant_type=client_credentials`,
the client id and secret with HTTP basic authentication), keeps it until 30 seconds before it
expires, renews it with the refresh token when the endpoint gave one, and asks for a new one when
the service answers 401. Tokens are kept in the server's memory only.

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

## Export, import and application files

The export ([chapter 3](03-builder.md#export-format)) has two new sections: `web_credentials`
(without secrets) and `rest_sources`. In the directory format they are
`shared/web-credentials/` and `shared/rest-sources/` ([chapter 18](18-cli.md)). Regions, lists of
values and processes refer to sources and credentials by name, so nothing needs remapping.

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
- Treat responses as untrusted data: they are escaped like any other value in reports, cards and
  items.
