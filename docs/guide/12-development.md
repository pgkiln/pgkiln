# 12. Developing pgkiln

This chapter is for people who work on pgkiln itself. See also [CONTRIBUTING.md](../../CONTRIBUTING.md).

## Code map

```
db/
  migrations/NNN_*.sql     the meta schema, roles and SQL API; applied once each, in order
  seed/*.sql               the HR sample (not for production)
examples/                  example applications as SQL (the tutorial)
examples/plugins/          plug-in files (template components) to import
examples/gallery/          the App Gallery: gallery.json, starters/ and utilities/ (blueprints), samples/ (single-file sample apps)
scripts/migrate.ts         migration/seed runner (src/migrate.ts does the work)
website/                   the website pgkiln.vargar.eu (VitePress): landing page + this guide, synced from docs/ at build time;
                           cd website && npm install && npm run dev; scripts/deploy.sh publishes it (see website/deploy/)
scripts/screenshots.ts     the README's screenshots in docs/images/ (npm run screenshots, HR example)
scripts/docker-start.ts    container entry point: checks secrets, migrates (locked), sets role and admin passwords, starts the server
deploy/                    compose.yaml and .env.example for Docker (Dockerfile at the root; chapter 1)
bin/pgkiln.js              the `pgkiln` command line (runs src/cli/main.ts with tsx)
src/
  env.ts                   .env loader (imported first)
  migrate.ts               applies db/migrations and examples (scripts/migrate.ts, pgkiln migrate); logs each run that applies
  instance.ts              instance settings (meta.setting over environment variables, cached 30 s) and the configuration overview
  release-check.ts         (sprint 109) "pgkiln X is available": meta.setting 'release_check' over PGKILN_RELEASE_CHECK (off by default);
                           GitHub's releases/latest (PGKILN_RELEASE_URL in tests), 5 s timeout, 1 MB, cached a day per process,
                           never under node --test without PGKILN_RELEASE_URL; parseRelease keeps a semver and an https link only
                           or fails a file in public.pgkiln_install_log
  appfiles.ts              application export as one file per component (dir layout, static ids) and back
  blueprint.ts             blueprints (migration 063): checkBlueprint (names, types, references, pages, sample rows), tableOrder,
                           blueprintSql, buildBlueprint (tables, grants, rows, pages via meta.generate_page, menu), the AI draft schema
  blueprint-from-app.ts    (sprint 66) blueprintFromApp: an application's tables (catalog), pages and menu as a blueprint, notes; sample rows
  restcatalog.ts           (095) REST source catalogs: checks, fromOpenApi (OpenAPI 3 / Swagger 2 → services: parameters with "key",
                           rows and columns from the response schema, write-back from collection and item paths, notes), catalog
                           files, load/insert/replace, sourceFromService
  workspace-export.ts      (sprint 67) a workspace's components as a file (pgkiln-workspace/1) and importWorkspace (one transaction)
  team.ts                  (sprint 113) Team Development's data: workspaceDevelopers (members and administrators: assignees, @mentions),
                           issueHtml (markdownHtml + mentions), recordMentions, logIssue (history), teamSetup, teamCounts, pageIssues,
                           exportTeam / importTeam (the workspace export's "team" part)
  team-samples.ts          (sprint 113) the set-up wizard's samples per builder language (English; add a key for another)
  subscriptions.ts         application types and subscriptions (migration 056): offers, subscribe, refresh, publish, in sync
  workingcopy.ts           working copies (migration 055): create, three-way compare per component (base, main, copy),
                           merge into the main application or refresh the copy, both through cli/replace.ts
  cli/                     the command line: main.ts (commands, help, exit codes), apps.ts (connect, export,
                           read, import), files.ts (directories, zip), diff.ts, replace.ts (import --replace in place),
                           mcp.ts (`pgkiln mcp`: the MCP server for AI coding agents, chapter 20), only.ts (sprint 116:
                           `import --replace --only pages/12`, the named files merged over the application's current export)
  app.ts / server.ts       Fastify setup / entry point
  db.ts                    the owner and shared runtime pools, `runtime` (the current scope's: runtimeScope), appTx() (SET LOCAL ROLE + pgkiln.* settings, NOTICEs to the debug log), savepoints
  workspace-db.ts          isolated workspaces (090): the isolated applications (cached 5 s), a pool per workspace login (passwords from
                           PGKILN_SECRET_KEY), runtimeForApp/runtimeForAlias, withAppDb, devDbForApp; app.ts scopes /a/:alias requests
  security.ts              URL checksums, password policy, security headers (CSP nonce), throttling limits
  ddl.ts                   Generate DDL and Schema Comparison: readSchema (catalog → one DDL per object, unqualified), ddlScript (order), compare, changeScript
  static-version.ts        the version of app.css, app.js, icons.svg and sw.js (?v= in their URLs, the service worker version): content hash, looked at again when a file changes
  session.ts               sessions (hashed tokens), activity log, login throttling
  sso.ts                   OpenID Connect: discovery, sign-in flow, ID token checks, account linking
  saml.ts                  SAML 2.0 sign-in (node-saml): AuthnRequest, response checks, SP metadata
  ldap.ts                  LDAP directories: search + bind, groups, account linking (ldapts)
  devsso.ts                (sprint 129) developers through identity providers and directories: resolveDeveloper (subject, link, create,
                           administrators group), linkDeveloper, ssoRequired (a workspace's rule, break-glass), clearSsoOnly
  headerauth.ts            HTTP-header authentication: trusted proxies (PGKILN_AUTH_HEADER_PROXIES), header checks, accounts
  dbauth.ts                database-account authentication: role lists, a short connection as the role (DATABASE_URL target), membership/superuser checks
  customauth.ts            custom authentication: the app's function or PL/pgSQL body (a pg_temp function) and post-authentication code, as the app's role
  remember.ts              "Keep me signed in": rotating persistent sign-in tokens
  mfa.ts                   second factors: TOTP, recovery codes, a FactorStore per kind of user (developers, accounts);
                           the developers' policy, passkeys, trusted browsers (webauthn.ts: WebAuthn checks)
  account-mfa.ts           (sprint 130) two-factor sign-in for application accounts: the application's rule (off, optional,
                           required, roles), secondStep, carriesSecondStep (remembered/shared sign-ins), resets
  workflow.ts              workflows: step checks, the runner with parallel branches (NOTIFY + polling), invoke_api steps
                           (the call between two transactions, with a lease), Advisor references, the diagram;
                           (sprint 114) send_mail and draft steps, switch cases on task outcomes, the diagram as a standalone SVG
  task-events.ts           (sprint 114) task events (complete, expire, fail: SQL, mail, start a workflow) and built-in task
                           notifications from e-mail templates: checks, the actions as the app role, the meta.task_hook outbox runner
  process-jobs.ts          background execution chains: the job queue (SKIP LOCKED, NOTIFY + polling), running a job as the app role
  api.ts                   REST API tokens for PostgREST, API role checks
  accounts.ts              account settings and the password policy
  i18n.ts                  pgkiln's own texts (en, nl), translator, Accept-Language
  i18n/                    de, fr, es, it, pt, pl, sv, da, nb, fi, cs, tr, el, ru, uk, ja, zh, ko, ar, he: the built-in texts of
                           the other languages (English and Dutch are in i18n.ts)
  numformat.ts             number format masks (999G990D00): format, parse, language separators
  binds.ts                 :BIND scanner → escaped literals, splitStatements, SqlParams (query parameters) (unit tested)
  dataload.ts              CSV/XLSX/JSON/XML parsing, type inference, batched loading with row errors, data load definitions (mapping, transformations, format masks)
  sampledata.ts            Sample Data: describe() (catalog: identity, checks, enums, foreign keys), propose(), seeded generators, plan() (dependency order), insertRows() / generateAll(), SQL and CSV output
  sampledata-words.ts      built-in name, city, company and word lists of Sample Data
  unload.ts                Unload Data: unloadStatement() (one SELECT), openUnload() (cursor, batches, CSV/JSON/XLSX/XML encoders on Postgres text values)
  xml.ts                   safe XML reader (no DTDs or entities, limits) and xmlTable(): rows from a repeating element (unit tested)
  sqlscript.ts             SQL scripts: splitScript() (statements, line numbers and offsets, psql commands), runScript() (stop/continue, transaction, savepoints)
  sqlworksheet.ts          (sprint 91) the worksheet's runs: pickStatements() (at the cursor, a selection, all), runStatements() (a log per
                           statement, psql command tags, notices, error line and column), explainStatement() (EXPLAIN / rolled-back ANALYZE;
                           a savepoint inside a worksheet transaction)
  worksheet-txn.ts         (sprint 107) the worksheet's transaction mode: an in-memory registry of pinned pg.Clients per (builder session,
                           worksheet tab), beginTxn() / endTxn() (caps per developer and server), accountRun() (statement count, DDL kept for
                           the Change Log until COMMIT), outsideTxnOnly(), sweepTxns() (idle timeout, ended sessions); onSessionEnd and
                           onClosePools roll back; WORKSHEET_TXN_IDLE_SECONDS / _MAX_PER_DEVELOPER / _MAX
  datamodel.ts             (sprint 98) Data Modeler diagrams: readModel() (catalog), boxSize(), fkPath() (crow's feet), autoLayout(), diagramSvg()
  changelog.ts             (sprint 106, migration 118) the change log: isSchemaDdl(), ddlTarget() (schema and object), changeName()
                           (add_bonus, create_index_x), recordChanges() (grouped per schema), Flyway / Liquibase / plain SQL writers
  datasets.ts              (sprint 110, migration 120) Data Reporter datasets: checkDataset() (names, joins to earlier tables, columns
                           and filters on its tables, whitelisted operators; with a catalog: existing objects), datasetSql() (quoted
                           identifiers, literal values), readSchemaCatalog() (tables, views, columns, foreign keys), proposeJoin() /
                           proposeDataset(), storeDataset(), appDatasets() (the runtime's read), pgkiln-dataset/1 files
  reporting-app.ts         (sprint 110) reporting applications: createReportingApp() (createApp, SELECT-only grants on the datasets'
                           objects, type reporting, roles viewer/editor/administrator as schemes EDITOR and ADMIN, page 1 a Data
                           Reporter), reportingApps(), reportingAppCount() (meta.reporting_app_count, for the workspace home)
  tabledef.ts              (sprint 95) a table as a definition: readTable(), checkTable(), tableSql() (CREATE, or ALTER from the catalog's version)
  datasec.ts               (sprint 119, WS-13) data security per table: readSecurity() (policies, column privileges per role, the
                           masking view and its configuration in the view comment), checkSecurity(), securitySql() (GRANT / REVOKE,
                           the masking view owned by <schema>_masking); the page is builder/data-security.ts
  sqlformat.ts             (sprint 93) formatSql(): the worksheet's Format (clauses per line, keyword case; strings and comments kept)
  sqlplan.ts               (sprint 92) EXPLAIN (FORMAT JSON) as a tree: parsePlan() (self time, slowest step, misestimates), planText()
  quicksql.ts              Quick SQL: shorthand parser and PostgreSQL DDL generator (unit tested)
  xlsx.ts                  Excel writer for report downloads and Unload Data (typed cells, streamed through fflate's Zip)
  automations.ts           cron parser, next run in a time zone, scheduler (also meta.task_expire_tick, 094), running automations (the actions run
                           in PL/pgSQL: meta.automation_execute, shared with meta.run_automation; migration 044)
  html.ts                  auto-escaping html`` templates
  richtext.ts              rich text and Markdown items: allow-list HTML sanitiser, Markdown renderer
  qrcode.ts                QR code encoder (byte mode, versions 1–40) and SVG output for the qrcode item
  css.ts                   PageCss: data-dependent styles as classes in the page's nonce'd <style> (CSP)
  metadata.ts              types + loaders for apps and pages (components of excluded build options are left out here)
  maptiles.ts              map tile server URL, attribution and CSP origin
  geocode.ts               the installation's geocoder for address items (GEOCODER_URL, Nominatim search API)
  mvt.ts                   Mapbox Vector Tile encoding for map layers served as tiles
  yamltext.ts              the text style of the directory export: a strict YAML subset, written and read
  webclient.ts             outgoing HTTP to web services: allow-list, address checks at connect time (SSRF), redirects, limits;
                           (sprint 118) a request's scope (OutboundScope): the workspace's network access list, checked on every hop
                           (checkUrl/scopeProblem), refusals reported to the scope
  network-acl.ts           (sprint 118, WS-9) workspace network access lists (meta.workspace.network_*): scopeForApp/scopeForWorkspace
                           (no cache), parseHostList, recordRefusal/purgeRefusals (meta.network_refusal, 7 days), mailHostAddress
                           (a workspace mail service's SMTP host: both lists, resolved once, the checked address connected to)
  datapump.ts              (sprint 103, DA-16) Schema Export / Import jobs (meta.dump_job): findTools (pg_dump/pg_restore ≥ the
                           server's major), startExport (pg_dump, argument array, PGPASSWORD), readToc/parseToc (pg_restore --list),
                           startImport (pg_restore -f - run in one transaction between schema renames; data-only in FK order),
                           cancel, delete, dumpTick (interrupted jobs, expired files; called by the scheduler)
  dumpscript.ts            (sprint 103) the import's script runner: ScriptLexer (psql-style split, COPY data, \restrict),
                           checkStatement (only the dump's schema; no roles, DO, COPY to/from files…), COPY FROM STDIN as a pg submittable
  dbroles.ts               (sprint 99, DA-13) Database Users' SQL: roleSql (CREATE/ALTER ROLE, memberships, search path, schema
                           and default privileges: only what differs from the catalog), dropSql, checkRole/checkPassword,
                           scramVerifier (SCRAM-SHA-256, SASLprep) and the password slot (maskSql for review and log, withVerifier to run)
  cron-schedule.ts         (sprint 101, DA-12) pg_cron schedules without a database: parseSchedule (cron fields, $, n seconds, macros),
                           nextRuns in a time zone, describeSchedule in words, the builder's presets and fields
  pgcron.ts                (sprint 101, DA-12) pg_cron for SQL Workshop → Scheduling: cronState (installed, loaded, cron.database_name,
                           access), jobs and runs, jobSql/activeSql/unscheduleSql/purgeSql (reviewed, then applySql), runNow
  secrets.ts               secrets at rest (web credentials): AES-256-GCM with PGKILN_SECRET_KEY
  websources.ts            web credentials (OAuth2 client credentials/password/refresh token grants, token cache, stored refresh
                           tokens) and REST data sources: requests, JSON paths, typed rows, response cache, write-back operations
                           (callOperation); invoke(): the invoke API call shared by the invoke_api process and workflow step
  restsync.ts              REST data source synchronisation into a local table (merge/replace/append as the app role), run log,
                           syncTick() (scheduled and SQL-queued runs, called by the automations scheduler)
  webrequests.ts           web requests from SQL (meta.web_request, migration 052): runPending() after each sql page process
                           (same transaction), webRequestTick() for committed ones (automations scheduler), retention purge;
                           calls go through websources.ts call()/invoke() (allow-list, SSRF checks, credentials)
  mail/                    e-mail (migration 081): providers.ts (one deliver() per provider: SMTP through nodemailer with a password
                           or XOAUTH2, Microsoft Graph sendMail, Amazon SES v2 raw MIME with signV4, Resend, Postmark, SendGrid,
                           Mailgun, log; MailError says whether a retry may help; client-credentials token cache; settingsProblems),
                           mail.ts (sendWith(): service enabled, allowed sender, secret decrypted; mailTick(): claim with SKIP LOCKED,
                           send, retry after 1/4/16/64 minutes, purge after 30 days; the NOTIFY pgkiln_mail listener);
                           (sprint 118) the service of meta.mail_service_for_app (the app's, else its workspace's own), each attempt's
                           provider and duration, serviceSettings()/verifyService(): a workspace service's checks (no base or token URL,
                           its SMTP host through network-acl.ts mailHostAddress)
  ai/                      AI services (migration 060): types.ts (the provider interface, AiError kinds),
                           anthropic.ts (Claude through @anthropic-ai/sdk: streamed, effort, structured outputs via
                           output_config.format, refusal fallbacks, stop_reason checks, typed SDK errors), openai.ts (the openai
                           SDK: Chat Completions, strict json_schema), service.ts (generate(): service allowed for the app, daily
                           limits, the call, meta.ai_usage), requests.ts (meta.ai_generate from SQL: runPendingAi() after an sql
                           process, aiRequestTick() in the scheduler, 24-hour purge), chat.ts (conversations with tools, migration
                           061: chat() runs the tool loop on a provider-format history (Claude: streamed, strict tools, tool_choice
                           auto, content appended unchanged; OpenAI: strict function tools), limits and usage per provider call;
                           (121) an agent's effort (Claude output_config.effort, OpenAI reasoning_effort) and output limit).
                           Providers (121): anthropic, openai, gemini (OpenAI-compatible endpoint, GEMINI_BASE_URL), openai_compatible
                           (Ollama, vLLM, Azure OpenAI; base URL required, key optional): service.ts serviceKey(), baseUrlFor(), providerLabel()
  debug.ts                 debug messages: DebugLog (levels, timed steps, NOTICEs of meta.debug from appTx), started in
                           loadContext, stored after the response (onResponse hook → meta.debug_save), hourly purge
  icons.ts                 icon helper (sprite in public/icons.svg)
  runtime/
    routes.ts              HTTP handlers: show, submit, dynamic actions, cascading lists, login
    signin.ts              the sign-in form (built-in page and the login region of an application's own login page), safeNext, passwordResetAvailable
    password-reset.ts      Forgot password: request (same answer either way), the link (token into the session), the new password
    two-step.ts            (sprint 130) the second step of signing in (/login/2fa: a code, or the first app and its recovery
                           codes), passwordSignIn, and My account → Two-factor sign-in
    context.ts             PageContext, dbg()/timed() debug helpers, bind values, substitutions, public error messages, writeOut (streamed responses with back pressure)
    authz.ts               authorization schemes, conditions, visibility (menu requests count as buttons)
    engine.ts              form fetch, validations, processes (conditions, execution chains, queueing background chains; web requests queued by an sql process are made right after it), application processes
    processes.ts           download (file or zip from a query, safe headers), workflow processes, configuration checks of chains
    logic.ts               computations (the page's and (102) the application's), branches (page, URL, function returning a URL, another application) and their conditions
    shortcuts.ts           (103) "NAME" shortcuts in static content, help texts and confirm messages
    render.ts              page chrome (nav, breadcrumb), dynamic action JSON, theme (the page's nonce'd <style>, light/dark and style switches)
    styles.ts              base styles (BASE_STYLES: Iris, Lavender, Standard; baseStyleOf → html data-style), Theme Roller style variants: fixed lists (fonts, sizes, corners), parseStyle/appStyles checks, the request's
                           style (user choice, default), themeCss() (only hex values and constants reach the CSS); (sprint 117) NAV_APPEARANCES
                           (Pillar Light / Dark), navAppearance() → the <body> classes nav-pillar-*, the header strip (--strip)
    template-options.ts    template options: the fixed CSS class list per region and button, templateClasses() (unknown values ignored)
    regions.ts             region shell + chart (drill-down links, gauge settings)/cards/dynamic dispatch with row limits, lazy placeholder and cache, buttons (menu buttons, badges; (124) menu entries {action} → data-menu-entry for menu_entry dynamic actions)
    report.ts, report-views.ts (group by, pivot, chart), compute.ts (computed column expressions), grid.ts (aggregates, row actions, Actions menu, single row view, layoutFromForm), grid-layout.ts (column layouts: clean, arrange, per user), master-detail.ts (signed master row selection, details), facets.ts (facetChart: a facet's counts as a chart, sprint 65), items.ts
                           (report.ts: paging with row ranges and max_rows, keyset paging (keysetPlan, seekCondition, signed r<id>_k), pagerNav, streamed CSV/Excel downloads with a cursor;
                           items.ts: lovOptions, searchLov/lovLookup for popup LOVs, served by POST /a/:alias/:page/lov/:item/search in routes.ts)
    region-cache.ts        region caching (keys per scope, CSRF placeholder, invalidation on submit) and lazy regions (GET …/region/:id is in routes.ts)
    gantt-move.ts          (sprint 69) Gantt drag and drop: ganttEditable, targetTime, moveGanttTask (the task in the region's
                           query, gantt_move with :TASK_ID/:NEW_START/:NEW_END); the dragging itself is in app.js
    charts.ts              server-rendered charts (SVG and CSS classes): bar … radar, gauges, Gantt (time axis, dependencies), pyramid, polar, range, box plot (quantile, boxes), stock, (sprint 70) treemap and sunburst (buildTree, squarify), timeline, drill-down marks, data table
    calendar.ts            calendar region: month/week/day/list views, create links, drag and drop (moveEvent, moveCalendarEvent;
                           the route POST …/calendar/:id/move is in routes.ts)
    links.ts               page links with checksums; fillItems() fills #column# in link items
    facet-state.ts         facet definitions (checkbox, range, star; exclude, custom range), filters read from the URL, their SQL as query parameters
    smart-filters.ts       smart_filters region: search field, filter chips, suggestions
    display-selector.ts    display_selector region: tabs / select list over the page's regions (app.js makes them ARIA tabs)
    account.ts             My account (details, own password, preferences), the light/dark and style switches (POST …/account/theme, …/account/style)
    locale.ts              language, theme, text messages, translations, number symbols and time zone of a request
    format.ts              date masks; maskedFormatter() applies a column's or item's number or date mask
    files.ts               file items: multipart parsing, temporary files, signed downloads
    document.ts            document templates: tag language, HTML subset, PDF layout (pdfkit)
    documents.ts           ?doc=NAME: a template filled with the page's values
    maps.ts                map region (data for Leaflet: layers with a query each, markers, clusters or heat, PostGIS geometry as GeoJSON, report filter by area or distance; list fallback, head assets)
    spatial.ts             spatial filtering on the server: map area and distance parsing, PostGIS detection and SQL (ST_Intersects, ST_DWithin), lat/lng fallback (bounding box, haversine)
    pwa.ts                 Progressive Web App: manifest, service worker route, icons (PNG encoder), offline page
    rest.ts                REST modules: handler and template checks, matching, bearer tokens, module privilege, the constrained-role
                           check, execution (collections stream from a cursor), OpenAPI (templates, documented parameters, roles)
    rest-handlers.ts       (sprint 104, migration 117) PL/pgSQL handlers (binds as settings, DO block, meta.rest_reply) and media
                           handlers (content type and file name cleaned, sandboxed response)
    autorest.ts            (sprint 100, migration 113) AutoREST: /a/:alias/autorest/<object>/ for the tables and views SQL Workshop →
                           RESTful Services published (meta.rest_object): caller() of rest.ts, SET ROLE to the app role, owner/BYPASSRLS
                           check, columns from the catalog (column grants), filters/q/order/paging, POST/PUT/DELETE by primary key, OpenAPI
    rest-sources.ts        REST data sources in apps: regions and LOVs as SQL over "rest", the invoke_api process (items; the call is websources.ts invoke()),
                           write-back of forms (fetch, form_dml) and grids (grid_dml) through the source's operations
    tree.ts                tree region
    lists.ts               lists: static entries or a query, visibility (authorization, conditions, page access), safe URLs; list regions, navigation menu and bar
    template-components.ts template components: template language (allow-list, directives, escaping), plug-in files, report column templates
    builtin-components.ts  built-in template components (ut_avatar, ut_badge, ut_comments, ut_media_list, ut_metric_card, ut_timeline)
    template-region.ts     template_component region
    tasks.ts               task list region and task actions (approvals); (094) the vacation rule panel and route;
                           (sprint 114) custom outcome buttons, the Fail event and recovery of a failing completion SQL
    data-reporter.ts       Data Reporter region (migration 057): sources from the region's config, checkDef (offered columns, whitelists),
                           reportQuery/chartQuery, the list and editor (GET form), save/delete routes (meta.save_data_report);
                           (sprint 110) dataset sources (resolveSources), edit_authz / admin_authz / publishing, pins (a preference),
                           publish / pin routes, the stable URL GET /a/:alias/reports/:id
    form-designer.ts       Form Designer region (migration 106): sources from the region's config, checkFormDef (offered columns, displays,
                           actions), forms as cards, a form's rows, a row's form (lost update hash), the designer; row/design/delete routes
    workflows.ts           workflow console region and its actions
    ai.ts                  Generate text with AI: the ai_generate process (config checks, &ITEM. as delimited escaped data,
                           schemas from items, answers into items), aiInputs/aiOutputs for its dynamic action (route in routes.ts)
    assistant.ts           AI assistant region (migration 061): config checks, tool schemas and argument checks, context queries
                           and SQL tools as the app role (rolled back unless "writes"), REST tools, meta.ai_conversation per
                           session, formatAnswer (escaped), send/clear routes; (121) "agent": an AI agent's service, prompt, tools,
                           steps and authorization; links of navigate tools under the answer, browser actions once (__AIACT<id>)
    ai-agents.ts           (121) AI agents and AI tools (meta.app.ai_agents / ai_tools): checks (agentProblems, aiToolProblems,
                           definitionProblems), agentFor(), prepareTools() (authorization schemes, navigate pages the user may
                           open, strict schemas), runAgentTool() (sql: read-only transaction as the app role with a time limit;
                           function: named arguments, committed; rest; javascript: queued for the browser; navigate: URL and
                           checksum built here), logToolCall() (meta.ai_tool_call, debug level 4, 30-day purge)
    ai-filter.ts           "Ask in your own words" on a report ("ai_filter", sprint 112: AI interactive reports): the box, the chips
                           form (Edit/Remove/Undo, undo history in the session), ask and chips routes; an AI service's structured
                           output (planSchema) or the phrase parser, then ir-plan.ts
    ir-plan.ts             what a question may set: checkPlan (shown columns, whitelists, computeSql), applyPlan (→ the report's
                           URL parameters), chipsOf/editChip/removeChip (a chip = one URL parameter value, edits checked again)
    ir-phrases.ts          the rule-based parser without an AI service: phrase tables per language (en, nl, de), clauses →
                           a RawPlan; values looked up among the report's rows through a Lookup (query parameter)
    pdf.ts                 report PDFs with report layouts (pdfkit); rows from a cursor in batches (tablePdf takes batches)
    search.ts              search region and search configurations (migration 080): words as ILIKE parameters, table/sql/list
                           sources as the app role in savepoints, marked results, configColumns/searchConfigProblems for the Advisor
    url-region.ts          URL region (migration 078): literal origins only (urlTarget), &ITEM. URL-encoded, sandbox and height,
                           frameOrigins() for the CSP's frame-src (security.ts)
    ajax.ts                Ajax callbacks (migration 085: POST …/ajax/:name, point "ajax" processes, x01 … x10 binds) and the
                           download dynamic action (POST …/da/:id/download)
    availability.ts        availabilityRefusal(): who may use an application (migration 083); loadContext, the login page
                           and REST modules ask it (PostgREST: meta.api_check)
    feedback.ts            users' feedback page and the navigation bar entry (migration 084)
    data-items.ts          display image and address items (migration 086): imageUrl (https origins into the CSP's img-src),
                           GET …/image/:item (a BLOB from the item's query), POST …/geocode/:item, and items kept per user
                           (loadPreferences / savePreferences through meta.get_preference / set_preference)
    data-export.ts         the download process's {"export": …}: meta.data_export for csv/json/xml/html, Excel and PDF here
    devbar.ts              developer toolbar and session state viewer (migration 079): the pgkiln_devbar token of a builder
                           session (ensureDevbar/devbarOf), the toolbar markup, the viewer, clear and per-session debug routes
  builder/
    components.ts          property spec of every component (drives the property editor)
    ui.ts                  IDE shell (icon rail, toolbar, breadcrumb, status bar), builder theme, form helpers, CSRF check, app tabs
    i18n.ts                (sprint 121) the builder's own texts: BUILDER_LANGUAGES, tr(s) / translatorFor(lang) → tx(key, params),
                           tx.rich (markup in a sentence), tx.dyn (keys made at run time), tx.label (known breadcrumb labels)
    i18n/                  en.ts defines the builder's keys; de, es, fr, nl, pt are Records of the same keys
    language.ts            (migration 127) the status bar's language menu (POST /builder/language), the sign-in page's
                           language links (?lang=, a cookie), meta.developer.language
    routes.ts              sign-in, app home, settings, activity, developers, create (POST, via newapp.ts)/import (POST)
    wizards.ts             create page wizards: step 2 forms per page type (defaults from meta.wizard_defaults), POST → meta.generate_page
                           (the generators are PL/pgSQL in migration 047: catalog, defaults, form/cards/calendar/chart/map/facets/master-detail)
    home.ts                App Builder home at /builder/apps and /builder (tiles, applications report/cards, Recent; /builder redirects
                           to the Workspace home when meta.workspace.builder_home = 'home'), Create, Import, Dashboard, Utilities;
                           (116) Updated by, working copies and the application lock in the report and the cards
    app-updates.ts         (sprint 116, migration 125) who changed an application last: developer() notes a builder POST under
                           /apps/:id or /pages/:pid (or a Create / Import), an onSend hook records a success in meta.app_change
    workspace-home.ts      (sprint 109, migration 119) the Workspace home /builder/home, opened after sign-in: tool cards (Data Reporter
                           when GET /builder/reporter exists), workspace message edited in place (workspaceAdmin), Summary, Top
                           applications / users / developers over meta.developer.home_timeframe, System message (src/release-check.ts),
                           POST timeframe, message, release-check; releaseCheckRegion for Instance settings
    newapp.ts              creating an application (schema, role app_<alias>, Home page, first user): blank app, from a file, from tables
    appfromfile.ts         Create → From a file: upload (src/dataload.ts parsing), proposed table/columns, one transaction:
                           app + table + rows (loadRows) + pages (meta.generate_page: report and form, chart, facets)
    appsheets.ts           Create → From a file with several sheets/JSON arrays: parseBook, proposed keys and foreign keys,
                           step 2 sections, one transaction (tables, rows, foreign keys, report+form per table); addDashboard
                           (a chart per table on one page, also used for existing tables)
    appwizard.ts           Create → From pasted data (kept as a temp file, then the From a file steps) and From existing tables
                           (a schema's tables/views → report+form or report pages, navigation, dashboard)
    forms.ts               generic component property form (lookups, render, save)
    backups.ts             Application → Backups (migration 082): list, back up now, download, restore (replaceApp), keep N;
                           backupTick() for the scheduler's daily backups of changed applications
    workspace-backups.ts   Workspace utilities → Manage backups (sprint 62): the backups of every application of the current
                           workspace, back them all up (only the changed ones by default)
    rest-catalogs.ts       Workspace utilities → REST Source Catalogs (095): list, import (file, pasted, URL), a catalog and its
                           services, download; catalogPicker and "from a catalog" for an application's REST data sources
    workspace-transfer.ts  Workspace utilities → Export and import (sprint 67, workspace administrators)
    find-workspace.ts      (096) Find my workspace: builderMail (Mail services → Builder mail), workspacesMail, the page (same answer
                           for every address, mail after the answer, limits per address and IP)
    availability.ts        Application → Availability (migration 083): status, message, users, build status (Run only is
                           enforced by locks.ts blockingLock); availabilityBadge() in the application header
    feedback.ts            Application → Feedback (migration 084): the setting, the list with filters, status and answers
    team.ts                (sprint 113, migration 122) Builder → Team Development /builder/team: issues (list with filters and saved views,
                           board by label group or milestone with a Move form per card, issue page with Markdown, comments, canned
                           responses, @mentions, history), labels and groups, milestones, templates, the set-up wizard; Make an issue
                           from feedback and developer comments; pageIssuesNote (Page Designer), appIssues (App Home), teamHomeBlock
                           (Workspace home). Every id from a request is looked up in the current workspace
    region-help.ts         the Attributes (JSON) help per region type, with links to the guide
    mail.ts                Workspace utilities → Mail services (administrators: providers, write-only secret, allowed senders,
                           applications with From and daily limit, test) and Applications → Activity → Mail (retry, cancel);
                           serviceForm/formValues/runCheck shared with workspace-mail.ts (sprint 118)
    mail-queue.ts          (sprint 118, WS-9) Administration → Mail queue (/builder/mail-queue): queueScope (administrators: all or
                           ?ws=; workspace administrators: the current workspace), figures, per hour, per workspace / application,
                           slowest provider calls, failures; Retry / Purge one or all failed, scope checked again per mail
    network-access.ts      (sprint 118, WS-9) Administration → Network access (/builder/network): the installation's list, a workspace's
                           list (workspaceAdmin), Check a URL (nothing called), the workspaces (administrators), refused calls
    workspace-mail.ts      (sprint 118, WS-9) a workspace's own mail service (/builder/workspaces/:id/mail, WORKSPACE_<id>): its
                           administrators only, write-only secret, checks through mail.ts runCheck with the workspace's guard
    shared.ts              Shared Components and access control
    designer.ts            page designer: component tree (with computations and branches), layout canvas and gallery, property editor, toolbar;
                           (sprint 86) GET /builder/apps/:app/pages/:no, /builder/pages/:id redirects browsers there (designerUrl in ui.ts)
    errors.ts              (sprint 86) the builder's HTML 404 and 500 pages for browsers (wantsHtml, a not-found handler and an onSend hook)
    arrange.ts             page designer layout changes: move, column span, create from the gallery, undo / redo
    sql.ts                 SQL Workshop: the home and the session's schema
    launchpad.ts           (sprint 96) the SQL Workshop home's Launchpad (pins in meta.builder_pin, 109; tool groups), POST /builder/pins,
                           GET /builder/palette (the builder's search: JSON for Ctrl+K, a results page without JavaScript)
    sql-charts.ts          (sprint 97) charts of a query: chartSpec(), drawChart() (runtime/charts.ts, a PageCss in a nonce'd <style>), the
                           worksheet's Chart tab, SQL Workshop → Charts (meta.sql_chart, 110; read-only runs)
    sql-tools.ts           (sprint 96) SQL_TOOLS: every SQL Workshop tool with its group, tab and description (home, More menu, search)
    worksheet.ts           (sprint 91) the SQL Worksheet (Database Actions' SQL; /sql/commands too): navigator (pickSchema, objects with
                           columns, objectStatements), toolbar, output tabs, history (meta.sql_history, 108), plan trees, Run as an app's role, (sprint 93) Save / Rename / Download as SQL Scripts, bind and substitution values, POST /sql/worksheet/format; GET /sql/worksheet/navigator;
                           (sprint 107) transaction mode: the txn field, Commit / Rollback (mode=commit|rollback), txnBadge(), GET/POST /sql/worksheet/txn (JSON)
    object-browser.ts      (sprint 75) the Object Browser: objects by type, system objects hidden, a table in tabs, column actions as SQL to review
    table-editor.ts        (sprint 95) Table Properties: GET/POST /sql/objects/table (create, edit ?o=, ?template=), fromForm(), Preview / Apply
                           (one transaction) / Open in the worksheet
    data-security.ts       (sprint 119) a table's Security: GET/POST /sql/objects/security?o= (policies, roles × columns, masks), Preview / Apply
    object-actions.ts      (sprint 94) an object's ⋯ menu (objectMenu) in the worksheet and the Object Browser: Quick DDL (objectDdl), Drop with
                           dependents, Add index / trigger / policy as drafts; GET /sql/objects/action, /sql/objects/panel (Open in a panel)
    data-modeler.ts        (sprint 98) SQL Workshop → Data Modeler: /sql/modeler (diagrams, meta.sql_diagram, 111), /:id (SVG), /:id/objects, /layout,
                           /rename, /delete, /svg (export), /ddl (diagramDdl), /dictionary (data dictionary, ?download=1)
    scripts.ts             SQL Workshop → SQL Scripts: editor, upload/download, run, results per statement, run history
    quicksql.ts            SQL Workshop → Quick SQL page (preview, save as script, run)
    querybuilder.ts        SQL Workshop → Query Builder: catalog, joins by foreign key or drawn, functions/group by, buildQuery() from the URL; the canvas is in builder.js
    users.ts               user directory and identity providers
    builder-sso.ts         (sprint 129) a provider's or directory's Builder sign-in region, Security's identities, unlink, break-glass
    datapump.ts            (sprint 103, DA-16) SQL Workshop → Schema Export / Import (/builder/sql/data-pump, administrators only):
                           jobs, export form, upload (streamed to PGKILN_DUMP_DIR), archive preview and import options, job log, download
    db-users.ts            (sprint 99, DA-13) Administration → Database Users (/builder/db-users, administrators only): PostgreSQL
                           roles with highlights, create/edit (review the masked SQL, then Apply in one transaction), drop with
                           reassigning; pgkiln's own roles read-only, roles of applications and workspaces not dropped
    scheduling.ts          (sprint 101, DA-12) SQL Workshop → Scheduling (/builder/sql/scheduling, administrators only): pg_cron jobs
                           with next runs, create/edit with a schedule builder and preview (review the SQL, then Apply), disable,
                           run now, unschedule, run history and purge; without pg_cron the install note and pgkiln's automations
    api.ts                 per-app REST API page (API role, tokens)
    globalization.ts       translations, XLIFF/CSV, text messages
    dataload.ts            SQL Workshop → Load Data (with definitions, save a mapping as one); data load definition spec (Shared Components)
    sampledata.ts          SQL Workshop → Sample Data: schema → tables → generator form; preview (rolled back), insert, SQL/CSV download, saved generators (meta.data_generator)
    unload.ts              SQL Workshop → Unload Data: table/view (columns, where, order) or query form, streamed download (read-only transaction, own connection)
    layouts.ts             report layouts: logo upload, PDF preview
    automations.ts         automations: actions (add, reorder), next run, Run now, run history with errors per row
    report-settings.ts     page designer: report settings form (columns, link, selection, PDF)
    region-settings.ts     page designer: settings forms for grid, chart (gauge, drill-down), cards, calendar (views, create, drag and drop), facets, smart filters, display selector, list
    search.ts              app search, "where used" (appEntries, search, whereUsed, usedInPanel)
    advisor.ts             Advisor: EXPLAIN every SQL fragment, reference checks, plpgsql_check
    ddl-tools.ts           SQL Workshop → DDL and Compare (src/ddl.ts); (sprint 106) the Apply and record form
    changelog.ts           (sprint 106) SQL Workshop → Change Log (/builder/sql/changes): change sets per schema, latest app export,
                           downloads (POST, mark exported_at), rename, delete; /sql/compare/apply (one transaction, recorded)
    sql-utilities.ts       SQL Workshop → Utilities (sprint 62): the tools' tiles, OBJECT_REPORTS (fixed catalogue SQL over the
                           connection's usable schemas), About Database; read only, with a timeout; /sql/utilities/monitor redirects to the SQL Monitor
    login-page.ts          Application settings → Login page and Forgot password; Create a login page (page 9999)
    top-sql.ts             Top SQL per app role from pg_stat_statements; (sprint 102) statementsState / statementsNote (installed and loaded?)
    sql-monitor.ts         (sprint 102, DA-14) SQL Workshop → SQL Monitor (administrators): /sql/monitor (sessions, wait events, progress;
                           ?fragment=1 the live part), POST /sql/monitor/session (cancel / terminate), /sql/monitor/top (topStatements:
                           pg_stat_statements sortable, bars), /reset, /statements/:queryid (totals by role, explainForMonitor: EXPLAIN only,
                           one statement by the extended protocol, read only, generic plan for $1), /statements/:queryid/worksheet
    plan-view.ts           (sprint 92; shared since 102) planView(): a plan (src/sqlplan.ts) as a tree, for the worksheet and the SQL Monitor
    diagnostics.ts         Activity → Debug messages (level, list, one request's entries, purge); Workspace utilities →
                           Installation (version, install/upgrade runs, applied and missing migrations; administrators)
    ldap.ts                Users → LDAP directories
    documents.ts           document template preview (Shared Components)
    pwa.ts                 Settings → Progressive Web App (icon upload)
    themeroller.ts         Settings → Theme Roller: style variants (add, edit, rename, delete), default style, users may choose;
                           (sprint 117) navigation appearance and header strip colours (application and per style), the preview's menu
    subscriptions.ts       Shared Components → Subscriptions: subscribe, refresh, unsubscribe, subscribers and publish; the note under a component
    reporter.ts            page designer: Data Reporter settings (sources: table or view, offered columns, labels, masks; sharing;
                           (sprint 110) a dataset as a source, who may edit, who may moderate, publishing)
    datasets.ts            (sprint 110) App Builder → Data Reporter (/builder/reporter): datasets (new: schema, tables; a dataset's
                           joins, columns, row filter, query and preview), files (download, export all, import), Create reporting
                           application
    form-designer.ts       page designer: Form Designer settings (designers' scheme; sources: key, actions, offered columns, labels, lists of values)
    workingcopies.ts       Working copies: list and create, compare with differences, merge or refresh with conflict choices, delete
    rest.ts                REST module endpoints list and curl example (Shared Components)
    autorest.ts            (sprint 100) SQL Workshop → RESTful Services (/builder/sql/rest): publish a table or view through an
                           application of the workspace (checks: schema the workshop may use, app role not the owner), its page
                           (grants per method, RLS, security_invoker, endpoints, cURL/fetch, OpenAPI link), settings, disable
    rest-modules.ts        (sprint 104) SQL Workshop → RESTful Services → Modules (/builder/sql/rest/modules): modules of the
                           workspace's applications, the module › template › handler tree, handler forms, Try it (inject with a
                           short-lived token), Run only / lock checks
    workflows.ts           workflow versions, diagram and instances (Shared Components)
    workflow-migrate.ts    (sprint 114) migrating running workflow instances to a newer version (map, preview, apply with
                           meta.migrate_workflows) and the diagram as an SVG file (PNG in builder.js)
    process-jobs.ts        page designer: the Jobs tab of a background chain process
    template-spec.ts       template component property form (Shared Components)
    websources.ts          web credentials and REST data sources: property specs, secret status, Test, suggested columns,
                           write-back operations, synchronisation settings, Synchronise now and run history
    templates.ts           template components: preview, plug-in export/import, region settings, report column templates
    code-editor.ts         code fields (data-code marks), /builder/code/completions (scoped to the app's role), /builder/code/check
    instance.ts            Workspace utilities → Instance settings (src/instance.ts: session and sign-in settings, configuration overview)
    gallery.ts             the App Gallery (sprint 61, 120): examples/gallery/gallery.json, sample apps (administrators: migrate --example,
                           or one SQL file of examples/ or examples/gallery/samples/ in one transaction), starter and utility apps
                           (blueprints of starters/ and utilities/ → openBlueprint's review), custom apps (the workspace's boilerplates);
                           four tabs with counts, ?q= search
    app-groups.ts          application groups (092): a workspace's groups, a group per application (the App Builder home filters)
    cross-app.ts           Cross Application Reports (sprint 61): REPORTS (one SQL per topic over the workspace's applications)
    workspaces.ts          workspaces (064): loadWorkspaces/appAllowed (checked in ui.ts developer() for every /apps/:id and /pages/:pid
                           request), the current workspace (session state __WS), placeApp, the switcher, Workspace utilities → Workspaces;
                           (090) isolation and the workspace's database roles, workshopDb (the SQL Workshop's connection)
                           (093) workspace preferences (sql_workshop: checked in ui.ts developer() for /builder/sql…;
                           rest_services: checked in runtime/rest.ts) and extension links (the rail's Extensions menu in shell())
    locks.ts               page and application locks (blockingLock, checked in ui.ts developer() for every builder POST; appOfPath), developer comments, administrators
    blueprints.ts          Create → From a blueprint: list, JSON editor, AI draft, review (signed with the session), create in one transaction;
                           (sprint 66) From an application
    ai-builder.ts          App Builder AI (migration 062): the builder's AI service (meta.builder_ai), SQL Workshop → AI (SQL from a
                           question, shown not run; explain), describe tables (meta.ai_table_note, COMMENT ON, AI drafts),
                           create pages with AI (proposals checked by checkProposals, created with meta.generate_page)
    assistant.ts           page designer: AI assistant settings and a report's "Ask in your own words" (off, built-in phrases or an AI service, placeholder)
    ai.ts                  Workspace utilities → AI services (administrators: services, write-only encrypted keys, access and
                           daily limits per app, Test, usage log) and Activity → AI usage per application
    ai-agents.ts           (121) Shared Components → AI Agents: the agent and tool forms (checked before saving, renames follow
                           into agents and regions), toolCallTable() (Activity → AI usage → Tool calls), agentOptions()
    supporting.ts          supporting objects: review page, running the install/upgrade/deinstall scripts as the app's role in one transaction
public/
  app.css                  theme (light/dark, responsive; --font, --font-size, --radius for style variants; template option classes to-*;
                           (sprint 117) navigation tree states, RTL via logical properties, body.nav-pillar-*, u-color-*-subtle, the busy bar)
  app.js                   client runtime: dialogs (dialog_closed actions), popup LOVs (sprint 115: the next page loads on scroll through an
                           IntersectionObserver, ‹/More without one), dynamic actions (focus, classes, messages; sprint 115: wait_popup /
                           remove_wait_popup as a modal <dialog class="wait-popup">, pgkiln.waitPopup(), the menu_entry event), grids (add/duplicate rows, master-detail refresh, move/resize columns, copy/paste of cell ranges), menus, lazy regions, maps (Leaflet layers, marker clusters, heat layer, layer legend, area/distance filter) (no inline JS)
  code-editor.js, .css     builder code editor: enhances <textarea data-code>, highlighting, suggestions (no dependencies);
                           (sprint 108) the current line, and read-only <pre data-code-view="sql|plpgsql|json|html"> highlighted;
                           its colours are the --ce-* tokens in builder.css
  palette.js               (sprint 96) the builder's search dialog (Ctrl+K), recently visited SQL Workshop pages, the Launchpad's tabs
  sql-monitor.js           (sprint 102) the SQL Monitor: reloads the sessions' live part every 5 / 15 / 60 s, Pause (localStorage pgkiln.sqlMonitor)
  data-modeler.js, .css    (sprint 98) the Data Modeler: drag boxes, undo/redo, save, zoom/fit, auto layout, mini-map, SVG/PNG export, print
  worksheet.js, .css       (sprint 91) the SQL Worksheet: run keys with the cursor, output tabs, navigator swap and search, drag and drop, splitters;
                           (92) grid sort, value dialog, history filter; (93) worksheet tabs in localStorage, Files, binds dialog, format, find, case;
                           (107) Autocommit / Transaction per tab, the badge from the server, beforeunload, rollback on closing a tab
  builder.css              builder only: IDE look (dark chrome, icon rail, panes); design tokens at the top (colour,
                           elevation, radius, type, motion; light and dark sets, sprint 105; code editor --ce-*, sprint 108),
                           then the shared controls
  builder.js               builder only: tabs, component tree, property filter, drag and drop on the layout
  builder-icons.svg        builder only: icons of the rail, toolbar and designer (b-*); b-kiln is the brand mark (brandMark() in ui.ts)
test/
  binds.test.ts            unit tests
  security.test.ts         security regression tests (in-process, against the database)
  sso.test.ts              single sign-on against an in-process mock identity provider
  api.test.ts              REST API: SQL as the API role; HTTP tests skip without PostgREST
  accounts.test.ts         own password, expiry, admin reset, preferences
  i18n.test.ts             languages, translations, text messages, date masks, XLIFF/CSV
  numformat.test.ts        number format masks: every element, rounding, parsing, separators
  globalization.test.ts    masks on HR page 29, time zones, the de/fr/es texts
  files.test.ts            file items: storage, limits, downloads, temporary files
  items.test.ts            rich text, Markdown, rating, combobox, date range, password reveal and QR code items
  dataload.test.ts         parsing, Load Data, the data_load process
  sampledata.test.ts       Sample Data: CHECK parsing, proposals, option errors, seeds and streams, preview/insert/rollback, parents first, downloads, saved generators
  unload.test.ts           Unload Data: CSV/JSON/XLSX/XML output, read back with Load Data, read-only and one-statement checks, streaming
  app-from-file.test.ts    Create → From a file: proposed names and types, app + table + rows + pages, row errors, login, validation
  workshop.test.ts         SQL scripts, Quick SQL pages, query builder, data load definitions (Load Data, the process, export)
  cron-schedule.test.ts    (sprint 101) pg_cron schedules: parsing and errors, next runs across time zones and daylight saving, words
  scheduling.test.ts       (sprint 101) SQL Workshop → Scheduling: the SQL, the no-pg_cron page, create/edit/disable/run now/unschedule,
                           history and purge; against pg_cron when the test database has it, else test/pgcron-mock.ts (a stand-in)
  sql-charts.test.ts       (sprint 97) the worksheet's Chart tab, saving a chart, the Charts dashboard, a chart's page, read-only runs
  launchpad.test.ts        (sprint 96) Launchpad groups, pins (builder pages only, at most 24), the search (JSON and page)
  tabledef.test.ts         (sprint 95) table definitions round trip: CREATE, read, ALTER, read again; mistakes
  changelog.test.ts        (sprint 106) DDL recognition and names, recording from Table Properties, the worksheet and Compare,
                           downloads (Flyway, Liquibase, SQL), stable numbers, the latest application export
  table-editor.test.ts     (sprint 95) the Table Properties page: preview, apply, a failing apply rolls back, template, worksheet
  object-actions.test.ts   (sprint 94) object menus: Quick DDL, Drop with dependents, Add index / trigger / policy, the panel, not-found
  data-modeler.test.ts     (sprint 98) Data Modeler: "hr core" with its FK lines, saved positions, SVG, objects, DDL, dictionary, geometry
  worksheet.test.ts        (sprint 91) the SQL Worksheet: statement at the cursor, Run Script log, plans, notices, history, navigator, Run as
  worksheet-txn.test.ts    (sprint 107) transaction mode: the tab's transaction, Commit / Rollback, typed COMMIT, aborted, idle timeout, refusals,
                           Explain in it, Change Log at COMMIT, the JSON endpoint, sign-out
  datasets.test.ts         (sprint 110) datasets: checks and SQL, proposed joins, the builder's pages, files, the workspace export;
                           a reporting application in two clicks, an editor publishes, a viewer opens the stable URL, pins
  quicksql.test.ts         Quick SQL parser and DDL generator
  xml.test.ts              XML reader: rows, attributes, paths, refused DTDs and entities, limits
  printing.test.ts         report PDFs
  fixtures/                test files (employees.xlsx)
  template-components.test.ts  template language, escaping, plug-ins, regions and column templates
  logic.test.ts            computations, branches, menu buttons and badges, new dynamic actions, build options, export
  page-logic.test.ts       download, chain (background jobs) and workflow processes, function/app branches, dialog_closed (HR page 28)
  code-editor.test.ts      code editor: completions scoped to the app's role, the check, marked fields
  builder-i18n.test.ts     (sprint 121) builder languages: the coverage check of src/builder against i18n/en.ts, the message
                           files, Deutsch on the sign-in page, the status bar menu, the choice per developer, English fallback
  builder-home.test.ts     App Builder home: search, sort, views, Recent, Create/Import pages, dashboard, utilities
  app-list.test.ts         (116) the App Builder list's Updated by, working copies and lock; what counts as a change
  import-only.test.ts      (116) pgkiln import --replace --only: a page or component file, refusals
  charts.test.ts           chart markup per kind (geometry as classes), gauges, Gantt time axis and dependencies, pyramid, polar, range, box plot, stock, drill-down links
  calendar.test.ts         calendar views, create links, moving events (pure and over HTTP)
  rest-sources.test.ts     REST data sources, web credentials, SSRF checks, invoke_api (mock service + HR page 23)
  rest-modules.test.ts     (sprint 104) modules, templates, PL/pgSQL and media handlers, OpenAPI, the builder's tree and Try it
  workflow-invoke.test.ts  workflow invoke_api steps: the call between transactions, faults, retry, lease, Advisor, export (mock service)
  workflow-outcomes.test.ts (sprint 114) custom task outcomes, task events and notifications, fail recovery, send_mail and draft
                           steps, migrating running instances, the SVG export (HR part 67: SALARY_CHANGE)
  large-tables.test.ts     row ranges, max_rows, row limits, lazy regions, region caching, streamed downloads (HR page 25)
  grid.test.ts             interactive grid: aggregates, layouts per user, saved grid reports, master-detail, row actions (HR page 27)
  custom-auth.test.ts      custom authentication: function body, named function, post-authentication code, builder settings
  instance.test.ts         instance settings: precedence, the administrators' page, throttling, no secrets
  drawers.test.ts          drawers and dialog sizes (065): Page Designer, what pages tell the browser, export/import
  debug.test.ts            debug messages: levels, meta.debug, timings, password values, rollbacks, retention, the viewer, the install log
  web-request.test.ts      meta.web_request (scheduler pass, page process path, sources, credentials, limits, retention) and
                           meta.parse_data compared with the data loader (src/dataload.ts); HR page 35
  builder-parity.test.ts   lists (HR page 31), page and application locks, comments, developers, supporting objects
  page-wizards.test.ts     create page wizards: catalog defaults, every page type generated and rendered, refusals, the builder steps
  theme-styles.test.ts     Theme Roller style variants (checks, CSS, user choice per app, builder page), template options, base style Iris
  theme-pillar.test.ts     (sprint 117) Pillar Light / Dark appearances and the header strip: checks, CSS, runtime classes, Theme Roller, export
  workspaces.test.ts       workspaces (064): Default, administrators' pages, current workspace, refused apps, imports and copies
  mail-network.test.ts     (sprint 118) network access lists (page process refused and logged in debug, narrowing only, redirects,
                           the page), a workspace's mail service (sending, SMTP host on the list), the Mail queue (yesterday's
                           SMTP failure, Retry, Purge, counts, scope)
  gallery.test.ts          the App Gallery: every starter and utility created from its review and every sample app installed, with all
                           their pages rendering; sample apps (admins), the search, a failing script leaves nothing
  gallery-samples.ts       the gallery's shipped apps for the tests: SAMPLES (schema and role of each script), BLUEPRINTS, drop/install
  builder-apex-screens.test.ts sprint 61: sign-in with a workspace, message and banner, utilization, SQL Workshop home, groups, reports
  workspace-isolation.test.ts isolated workspaces (090): logins, RLS on meta, app_id, roles, SQL Workshop, scripts, imports
  ai.test.ts               AI services: Generate text with AI (text, structured outputs, errors, limits, keys), its dynamic action,
                           meta.ai_generate, the providers, HR page 37; against ai-mock.ts (no real API calls)
  ai-assistant.test.ts     AI assistant region (context, tools as the app role, writes, REST, histories, limits, sessions), OpenAI,
                           natural-language report filters, builder settings; against ai-script-mock.ts
  blueprints.test.ts       blueprints: checks and SQL, review then create (rows, pages, grants), one transaction, AI draft, save
  blueprint-from-app.test.ts  a blueprint of HR: checks clean, pages and menu, notes, a working copy with sample rows, workspaces
  rest-catalogs.test.ts    OpenAPI/Swagger reading, parameter keys, catalog files, the builder's pages, a data source from a service
  workspace-transfer.test.ts  a workspace's export, import into another workspace (added, kept, replaced, all or nothing), groups, access
  tree-charts.test.ts      treemap and sunburst (the hierarchy, cycles, squarify), timeline (lanes, rows, points and periods)
  gantt-move.test.ts       an editable Gantt's markup, the move route, dates, who may drag, the builder's settings
  find-workspace.test.ts   developers' addresses, builder mail, the workspaces mail, the same answer, limits
  ai-builder.test.ts       App Builder AI: the builder's service, SQL from a question, explain, describe tables, pages with AI
  ai-script-mock.ts        a scripted mock of Claude (SSE, tool_use with a thinking block) and OpenAI (tool calls), reply by reply
  ai-mock.ts               a local mock of the Claude Messages API (SSE stream) and OpenAI Chat Completions
  helpers.ts               a cookie-keeping test browser
  e2e/responsive.test.ts   browser tests at phone/tablet/desktop widths (Playwright)
  e2e/builder-i18n.test.ts (sprint 121) Deutsch on the sign-in page, the status bar's language menu, German screens at 390 px, CSP
  e2e/gallery.test.ts      (sprint 120) the gallery's sample apps: every page at 4 widths, CSP, axe; dynamic actions; the four tabs at 390 px
  e2e/admin-mail-network.test.ts (sprint 118) Mail queue, Network access and a workspace's mail service at 390 px without JavaScript
  e2e/pillar.test.ts       (sprint 117) Pillar appearances: axe in light and dark, subtle colours, current vs parent entry, Arabic RTL, 390 px, preview
  e2e/code-editor.test.ts  the code editor in a browser: highlighting, keys, suggestions, touch, screen readers, syntax colours at AA in both themes (sprint 108)
  e2e/data-modeler.test.ts (sprint 98) the Data Modeler in a browser: drag, save, reload, undo/redo, zoom, mini-map, exports, phone
  e2e/worksheet.test.ts    (sprint 91) the SQL Worksheet in a browser: run keys, tabs, navigator, drag and drop, splitters, phone, no JavaScript;
                           (107) transaction mode: badge, reload, Rollback, closing a tab, Autocommit switch, beforeunload
  e2e/items.test.ts        sprint 26 item types in a browser: editors, tags, stars, dates, reveal; without JavaScript
  e2e/designer.test.ts     page designer: panes per width, drag and drop, keyboard, Arrange buttons, builder theme
  e2e/calendar.test.ts     calendar drag and drop and create on click, view switching, chart drill-down
  e2e/gantt.test.ts        Gantt drag and drop: moving a task, its end, the keyboard, a click still drills down, the phone
  e2e/globalization.test.ts the browser's time zone (sign-in, app.js), no-JavaScript fallback, a masked number item
  e2e/grid.test.ts         interactive grid in a browser: master-detail refresh, move/resize columns, row menu, copy/paste; without JavaScript
  e2e/page-logic.test.ts   dialog_closed refreshes a region without a reload, download process in a browser, dialog link without JavaScript
  e2e/ai-builder.test.ts   App Builder AI in a browser (mock Claude): SQL from a question, a drafted description, proposed pages,
                           a blueprint drafted and reviewed
  e2e/ai-assistant.test.ts the AI assistant and report questions on HR page 38 in a browser (mock Claude), with and without JavaScript
  e2e/ai.test.ts           Generate text with AI on HR page 37 in a browser (mock Claude): dynamic actions without a submit, errors, no JavaScript
```

