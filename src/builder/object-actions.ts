import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { html, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import { readSchema } from '../ddl.ts';
import { back, BASE, developer, flash, type Req } from './ui.ts';
import { listObjects, objectDetail, OB_TYPES, SYSTEM_SCHEMAS, type Obj } from './object-browser.ts';
import { usableSchemas, workshopDb } from './workspaces.ts';

// (sprint 94, Database Actions DA-8) An object's menu in the SQL Worksheet's navigator and the Object Browser's
// tree (Database Actions: the navigator's right-click menu): Open (the Object Browser's detail, in a panel beside
// the worksheet), Quick DDL into the worksheet or as a file, Load data, Add an index / trigger / policy, Use as a
// template, and Drop with what depends on the object. Nothing here changes the database: every statement goes into
// the worksheet to review and run. The object is looked up in the catalog with the workshop's connection (its
// schema, type and reference must name one of the listed objects) before anything is read.

type Db = Awaited<ReturnType<typeof workshopDb>>;
export type MenuObj = Pick<Obj, 'name' | 'ref'> & { type: Obj['type'] | 'policy' };

const RELATIONS = new Set(['table', 'view', 'matview']);

/** The ⋯ menu of an object (works without JavaScript: a details menu of links). */
export function objectMenu(schema: string, o: MenuObj): Raw {
  const q = (act: string) => `${BASE}/sql/objects/action?${new URLSearchParams({ schema, k: o.type, o: o.ref, ...(o.type === 'policy' || o.type === 'trigger' ? { n: o.name } : {}), do: act })}`;
  const open = `${BASE}/sql/objects?${new URLSearchParams(o.type === 'policy' ? { schema, k: 'table', o: o.ref, tab: 'rls' } : { schema, k: o.type, o: o.ref })}`;
  const item = (href: string, ic: string, label: string, extra = '') => html`<a href="${href}"${extra ? html` ${extra}` : ''}>${icon(ic)} ${label}</a>`;
  const table = o.type === 'table';
  return html`<details class="menu obj-menu"><summary title="Actions for ${o.name}" aria-label="Actions for ${o.name}">⋯</summary>
    <div class="menu-panel"><div class="menu-section menu-links">
      ${o.type === 'policy' ? '' : html`<a href="${open}" data-obj-open="${`${BASE}/sql/objects/panel?${new URLSearchParams({ schema, k: o.type, o: o.ref })}`}">${icon('eye')} Open</a>`}
      ${table ? item(`${BASE}/sql/load`, 'upload', 'Load data') : ''}
      ${table ? html`${item(q('index'), 'list', 'Add index')}${item(q('trigger'), 'bolt', 'Add trigger')}${item(q('policy'), 'shield', 'Add policy')}` : ''}
      ${item(q('ddl'), 'code', 'Quick DDL to the worksheet')}
      ${item(q('download'), 'download', 'Quick DDL as a file')}
      ${item(q('drop'), 'trash', 'Drop…')}
    </div></div></details>`;
}

/** The listed object the request names, or undefined. */
async function findObject(db: Db, schema: unknown, kind: unknown, ref: unknown, name: unknown): Promise<MenuObj | undefined> {
  if (typeof schema !== 'string' || typeof ref !== 'string' || typeof kind !== 'string') return undefined;
  if (SYSTEM_SCHEMAS.includes(schema) || !(await usableSchemas(db)).includes(schema)) return undefined;
  if (kind === 'policy') {
    const p = await db.one<{ name: string }>(
      `select p.polname || ' on ' || c.relname as name from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = $1 and c.oid::regclass::text = $2 and p.polname || ' on ' || c.relname = $3`, [schema, ref, String(name ?? '')]);
    return p ? { type: 'policy', name: p.name, ref } : undefined;
  }
  return (await listObjects(db, schema, false)).find((o) => o.type === kind && o.ref === ref);
}

const relnameOf = (o: MenuObj, schema: string) => {
  const t = o.type === 'trigger' ? o.ref.split('|')[0] : o.ref;
  return t.startsWith(`${pg.escapeIdentifier(schema)}.`) || t.startsWith(`${schema}.`) ? t.slice(t.indexOf('.') + 1).replace(/^"|"$/g, '').replace(/""/g, '"') : t.replace(/^"|"$/g, '');
};

/** The DDL of one object: what the Object Browser's DDL tab shows. */
export async function objectDdl(db: Db, schema: string, o: MenuObj): Promise<string> {
  if (o.type === 'function' || o.type === 'procedure') return `${(await db.one<{ def: string }>('select pg_get_functiondef($1::regprocedure) as def', [o.ref]).catch(() => undefined))?.def?.trimEnd() ?? ''};`;
  if (o.type === 'trigger') {
    const [rel, name] = o.ref.split('|');
    return `${(await db.one<{ def: string }>('select pg_get_triggerdef(oid, true) as def from pg_trigger where tgrelid = $1::regclass and tgname = $2', [rel, name]))?.def ?? ''};`;
  }
  if (o.type === 'index') return `${(await db.one<{ def: string }>('select pg_get_indexdef($1::regclass) as def', [o.ref]))?.def ?? ''};`;
  const rel = relnameOf(o, schema);
  const objects = await readSchema(db.pool as pg.Pool, schema).catch(() => []);
  const pick = o.type === 'policy'
    ? objects.filter((x) => x.kind === 'policy' && x.table === rel && x.name.endsWith(`.${o.name.slice(0, o.name.lastIndexOf(' on '))}`))
    : o.type === 'sequence' ? objects.filter((x) => x.kind === 'sequence' && x.name === rel)
      : o.type === 'type' ? objects.filter((x) => (x.kind === 'type' || x.kind === 'domain') && x.name === rel)
        : objects.filter((x) => (['table', 'view', 'materialized view'].includes(x.kind) ? x.name === rel : x.table === rel));
  return pick.map((x) => x.ddl).join('\n\n');
}

/** What depends on the object (views, foreign keys, triggers' functions…), as lines for a comment. */
async function dependents(db: Db, o: MenuObj): Promise<string[]> {
  if (!RELATIONS.has(o.type) && o.type !== 'function' && o.type !== 'type' && o.type !== 'sequence') return [];
  const rows = (await db.query<{ what: string }>(
    o.type === 'function'
      ? `select distinct pg_describe_object(d.classid, d.objid, d.objsubid) as what from pg_depend d
          where d.refclassid = 'pg_proc'::regclass and d.refobjid = $1::regprocedure and d.deptype = 'n' order by 1 limit 50`
      : o.type === 'type'
        ? `select distinct pg_describe_object(d.classid, d.objid, d.objsubid) as what from pg_depend d
            where d.refclassid = 'pg_type'::regclass and d.refobjid = $1::regtype and d.deptype = 'n' order by 1 limit 50`
        : `select distinct coalesce(case when d.classid = 'pg_rewrite'::regclass then 'view ' || r.ev_class::regclass::text end, pg_describe_object(d.classid, d.objid, d.objsubid)) as what
             from pg_depend d left join pg_rewrite r on d.classid = 'pg_rewrite'::regclass and r.oid = d.objid
            where d.refclassid = 'pg_class'::regclass and d.refobjid = $1::regclass and d.deptype = 'n'
              and not (d.classid = 'pg_rewrite'::regclass and r.ev_class = $1::regclass)
            order by 1 limit 50`,
    [o.ref])).rows;
  return rows.map((r) => r.what);
}

const DROP_KIND: Record<string, string> = { table: 'table', view: 'view', matview: 'materialized view', index: 'index', sequence: 'sequence', type: 'type', function: 'function', procedure: 'procedure' };

/** The statements a menu entry writes into the worksheet. */
async function draft(db: Db, schema: string, o: MenuObj, act: string): Promise<string | null> {
  const ident = (n: string) => (/^[a-z_][a-z0-9_$]*$/.test(n) ? n : pg.escapeIdentifier(n));
  const firstCol = async () => (await db.one<{ n: string }>(`select attname as n from pg_attribute where attrelid = $1::regclass and attnum > 0 and not attisdropped order by attnum limit 1`, [o.ref]))?.n ?? 'id';
  const base = relnameOf(o, schema).replace(/[^A-Za-z0-9_]+/g, '_').toLowerCase().slice(0, 40);
  switch (act) {
    case 'ddl':
      // the DDL names objects within their schema: the search path makes the statements run there
      return `-- DDL of ${o.ref}\nset search_path to ${ident(schema)}, public;\n\n${await objectDdl(db, schema, o)}`;
    case 'index':
      return `create index ${base}_${(await firstCol()).replace(/[^A-Za-z0-9_]+/g, '_').toLowerCase()}_idx on ${o.ref} (${ident(await firstCol())});`;
    case 'trigger':
      return `create or replace function ${ident(schema)}.${base}_trg() returns trigger\nlanguage plpgsql as $$\nbegin\n  -- new and old are the row after and before the change\n  return new;\nend\n$$;\n\ncreate trigger ${base}_trg\n  before insert or update on ${o.ref}\n  for each row execute function ${ident(schema)}.${base}_trg();`;
    case 'policy':
      return `-- row level security applies once it is enabled on the table\nalter table ${o.ref} enable row level security;\n\ncreate policy ${base}_select on ${o.ref}\n  for select\n  using (true);`;
    case 'drop': {
      const deps = await dependents(db, o);
      const note = deps.length
        ? `-- These depend on ${o.ref}: drop them first, or add CASCADE to drop them too:\n${deps.map((d) => `--   ${d}`).join('\n')}\n`
        : `-- Nothing else depends on ${o.ref}.\n`;
      if (o.type === 'trigger') {
        const [rel, name] = o.ref.split('|');
        return `drop trigger ${ident(name)} on ${rel};`;
      }
      if (o.type === 'policy') return `drop policy ${ident(o.name.slice(0, o.name.lastIndexOf(' on ')))} on ${o.ref};`;
      return `${note}drop ${DROP_KIND[o.type]} ${o.ref};`;
    }
  }
  return null;
}

export async function objectActionRoutes(app: FastifyInstance) {
  // a menu entry: the statement into the worksheet (a new tab there), or the DDL as a file
  app.get(`${BASE}/sql/objects/action`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const db = await workshopDb(s);
    const q = req.query ?? {};
    const o = await findObject(db, q.schema, q.k, q.o, q.n);
    const act = String(q.do ?? '');
    if (!o || !['ddl', 'download', 'index', 'trigger', 'policy', 'drop'].includes(act)) return reply.code(404).send('Not found');
    if (['index', 'trigger', 'policy'].includes(act) && o.type !== 'table') return reply.code(404).send('Not found');
    if (act === 'download') {
      const file = `${relnameOf(o, String(q.schema))}`.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'ddl';
      return reply.header('content-disposition', `attachment; filename="${file}.sql"`).header('cache-control', 'private, no-store')
        .type('application/sql; charset=utf-8').send(`${await objectDdl(db, String(q.schema), o)}\n`);
    }
    const sql = await draft(db, String(q.schema), o, act);
    s.state.__SQLDRAFT = sql ?? '';
    flash(s, act === 'ddl' ? `The DDL of ${o.ref}.` : act === 'drop' ? 'Review the DROP statement and run it yourself: nothing has been dropped yet.' : 'Fill in the statement and run it: nothing has been changed yet.');
    return back(reply, s, `${BASE}/sql/worksheet`);
  });

  // Open: the Object Browser's detail of an object without the page around it (the worksheet shows it in a panel)
  app.get(`${BASE}/sql/objects/panel`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const db = await workshopDb(s);
    const q = req.query ?? {};
    const o = await findObject(db, q.schema, q.k, q.o, q.n);
    if (!o || o.type === 'policy') return reply.code(404).send('Not found');
    const schema = String(q.schema);
    const link = (extra: Record<string, string>) => `${BASE}/sql/objects/panel?${new URLSearchParams({ schema, ...extra })}`;
    const detail = await objectDetail(db, s, schema, o as Obj, String(q.tab ?? ''), Number(q.p) || 1, link);
    const label = OB_TYPES.find(([t]) => t === o.type)?.[1] ?? o.type;
    return reply.header('Cache-Control', 'private, no-store').type('text/html')
      .send(String(html`<div class="obj-panel" data-label="${label}: ${o.ref}">${detail}</div>`));
  });
}
