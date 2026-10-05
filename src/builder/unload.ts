import type { FastifyInstance, FastifyReply } from 'fastify';
import pg from 'pg';
import { PassThrough } from 'node:stream';
import { owner } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import { writeOut } from '../runtime/context.ts';
import { DOWNLOAD_MAX_ROWS } from '../runtime/report.ts';
import { clientIp, logActivity, type Session } from '../session.ts';
import {
  CSV_DELIMITERS,
  CSV_ENCLOSURES,
  DEFAULT_UNLOAD,
  openUnload,
  UNLOAD_FORMATS,
  UNLOAD_TYPES,
  UnloadError,
  unloadStatement,
  validTag,
  type UnloadFormat,
  type UnloadOptions,
} from '../unload.ts';
import { BASE, csrf, developer, region, send, shell, workshopTabs, type Body, type Req } from './ui.ts';

// SQL Workshop → Unload Data (APEX: Data Workshop → Unload Data): a table or
// view (chosen columns, an optional WHERE and ORDER BY) or a query, to CSV,
// JSON, Excel or XML, streamed from a cursor (src/unload.ts). Runs on a
// connection of its own as the owner, like SQL Commands, but in a READ ONLY
// transaction with a statement timeout; the connection is closed afterwards
// so nothing the query sets can leak into the pool. The table step is a GET
// form and the download a POST form (CSRF), so it works without JavaScript.

/** The statement timeout of each statement (the DECLARE and every FETCH). */
const timeout = () => process.env.UNLOAD_STATEMENT_TIMEOUT || '5min';

interface Relation {
  qname: string;
  schema: string;
  name: string;
  kind: 'table' | 'view';
}

/** Tables, views and materialized views, as the Object Browser lists them. */
async function relations() {
  return (
    await owner.query<Relation>(
      `select c.oid::regclass::text as qname, n.nspname as schema, c.relname as name,
              case when c.relkind in ('r', 'p') then 'table' else 'view' end as kind
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind in ('r', 'p', 'v', 'm') and n.nspname !~ '^pg_' and n.nspname <> 'information_schema'
        order by n.nspname, c.relname`,
    )
  ).rows;
}

async function columns(qname: string) {
  return (
    await owner.query<{ name: string; type: string }>(
      `select attname as name, format_type(atttypid, atttypmod) as type from pg_attribute
        where attrelid = $1::regclass and attnum > 0 and not attisdropped order by attnum`,
      [qname],
    )
  ).rows;
}

/** The format options of the form; invalid values fall back to the defaults or are reported. */
export function unloadOptions(b: Body, name: string): UnloadOptions | string {
  const format = (UNLOAD_FORMATS as string[]).includes(b.format ?? '') ? (b.format as UnloadFormat) : 'csv';
  const rootTag = (b.root_tag ?? '').trim() || DEFAULT_UNLOAD.rootTag;
  const rowTag = (b.row_tag ?? '').trim() || DEFAULT_UNLOAD.rowTag;
  if (format === 'xml' && (!validTag(rootTag) || !validTag(rowTag)))
    return 'XML element names: a letter or _ first, then letters, digits, _ . or - (at most 64; not starting with "xml").';
  return {
    format,
    delimiter: CSV_DELIMITERS[b.delimiter ?? ''] ?? ',',
    enclosure: CSV_ENCLOSURES[b.enclosure ?? ''] ?? '"',
    header: b.header === '1',
    bom: b.bom === '1',
    rootTag,
    rowTag,
    sheet: name,
  };
}

const list = (v: unknown) => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]).map(String);