## Builder texts in more languages

(sprint 121) The builder's own texts are keyed messages, like the runtime's: `src/builder/i18n/en.ts` defines every
key (`<screen>.<what>`, e.g. `rail.app_builder`, `pd.menu.create`, `ab.count` with `{n}`), and `de.ts`, `es.ts`,
`fr.ts`, `nl.ts` and `pt.ts` are `Record<BuilderKey, string>` of the same keys. A page takes its translator from the
session and uses it for every text it shows:

```ts
const tx = tr(s);                                  // the developer's language (meta.developer.language, in the session)
html`<h2>${tx('wh.summary')}</h2><p>${tx('ab.count', { n: 3 })}</p>`;   // plain text: html`` escapes it
tx.rich('ab.none_yet', { create: html`<a href="…">${tx('ab.create_one')}</a>` });   // markup inside a sentence
tx.dyn(`gallery.region.${type}`, REGION_LABELS[type][0]);              // a key made at run time, with a fallback
```

A missing text falls back to English, never to the raw key. Shared helpers that render chrome take the session as
an optional last argument (`appHeader(a, 'pages', s)`, `workshopTabs('sql', s)`); `shell()` translates known English
breadcrumb labels (`tx.label`) so pages that aren't moved yet still get a translated trail.

**Moving a screen over**: replace its literal texts with `tx('key')`, add each key with its English text to `en.ts`
(keep the English exactly as it was: tests and e2e tests assert it), then add the key to the five other files
(TypeScript refuses a file with a missing or an unknown key). A sentence with a link is one key with a `{link}`
placeholder and `tx.rich`, not pieces glued together; a count has a `_one` and a plural key; never lower-case a
translated label (German nouns). Flash messages are translated where they are set.

