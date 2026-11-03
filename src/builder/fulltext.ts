import type { FastifyInstance, FastifyReply } from 'fastify';
import pg from 'pg';
import { html, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import { clientIp, logActivity } from '../session.ts';
import { joinStatements, recordChanges } from '../changelog.ts';
import { readTable } from '../tabledef.ts';
import { tsConfigFor } from '../runtime/search.ts';
import { builderLanguage, tr } from './i18n.ts';
import { SYSTEM_SCHEMAS } from './object-browser.ts';
import { clearCompletions } from './code-editor.ts';
import { back, BASE, csrf, developer, flash, send, shell, workshopTabs, type Body, type Req } from './ui.ts';
import { currentWorkspace, usableSchemas, workshopDb } from './workspaces.ts';

// (sprint 135, AP-2) SQL Workshop › Table Properties › Add full-text search: a stored generated tsvector column over
// the text columns the developer picks (each with a weight A–D) in a text search configuration from pg_ts_config,
// and a GIN index on it. Preview DDL shows the statements; Apply runs them in one transaction with the workshop's
// connection and records them in the Change Log; Open in the worksheet puts them there. The table, its columns and
// the configuration are read from the catalog on every request; only names found there reach the DDL (quoted).

type Db = Awaited<ReturnType<typeof workshopDb>>;
const NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const WEIGHTS = ['A', 'B', 'C', 'D'] as const;
const ident = (n: string) => (/^[a-z_][a-z0-9_$]*$/.test(n) ? n : pg.escapeIdentifier(n));

interface Col { name: string; type: string; texty: boolean; tsv: boolean; gin: boolean }

async function columnsOf(db: Db, oid: number): Promise<Col[]> {
  return (await db.query<Col>(
    `select a.attname as name, format_type(a.atttypid, a.atttypmod) as type,
            t.typcategory = 'S' and a.attgenerated = '' as texty, a.atttypid = 'tsvector'::regtype as tsv,
            exists (select from pg_index i join pg_class ic on ic.oid = i.indexrelid join pg_am am on am.oid = ic.relam
                     where i.indrelid = a.attrelid and am.amname = 'gin' and a.attnum = any (i.indkey::int2[])) as gin
       from pg_attribute a join pg_type t on t.oid = a.atttypid
      where a.attrelid = $1 and a.attnum > 0 and not a.attisdropped order by a.attnum`, [oid])).rows;
}

/** The text search configurations the connection sees by name (english, dutch, simple…). */
async function tsConfigs(db: Db) {
  return (await db.query<{ n: string }>(`select cfgname as n from pg_ts_config where pg_ts_config_is_visible(oid) order by 1`)).rows.map((r) => r.n);
}

/** The statements: the generated column and its GIN index. */
export function fulltextDdl(table: string, column: string, index: string, config: string, cols: { name: string; weight: string }[]) {
  const cfg = `${pg.escapeLiteral(config)}::regconfig`;
  const parts = cols.map((c) => `setweight(to_tsvector(${cfg}, coalesce(${ident(c.name)}::text, '')), '${c.weight}')`);
  return [
    `alter table ${table}\n  add column ${ident(column)} tsvector generated always as (\n    ${parts.join(' ||\n    ')}) stored`,
    `create index ${ident(index)} on ${table} using gin (${ident(column)})`,
  ];
}

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
  const oid = (await db.one<{ oid: number }>('select $1::regclass::oid as oid', [table]))!.oid;
  const cols = await columnsOf(db, oid);
  const texty = cols.filter((c) => c.texty);
  const configs = await tsConfigs(db);
  const defaultConfig = configs.includes(tsConfigFor(builderLanguage(s))) ? tsConfigFor(builderLanguage(s)) : configs.includes('simple') ? 'simple' : configs[0] ?? 'simple';
  // the form's values (defaults: every text column, A for the first, B for the rest)
  const picked = new Map<string, string>();
  const column = isPost ? String(b.column ?? '').trim() : 'search_vector';
  const index = isPost ? String(b.index ?? '').trim() : `${t.name.replace(/[^a-z0-9_]+/gi, '_').toLowerCase().slice(0, 40)}_search_vector_idx`;
  const config = isPost ? String(b.config ?? '') : defaultConfig;
  if (isPost) {
    for (const c of texty) {
      const i = texty.indexOf(c);
      if (b[`c.${i}.use`] === 'on' && b[`c.${i}.name`] === c.name) picked.set(c.name, WEIGHTS.find((w) => w === b[`c.${i}.w`]) ?? 'B');
    }
  } else texty.forEach((c, i) => picked.set(c.name, i === 0 ? 'A' : 'B'));

  const errors: string[] = [];
  let ddl: string[] = [];
  let output: Raw | '' = '';
  if (isPost) {
    if (!picked.size) errors.push(tx('fts.pick'));
    for (const n of [column, index]) if (!NAME.test(n)) errors.push(tx('fts.bad_name', { name: n }));
    if (NAME.test(column) && cols.some((c) => c.name === column)) errors.push(tx('fts.exists', { name: column }));
    if (NAME.test(index) && (await db.one('select 1 as x from pg_class where relnamespace = $1::regnamespace and relname = $2', [ident(t.schema), index]))) errors.push(tx('fts.exists', { name: index }));
    if (!configs.includes(config)) errors.push(tx('fts.bad_config', { name: config }));
    if (!errors.length) ddl = fulltextDdl(table, column, index, config, [...picked].map(([name, weight]) => ({ name, weight })));
    if (ddl.length && b.mode === 'worksheet') {
      s.state.__SQLDRAFT = `${ddl.join(';\n\n')};`;
      flash(s, tx('te.review'));
      return back(reply, s, `${BASE}/sql/worksheet`);
    }
    if (ddl.length && b.mode === 'apply') {
      const c = await db.pool.connect();
      let failed = '';
      let at = '';
      try {
        await c.query('begin');
        for (const x of ddl) {
          at = x;
          await c.query(x);
        }
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
        flash(s, tx('fts.added', { table, column, index }));
        return back(reply, s, `${BASE}/sql/objects/table?${new URLSearchParams({ o: table })}`);
      }
      output = html`<div class="alert alert-error" role="alert"><p><strong>${tx('te.nothing_changed')}</strong>: ${tx('te.rolled_back')}</p><p>${failed}</p><pre class="source" data-code-view="sql" tabindex="0" aria-label="${tx('te.failed_stmt')}">${at}</pre></div>`;
    }
  }

  const title = tx('fts.title', { table });
  const existing = cols.filter((c) => c.tsv);
  const sel = (a: string, v: string) => (a === v ? ' selected' : '');
  const main = html`<h1 class="u-mb1">${title}</h1>${workshopTabs('objects', s)}
    <p class="muted">${tx('fts.intro')}</p>
    ${existing.length ? html`<p>${tx('fts.existing')} ${existing.map((c) => html`<code>${c.name}</code> (${c.gin ? tx('fts.gin_yes') : tx('fts.gin_no')}) `)}</p>` : ''}
    ${errors.length ? html`<div class="alert alert-error" role="alert"><ul>${errors.map((e) => html`<li>${e}</li>`)}</ul></div>` : ''}
    ${output}
    ${texty.length ? html`<form method="post" action="${BASE}/sql/objects/fulltext" class="fts-form">${csrf(s)}
      <input type="hidden" name="o" value="${table}">
      <fieldset class="prop-group"><legend>${tx('fts.columns')}</legend>
        <div class="table-wrap"><table class="report"><thead><tr><th>${tx('fts.include')}</th><th>${tx('te.name')}</th><th>${tx('te.type')}</th><th>${tx('fts.weight')}</th></tr></thead><tbody>
        ${texty.map((c, i) => html`<tr><td class="te-c"><input type="hidden" name="c.${i}.name" value="${c.name}"><input type="checkbox" id="fts-c${i}" name="c.${i}.use"${picked.has(c.name) ? ' checked' : ''}></td>
          <td><label for="fts-c${i}">${c.name}</label></td><td><code>${c.type}</code></td>
          <td><select name="c.${i}.w" aria-label="${tx('fts.weight')} ${c.name}">${WEIGHTS.map((w) => html`<option${sel(w, picked.get(c.name) ?? 'B')}>${w}</option>`)}</select></td></tr>`)}
        </tbody></table></div>
        <small class="help">${tx('fts.weight_help')}</small></fieldset>
      <div class="form-grid u-mt1">
        <div class="field"><label class="label" for="fts-config">${tx('fts.config')}</label><select id="fts-config" name="config">${configs.map((n) => html`<option${sel(n, config)}>${n}</option>`)}</select><small class="help">${tx('fts.config_help')}</small></div>
        <div class="field"><label class="label" for="fts-column">${tx('fts.column')}</label><input id="fts-column" name="column" value="${column}" required autocomplete="off" spellcheck="false" class="code"></div>
        <div class="field"><label class="label" for="fts-index">${tx('fts.index')}</label><input id="fts-index" name="index" value="${index}" required autocomplete="off" spellcheck="false" class="code"></div>
      </div>
      ${ddl.length ? html`<h2>DDL</h2><pre class="source te-ddl" data-code-view="sql" tabindex="0" aria-label="DDL">${ddl.map((x) => `${x};`).join('\n\n')}</pre>` : ''}
      <div class="buttons te-buttons">
        <button class="btn" name="mode" value="preview">${icon('eye')} ${tx('te.preview')}</button>
        <button class="btn btn-hot" name="mode" value="apply">${icon('check')} ${tx('te.apply')}</button>
        <button class="btn" name="mode" value="worksheet">${icon('code')} ${tx('te.open_ws')}</button>
        <a class="btn" href="${BASE}/sql/objects/table?${new URLSearchParams({ o: table })}">${tx('common.cancel')}</a>
      </div></form>` : html`<p class="alert alert-info">${tx('fts.no_text')}</p>`}`;
  return send(reply, s, shell(s, title, [['SQL Workshop', `${BASE}/sql`], [tx('ob.title'), `${BASE}/sql/objects`], [tx('te.title_table', { table }), `${BASE}/sql/objects/table?${new URLSearchParams({ o: table })}`], [tx('fts.add')]], main, 'sql'));
}

export async function fulltextRoutes(app: FastifyInstance) {
  app.get(`${BASE}/sql/objects/fulltext`, page);
  app.post(`${BASE}/sql/objects/fulltext`, page);
}