export async function unloadRoutes(app: FastifyInstance) {
  const page = (s: Session, reply: FastifyReply, main: Raw, code = 200) => {
    reply.code(code);
    return send(reply, s, shell(s, 'Unload Data', [['SQL Workshop', `${BASE}/sql`], ['Unload Data']], html`<h1 class="u-mb1">SQL Workshop</h1>${workshopTabs('unload')}${main}`, 'sql'));
  };

  const formatFields = (b: Body) => {
    const fmt = (UNLOAD_FORMATS as string[]).includes(b.format ?? '') ? b.format : 'csv';
    const posted = b.format !== undefined; // unticked checkboxes post nothing
    const on = (name: string) => (!posted || b[name] === '1' ? raw(' checked') : '');
    const opt = (map: Record<string, string>, field: string, labels: Record<string, string>) =>
      Object.keys(map).map((k) => html`<option value="${k}"${(b[field] ?? Object.keys(map)[0]) === k ? raw(' selected') : ''}>${labels[k]}</option>`);
    return html`
      <fieldset class="prop-group u-mt125"><legend>Format</legend>
        <div class="unload-formats" role="radiogroup" aria-label="Format">${UNLOAD_FORMATS.map(
          (f) => html`<label class="check"><input type="radio" name="format" value="${f}"${fmt === f ? raw(' checked') : ''}> ${{ csv: 'CSV', json: 'JSON', xlsx: 'Excel (.xlsx)', xml: 'XML' }[f]}</label>`,
        )}</div>
      </fieldset>
      <fieldset class="prop-group"><legend>CSV</legend><div class="form-grid">
        <div class="field"><label class="label" for="f_delimiter">Separator</label>
          <select id="f_delimiter" name="delimiter">${opt(CSV_DELIMITERS, 'delimiter', { comma: 'Comma ,', semicolon: 'Semicolon ;', tab: 'Tab', pipe: 'Pipe |' })}</select></div>
        <div class="field"><label class="label" for="f_enclosure">Enclosed by</label>
          <select id="f_enclosure" name="enclosure">${opt(CSV_ENCLOSURES, 'enclosure', { double: 'Double quote "', single: "Single quote '" })}</select>
          <small class="help">Only values that contain the separator, the enclosure or a line break are enclosed.</small></div>
        <div class="field"><span class="label" aria-hidden="true"></span>
          <label class="check"><input type="checkbox" name="header" value="1"${on('header')}> First row: column names</label>
          <label class="check"><input type="checkbox" name="bom" value="1"${on('bom')}> UTF-8 byte order mark (for Excel)</label></div>
      </div></fieldset>
      <fieldset class="prop-group"><legend>XML</legend><div class="form-grid">
        <div class="field"><label class="label" for="f_root_tag">Root element</label><input id="f_root_tag" name="root_tag" value="${b.root_tag ?? DEFAULT_UNLOAD.rootTag}" maxlength="64"></div>
        <div class="field"><label class="label" for="f_row_tag">Row element</label><input id="f_row_tag" name="row_tag" value="${b.row_tag ?? DEFAULT_UNLOAD.rowTag}" maxlength="64">
          <small class="help">One child element per column; empty (null) values are left out.</small></div>
      </div></fieldset>`;
  };

  const sourceTabs = (active: 'table' | 'query') =>
    html`<nav class="ide-tabs u-mb1" aria-label="Unload from">
      <a class="ide-tab" href="${BASE}/sql/unload"${active === 'table' ? raw(' aria-current="page"') : ''}>${icon('table')}<span>Table or view</span></a>
      <a class="ide-tab" href="${BASE}/sql/unload?source=query"${active === 'query' ? raw(' aria-current="page"') : ''}>${icon('code')}<span>Query</span></a></nav>`;

  const intro = html`<p class="muted">Download the rows of a table, a view or a query as CSV, JSON, Excel or XML (up to ${DOWNLOAD_MAX_ROWS.toLocaleString('en')} rows).
    Runs as the builder's owner connection in a read-only transaction. To load a file into a table, use <a href="${BASE}/sql/load">Load Data</a>.</p>`;

  const form = async (s: Session, b: Body, error?: string) => {
    const alert = error ? html`<div class="alert alert-error" role="alert">${error}</div>` : '';
    if (b.source === 'query')
      return html`${intro}${sourceTabs('query')}${region(
        'Unload a query',
        html`${alert}<form method="post" action="${BASE}/sql/unload">${csrf(s)}<input type="hidden" name="source" value="query">
          <div class="field"><label class="label" for="f_query">Query</label>
            <textarea id="f_query" name="query" class="code sql-editor" rows="10" spellcheck="false" data-code="plpgsql" required>${b.query ?? ''}</textarea>
            <small class="help">One SELECT (or WITH … SELECT) statement.</small></div>
          ${formatFields(b)}
          <div class="buttons"><button class="btn btn-hot">${icon('download')} Download</button></div></form>`,
      )}`;
    const rels = await relations();
    const rel = rels.find((r) => r.qname === b.table);
    let schema = '';
    const chooser = html`<form method="get" action="${BASE}/sql/unload" class="unload-pick">
        <label class="sr-only" for="f_table">Table or view</label>
        <select id="f_table" name="table" required><option value="">- choose a table or view -</option>${rels.map((r) => {
          const group = r.schema !== schema ? html`${schema ? raw('</optgroup>') : ''}<optgroup label="${(schema = r.schema)}">` : '';
          return html`${group}<option value="${r.qname}"${r === rel ? raw(' selected') : ''}>${r.name}${r.kind === 'view' ? ' (view)' : ''}</option>`;
        })}${schema ? raw('</optgroup>') : ''}</select>
        <button class="btn">Choose</button></form>`;
    if (!rel) return html`${intro}${sourceTabs('table')}${region('Unload a table or view', html`${alert}${chooser}`)}`;
    const cols = await columns(rel.qname);
    const chosen = new Set(b.format !== undefined ? list(b.columns) : cols.map((c) => c.name));
    return html`${intro}${sourceTabs('table')}${region(
      `Unload ${rel.qname}`,
      html`${alert}${chooser}
        <form method="post" action="${BASE}/sql/unload" class="u-mt1">${csrf(s)}<input type="hidden" name="source" value="table"><input type="hidden" name="table" value="${rel.qname}">
          <fieldset class="prop-group"><legend>Columns</legend><div class="qb-pick">${cols.map(
            (c) => html`<label class="check"><input type="checkbox" name="columns" value="${c.name}"${chosen.has(c.name) ? raw(' checked') : ''}> ${c.name} <span class="muted small">${c.type}</span></label>`,
          )}</div></fieldset>
          <div class="form-grid">
            <div class="field"><label class="label" for="f_where">Where</label><input id="f_where" name="where" value="${b.where ?? ''}" placeholder="e.g. deptno = 10" class="code" spellcheck="false">
              <small class="help">Optional: a condition, without the word WHERE.</small></div>
            <div class="field"><label class="label" for="f_order">Order by</label><input id="f_order" name="order" value="${b.order ?? ''}" placeholder="e.g. 1, created desc" class="code" spellcheck="false">
              <small class="help">Optional: columns, without the words ORDER BY.</small></div>
          </div>
          ${formatFields(b)}
          <div class="buttons"><button class="btn btn-hot">${icon('download')} Download</button></div></form>`,
    )}`;
  };

  app.get(`${BASE}/sql/unload`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    return page(s, reply, await form(s, { source: req.query.source, table: req.query.table }));
  });

  app.post(`${BASE}/sql/unload`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const b = req.body ?? {};
    const refuse = async (message: string) => page(s, reply, await form(s, b, message), 422);

    // the statement and the file name
    let sql: string;
    let name: string;
    try {
      if (b.source === 'query') {
        sql = unloadStatement(b.query ?? '');
        name = 'query';
      } else {
        const rel = (await relations()).find((r) => r.qname === b.table);
        if (!rel) return refuse('Choose a table or view.');
        const known = new Set((await columns(rel.qname)).map((c) => c.name));
        const cols = list(b.columns).filter((c) => known.has(c));
        if (!cols.length) return refuse('Choose at least one column.');
        const where = (b.where ?? '').trim();
        const order = (b.order ?? '').trim();
        // the WHERE and ORDER BY text is the developer's SQL: the whole statement must still be one SELECT
        sql = unloadStatement(
          `select ${cols.map((c) => pg.escapeIdentifier(c)).join(', ')} from ${rel.qname}${where ? ` where (${where}\n)` : ''}${order ? ` order by ${order}\n` : ''}`,
        );
        name = rel.name;
      }
    } catch (e) {
      if (e instanceof UnloadError) return refuse(e.message);
      throw e;
    }
    const fileName = name.replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '') || 'data';
    const opts = unloadOptions(b, fileName);
    if (typeof opts === 'string') return refuse(opts);

    const started = performance.now();
    const c = await owner.pool.connect();
    let opened;
    try {
      await c.query('begin transaction read only');
      await c.query(`select set_config('statement_timeout', $1, true)`, [timeout()]);
      opened = await openUnload(c, sql, opts);
    } catch (e) {
      await c.query('rollback').catch(() => {});
      c.release(true);
      return refuse(`The query failed: ${(e as Error).message}`);
    }
    await logActivity({ username: s.username, event: 'sql_unload', ip: clientIp(req), detail: `${opts.format}: ${sql.length > 1900 ? `${sql.slice(0, 1900)}…` : sql}` });
    const out = new PassThrough();
    reply
      .header('content-disposition', `attachment; filename="${fileName}.${opts.format}"`)
      .header('cache-control', 'private, no-store')
      .type(UNLOAD_TYPES[opts.format])
      .send(out);
    try {
      await opened.send((chunk) => writeOut(out, chunk));
      out.end();
    } catch (e) {
      // the client went away, or a later batch failed (e.g. the timeout): the file ends short
      req.log.warn({ err: e, elapsedMs: Math.round(performance.now() - started) }, 'unload stopped');
      out.destroy();
    } finally {
      await c.query('rollback').catch(() => {});
      // a connection of its own, closed: the query may have changed settings (set_config, SET ROLE in a function)
      c.release(true);
    }
    return reply;
  });
}