**The coverage check** (`test/builder-i18n.test.ts`, part of `npm test` and CI) scans `src/builder/**/*.ts` for
`tx('…')`, `tx.rich('…')` and `tr(s)('…')` and fails when a key has no English text (templated keys such as
`` `ago.${unit}` `` must match at least one English key); checks that every region type, item type, button action,
display position, button position, component kind and SQL Workshop tool has its run-time key; and that every
language file has exactly the English keys, the same `{placeholders}`, no empty texts and is mostly translated.

**Texts in the browser** (sprint 123). The builder's own JavaScript (`public/*.js`) asks for texts with keys
`js.<screen>.<what>`: `shell()` puts every `js.*` key in the developer's language into the page as JSON in an
attribute, `<div id="builder-texts" hidden data-texts="…">` (escaped like any value; builder pages keep having no
inline script). A script reads it once and fills placeholders itself:

```js
const TEXTS = (() => { try { return JSON.parse(document.getElementById('builder-texts')?.dataset.texts || '{}'); } catch { return {}; } })();
const msg = (key, params = {}) => (TEXTS[key] ?? key).replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
announce(msg('js.ws.copied', { what }));
```

The coverage check also scans `public/*.js` for `msg('js.…')` and fails when a key has no English text. Text
from the server (a JSON answer's `message`) is translated on the server.

Stays English by design: the property editor's field names and help (and a shared component form's field names and
help, which work the same way), links to the guide, generated SQL, and pages
not moved yet. The builder's language is separate from an application's languages (`src/i18n.ts`).

