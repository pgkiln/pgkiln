import type { FastifyInstance, FastifyReply } from 'fastify';
import { joinStatements, recordChanges } from '../changelog.ts';
import { html, raw, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import { childTables, documentViewDdl, ident, NAME, primaryKey, tableGrants } from '../json-sources.ts';
import { clientIp, logActivity } from '../session.ts';
import { readTable } from '../tabledef.ts';
import { clearCompletions } from './code-editor.ts';
import { tr } from './i18n.ts';
import { SYSTEM_SCHEMAS } from './object-browser.ts';
import { back, BASE, csrf, developer, flash, send, shell, workshopTabs, type Body, type Req } from './ui.ts';
import { currentWorkspace, usableSchemas, workshopDb } from './workspaces.ts';

// (sprint 142, AP-8; APEX: JSON Relational Duality Views) SQL Workshop › Table Properties › Document view: a view
// with the table's key and a jsonb document of each row with lists of its child rows (tables whose foreign keys
// reference it, the developer picks them). The view is security_invoker; its INSTEAD OF trigger
// (meta.json_document_write, migration 142) writes a document back: the row's columns it names, the children it lists
// (updated by key, or inserted), and deletes the children it leaves out. REST (AutoREST on the view) and MCP read and
// write whole documents. Preview, Apply (one transaction with the workshop's connection, in the Change Log) and Open
// in the worksheet, as Add full-text search. Names come from the catalog.

async function page(req: Req, reply: FastifyReply) {
  const s = await developer(req, reply);
  if (!s) return;
  const tx = tr(s);
  const db = await workshopDb(s);
  const isPost = req.method === 'POST';
  const b: Body = (isPost ? req.body : req.query) ?? {};
  const ref = String(b.o ?? '');
  const t = ref ? await readTable(db, ref) : null;
  const schemas = (await usableSchemas(db)).filter((n) => !SYSTEM_SCHEMAS.includes(n));
  if (!t || !schemas.includes(t.schema)) return reply.code(404).send('Not found');
  const table = `${ident(t.schema)}.${ident(t.name)}`;
  const key = await primaryKey(db, t.schema, t.name);
  const children = (await childTables(db, t.schema, t.name)).filter((c) => schemas.includes(c.schema));
  // columns a document leaves out: full-text and vector columns (generated or kept by triggers)
  const omitOf = async (schema: string, name: string) => (await db.query<{ n: string }>(
    `select a.attname as n from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace s on s.oid = c.relnamespace join pg_type ty on ty.oid = a.atttypid
      where s.nspname = $1 and c.relname = $2 and a.attnum > 0 and not a.attisdropped and ty.typname in ('tsvector', 'vector', 'halfvec', 'sparsevec')`, [schema, name])).rows.map((r) => r.n);
  const view = isPost ? String(b.view ?? '').trim() : `${t.name}_doc`.toLowerCase().replace(/[^a-z0-9_]+/g, '_').slice(0, 63);
  const document = isPost ? String(b.document ?? '').trim() : 'doc';
  const picked = new Set<number>();
  if (isPost) children.forEach((c, i) => b[`c.${i}.use`] === 'on' && b[`c.${i}.name`] === `${c.schema}.${c.table}` && picked.add(i));
  else children.forEach((_, i) => picked.add(i));

  const errors: string[] = [];
  let ddl: string[] = [];
  if (!key.length) errors.push(tx('docv.no_key', { table }));
  if (isPost && !errors.length) {
    for (const n of [view, document]) if (!NAME.test(n)) errors.push(tx('fts.bad_name', { name: n }));
    if (key.includes(document)) errors.push(tx('docv.doc_is_key', { name: document }));
    if (NAME.test(view) && (await db.one('select 1 as x from pg_class where relnamespace = $1::regnamespace and relname = $2', [ident(t.schema), view]))) errors.push(tx('fts.exists', { name: view }));
    if (!errors.length) {
      const kids = [];
      for (const i of picked) kids.push({ ...children[i], omit: await omitOf(children[i].schema, children[i].table) });
      ddl = documentViewDdl({ schema: t.schema, table: t.name, key, view, document, children: kids, omit: await omitOf(t.schema, t.name), grants: await tableGrants(db, t.schema, t.name) });
    }
    if (ddl.length && b.mode === 'worksheet') {
      s.state.__SQLDRAFT = `${ddl.join(';\n\n')};`;
      flash(s, tx('te.review'));
      return back(reply, s, `${BASE}/sql/worksheet`);
    }
    if (ddl.length && b.mode === 'apply') {
      const c = await db.pool.connect();
      let failed = '';
      try {
        await c.query('begin');
        for (const x of ddl) await c.query(x);
        await c.query('commit');
      } catch (e) {
        failed = (e as Error).message;
        await c.query('rollback').catch(() => {});
      } finally {
        c.release(true);
      }
      await logActivity({ username: s.username, event: 'sql_command', ip: clientIp(req), detail: ddl.join(';\n').slice(0, 2000) });
      clearCompletions();
      if (!failed) {
        await recordChanges({ workspaceId: currentWorkspace(s), author: s.username ?? '?', source: 'table', defaultSchema: t.schema, statements: [joinStatements(ddl)] });
        flash(s, tx('docv.made', { view: `${t.schema}.${view}` }));
        return back(reply, s, `${BASE}/sql/objects/table?${new URLSearchParams({ o: `${ident(t.schema)}.${ident(view)}` })}`);
      }
      errors.push(`${tx('te.nothing_changed')}: ${failed}`);
    }
  }

  const title = `${tx('docv.add')}: ${table}`;
  const form: Raw = key.length ? html`<form method="post" action="${BASE}/sql/objects/document" class="fts-form">${csrf(s)}
      <input type="hidden" name="o" value="${table}">
      <fieldset class="prop-group"><legend>${tx('docv.children')}</legend>
        ${children.length ? html`<div class="table-wrap"><table class="report"><thead><tr><th scope="col">${tx('fts.include')}</th><th scope="col">${tx('dl.table')}</th><th scope="col">${tx('docv.list')}</th><th scope="col">${tx('docv.fk')}</th></tr></thead><tbody>
          ${children.map((c, i) => html`<tr><td class="te-c"><input type="hidden" name="c.${i}.name" value="${c.schema}.${c.table}"><input type="checkbox" id="dv-c${i}" name="c.${i}.use"${picked.has(i) ? raw(' checked') : ''}></td>
            <td><label for="dv-c${i}">${c.schema}.${c.table}</label></td><td><code>${c.name}</code></td><td><code>${c.fk.map(([col, p]) => `${col} → ${p}`).join(', ')}</code></td></tr>`)}
          </tbody></table></div>` : html`<p class="muted">${tx('docv.no_children', { table })}</p>`}
        <small class="help">${tx('docv.children_help')}</small></fieldset>
      <div class="form-grid u-mt1">
        <div class="field"><label class="label" for="dv-view">${tx('docv.view')}</label><input id="dv-view" name="view" value="${view}" required autocomplete="off" spellcheck="false" class="code"></div>
        <div class="field"><label class="label" for="dv-doc">${tx('docv.doc_column')}</label><input id="dv-doc" name="document" value="${document}" required autocomplete="off" spellcheck="false" class="code"></div>
      </div>
      ${ddl.length ? html`<h2>DDL</h2><pre class="source te-ddl" data-code-view="sql" tabindex="0" aria-label="DDL">${ddl.map((x) => `${x};`).join('\n\n')}</pre>` : ''}
      <div class="buttons te-buttons">
        <button class="btn" name="mode" value="preview">${icon('eye')} ${tx('te.preview')}</button>
        <button class="btn btn-hot" name="mode" value="apply">${icon('check')} ${tx('te.apply')}</button>
        <button class="btn" name="mode" value="worksheet">${icon('code')} ${tx('te.open_ws')}</button>
        <a class="btn" href="${BASE}/sql/objects/table?${new URLSearchParams({ o: table })}">${tx('common.cancel')}</a>
      </div></form>` : html``;
  const main = html`<h1 class="u-mb1">${title}</h1>${workshopTabs('objects', s)}
    <p class="muted">${tx('docv.intro', { table })}</p>
    ${errors.length ? html`<div class="alert alert-error" role="alert"><ul>${errors.map((e) => html`<li>${e}</li>`)}</ul></div>` : ''}
    ${form}`;
  return send(reply, s, shell(s, title, [[tx('rail.sql_workshop'), `${BASE}/sql`], [tx('ob.title'), `${BASE}/sql/objects`], [tx('te.title_table', { table }), `${BASE}/sql/objects/table?${new URLSearchParams({ o: table })}`], [tx('docv.add')]], main, 'sql'));
}

export async function documentViewRoutes(app: FastifyInstance) {
  app.get(`${BASE}/sql/objects/document`, page);
  app.post(`${BASE}/sql/objects/document`, page);
}
