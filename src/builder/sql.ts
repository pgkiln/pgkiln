import type { FastifyInstance, FastifyReply } from 'fastify';
import pg from 'pg';
import { owner } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import { BASE, csrf, developer, region, send, shell, workshopTabs, type Req } from './ui.ts';

// SQL Workshop: SQL commands and the object browser (owner connection).

export async function sqlRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- SQL workshop
  const resultTable = (res: pg.QueryResult<any[]>, limit = 500) => {
    const rows = (res.rows ?? []).slice(0, limit);
    return html`<div class="table-wrap"><table class="report"><thead><tr>${res.fields.map((f) => html`<th>${f.name}</th>`)}</tr></thead>
      <tbody>${rows.map((r) => html`<tr>${r.map((v) => html`<td>${v === null ? html`<span class="null">null</span>` : typeof v === 'object' ? JSON.stringify(v) : String(v)}</td>`)}</tr>`)}</tbody></table></div>`;
  };

  const sqlWorkshop = async (req: Req, reply: FastifyReply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const sql = req.body?.sql ?? '';
    let result: Raw | '' = '';
    if (req.method === 'POST' && sql.trim()) {
      const started = performance.now();
      try {
        const out = await owner.pool.query({ text: sql, rowMode: 'array' });
        const res = Array.isArray(out) ? out[out.length - 1] : out;
        const ms = (performance.now() - started).toFixed(0);
        result = res.fields?.length
          ? html`<p class="muted">${res.rowCount} row(s) in ${ms} ms${res.rows.length > 500 ? ' (showing 500)' : ''}</p>${resultTable(res)}`
          : html`<div class="alert alert-success">${res.command ?? 'Statement'} completed${res.rowCount !== null ? `, ${res.rowCount} row(s)` : ''} in ${ms} ms.</div>`;
      } catch (e) {
        result = html`<div class="alert alert-error"><strong>Error:</strong> ${(e as Error).message}</div>`;
      }
    }
    const main = html`<h1 class="u-mb1">SQL Workshop</h1>${workshopTabs('sql')}
      <p class="muted">Runs as the builder's owner connection (not as an application role). Multiple statements are allowed; results of the last one are shown.</p>
      <form method="post">${csrf(s)}
        <textarea name="sql" class="code sql-editor" rows="12" spellcheck="false" aria-label="SQL">${sql || 'select * from hr.emp;'}</textarea>
        <div class="buttons"><button class="btn btn-hot">${icon('play')} Run (Ctrl+Enter)</button></div>
      </form>
      <div class="u-mt1">${result}</div>`;
    return send(reply, s, shell(s, 'SQL Workshop', [['SQL Workshop']], main, 'sql'));
  };
  app.get(`${BASE}/sql`, sqlWorkshop);
  app.post(`${BASE}/sql`, sqlWorkshop);

  app.get(`${BASE}/sql/objects`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const objects = (
      await owner.query(
        `select n.nspname as schema, c.relname as name, c.oid::regclass::text as qname,
                case c.relkind when 'r' then 'table' when 'p' then 'table' when 'v' then 'view' when 'm' then 'view' end as kind,
                c.relrowsecurity as rls
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where c.relkind in ('r', 'p', 'v', 'm') and n.nspname !~ '^pg_' and n.nspname not in ('information_schema')
         union all
         select n.nspname, p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', p.oid::regprocedure::text, 'function', false
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname !~ '^pg_' and n.nspname not in ('information_schema') and p.prokind in ('f', 'p')
          order by 1, 4 desc, 2`,
      )
    ).rows;
    const o = req.query.o;
    const selected = objects.find((x) => x.qname === o);
    let detail: Raw = html`<p class="muted">Select a table, view or function.</p>`;
    if (selected) {
      if (selected.kind === 'function') {
        const src = await owner.one('select pg_get_functiondef($1::regprocedure) as def', [selected.qname]);
        detail = region(selected.qname, html`<pre class="source">${src.def}</pre>`);
      } else {
        const [cols, policies, grants, data] = await Promise.all([
          owner.query(
            `select a.attname as column, format_type(a.atttypid, a.atttypmod) as type, not a.attnotnull as nullable,
                    pg_get_expr(d.adbin, d.adrelid) as "default"
               from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
              where a.attrelid = $1::regclass and a.attnum > 0 and not a.attisdropped order by a.attnum`,
            [selected.qname],
          ),
          owner.query('select policyname as policy, cmd, roles::text, qual as using, with_check from pg_policies where schemaname = $1 and tablename = $2', [selected.schema, selected.name]),
          owner.query(
            `select grantee, string_agg(privilege_type, ', ' order by privilege_type) as privileges
               from information_schema.role_table_grants where table_schema = $1 and table_name = $2 group by grantee order by grantee`,
            [selected.schema, selected.name],
          ),
          owner.pool.query({ text: `select * from ${selected.qname} limit 25`, rowMode: 'array' }).catch((e) => e as Error),
        ]);
        const asArray = (r: pg.QueryResult) => ({ ...r, rows: r.rows.map((x) => Object.values(x)) }) as unknown as pg.QueryResult<any[]>;
        detail = html`${region(`${selected.kind === 'view' ? 'View' : 'Table'} ${selected.qname}`, resultTable(asArray(cols)),
            html`<span class="count">${selected.rls ? 'row level security ON' : 'no RLS'}</span>`)}
          <div class="u-spacer"></div>
          ${region('Row level security policies', policies.rowCount ? resultTable(asArray(policies)) : html`<p class="muted">No policies.</p>`)}
          <div class="u-spacer"></div>
          ${region('Grants', resultTable(asArray(grants)))}
          <div class="u-spacer"></div>
          ${region('Data (first 25 rows)', data instanceof Error ? html`<div class="alert alert-error">${data.message}</div>` : resultTable(data))}`;
      }
    }
    let lastSchema = '';
    const list = html`<ul class="tree">${objects.map((x) => {
      const header = x.schema !== lastSchema ? html`<li class="group">${(lastSchema = x.schema)}</li>` : '';
      return html`${header}<li><a href="?o=${encodeURIComponent(x.qname)}"${x.qname === o ? raw(' aria-current="page"') : ''}>${icon(x.kind === 'function' ? 'code' : x.kind === 'view' ? 'layers' : 'table')}<span>${x.name}</span>${x.rls ? html`<span class="tag">RLS</span>` : ''}</a></li>`;
    })}</ul>`;
    const main = html`<h1 class="u-mb1">SQL Workshop</h1>${workshopTabs('objects')}
      <div class="designer"><aside class="region region-standard" aria-label="Database objects">${list}</aside><div>${detail}</div></div>`;
    return send(reply, s, shell(s, 'Object Browser', [['SQL Workshop', `${BASE}/sql`], ['Object Browser']], main, 'sql'));
  });

}