## Principles

- **User-facing texts go through the translator**: `ctx.locale.t('key')` for pgkiln's own texts (add the key to `en` and `nl` in `src/i18n.ts` and to `src/i18n/de.ts`, `fr.ts`, `es.ts`; TypeScript checks that every language has every key), `ctx.locale.tr(text)` for texts derived from application metadata.

1. **Metadata first.** A feature is a column or row in `meta.*`, rendered by the runtime, editable
   in the builder, included in export/import and usable from SQL.
2. **User input never becomes SQL text.** Use query parameters (`SqlParams`, binds.ts) or `literal()` for values,
   `pg.escapeIdentifier` only for identifiers checked against a known list, whitelists for
   operators and keywords, and integers for positions.
3. **Visibility is authority.** Anything a user can trigger (buttons, items, dynamic actions, grid
   saves) must be checked against `computeVisibility()` on the server.
4. **Server-rendered HTML, progressive enhancement.** Every page works without JavaScript; `app.js`
   uses event delegation, and the CSP forbids inline scripts. Styles: no `style="…"` attributes
   either (`style-src 'self' 'nonce-…'`). Use a class in `app.css` (the `u-*` utilities for
   one-off spacing); for values that depend on data (chart geometry) call `ctx.css.cls('width:34%')`
   (`src/css.ts`), which returns a class whose rule goes into the page's nonce'd `<style>`. A
   refreshed region sends its rules along and `app.js` adds them through the CSSOM. The e2e test
   fails on any CSP violation in the browser.
5. **Escape by default.** Build HTML only with `html```; use `raw()` only for markup you generated.
6. **Responsive and accessible.** Labels, keyboard support, focus rings, and layouts that pass
   the e2e overflow checks.

## Running and testing

```bash
npm run dev          # auto-restart
npm run typecheck
npm test             # binds + security tests (needs the database with the sample)
npm run test:e2e     # needs `npx playwright install chromium`; SCREENSHOTS=1 saves PNGs to test-results/
npm run db:reset     # fresh database
```

CI (`.github/workflows/ci.yml`) runs these jobs against PostgreSQL 17:

- **test**: typecheck and `npm test` on a fresh database;
- **e2e**: the browser tests, uploading the screenshots as an artifact; `test/e2e/accessibility.test.ts` runs
  axe-core (WCAG 2.1 A and AA rules) on every page of the HR example (light, dark, Iris) and the builder's main pages
  (in both builder themes, with the SQL Workshop and the wizards, since sprint 108) and allows no violation;
- **docker**: builds the image and starts the compose stack as a user would.

- **upgrade**: installs each earlier release (`v0.31.0` …) with its HR example (`git archive <tag> | tar -x`,
  then `scripts/migrate.ts --seed --root`), upgrades to the commit and runs `npm test` on the result.
  Add each new release to its matrix.

CI has **no `.env`** and no PostgREST: only the variables in the workflow are set, and the
PostgREST HTTP tests skip. To reproduce a CI failure, run the tests in a clean checkout
(`git worktree add`) against a throwaway database with only those variables, and
`API_URL=http://127.0.0.1:1`. A new required environment variable must be added to the workflow.

To try an upgrade locally (once there is an earlier release):

```bash
mkdir -p /tmp/old && git archive v0.31.0 | tar -x -C /tmp/old
DATABASE_URL=<empty database> npx tsx scripts/migrate.ts --seed --root /tmp/old
DATABASE_URL=<same database> npm run example:hr && npm test
```

## Adding a region type (example)

1. **Migration**: allow the type in `meta.region`'s check constraint (new file `db/migrations/NNN_…sql`).
2. **Types**: add it to `Region['type']` in `src/metadata.ts`.
3. **Renderer**: write `renderX(ctx, region)` in `src/runtime/x.ts` returning `html```, and add a
   `case` in `renderRegion()` (`src/runtime/regions.ts`). Run developer SQL through `savepoint()`
   and turn errors into messages with `publicError()`.
4. **Builder**: add the type to the `type` options and describe its attributes in the `config`
   help (`src/builder/components.ts`).
5. **CSS**: in `public/app.css`, including the phone breakpoint (`max-width: 640px`).
6. **Tests**: input-handling tests in `test/security.test.ts`, and a page in the sample so the e2e
   test covers it at every width.
7. **Docs**: [chapter 4](04-pages-and-regions.md) and the [parity matrix](../apex-feature-parity.md).

Adding an item type follows the same path through `meta.item`'s constraint, `ItemType`,
`renderItem()` in `items.ts`, and `applyPostedItems()` in `routes.ts` if it posts values
differently; server-side format checks go in `validate()` (`engine.ts`), the builder's lists in
`components.ts` (type options, attribute help) and `ITEM_LABELS` in `arrange.ts` (gallery), and
browser enhancements at the end of `public/app.js` (the item must work without them).

## Migrations

- Never change a migration that has been released (tagged). Add a new numbered file.
- Each file runs in one transaction. Prefer idempotent statements for roles and extensions
  (`do $$ … if not exists … $$`).
- `meta.export_app()` / `meta.import_app()` (migration 013) use `to_jsonb` / `jsonb_populate_record`,
  so new columns travel automatically. A new *table* that references `meta.app` or `meta.page`
  must be added to both functions as a new top-level section (read it with
  `coalesce(p_doc->'section', '[]')`), or to `NOT_EXPORTED` in `test/export.test.ts` with a reason;
  that test fails until you do. Redefine the functions with `create or replace` in the new
  migration; don't wrap them.
- Never rename or remove a section of the `pgkiln/2` format (see [chapter 3](03-builder.md#export-format)).
- A new table that belongs to an application or references a component must also be listed in
  `src/cli/replace.ts` (replaced with the application's definition, or kept as installation data);
  `test/cli.test.ts` fails until it is. The directory format ([chapter 18](18-cli.md)) needs no
  change: unknown sections and columns travel along.

## Releasing

1. Update `CHANGELOG.md` and the version in `package.json`.
2. Merge to `main`; CI must be green (every job). The `main` branch should be protected on
   GitHub (Settings → Branches → rule for `main`: require the CI checks).
3. Tag: `git tag -a vX.Y.Z -m vX.Y.Z && git push origin vX.Y.Z`. The tag publishes the Docker image
   (`docker-publish.yml`: `pgkiln/pgkiln` and `ghcr.io/pgkiln/pgkiln`, amd64 and arm64) and the npm package
   (`npm-publish.yml`, trusted publishing with provenance; it refuses a tag that doesn't match
   `package.json`). Then `gh release create vX.Y.Z` with the changelog section as notes.
4. Add the new tag to the `upgrade` job's matrix in `.github/workflows/ci.yml` (see above).
