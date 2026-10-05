import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { owner } from '../db.ts';
import { html, raw } from '../html.ts';
import { icon } from '../icons.ts';
import { BASE, csrf, developer, region, send, shell, workshopTabs, type Req } from './ui.ts';

// SQL Workshop → Query Builder: pick tables and views of a schema; joins
// follow their foreign keys; choose columns, conditions and the sort order;
// the SELECT is shown and can be run in SQL Commands. The whole state is in
// the query string (a GET form), so it works without JavaScript and can be
// bookmarked.
//
// Safety: identifiers come only from the catalog (anything else is dropped)
// and are quoted with escapeIdentifier; operators come from a fixed list;
// condition values become string literals (pg.escapeLiteral).

export interface CatalogRelation {
  name: string;
  kind: 'table' | 'view';
  columns: { name: string; type: string }[];
}

export interface CatalogFk {
  name: string;
  from: string;
  fromCols: string[];
  to: string;
  toCols: string[];
}

export interface QuerySpec {
  schema: string;
  tables: string[];
  /** alias.column; empty: all columns of all tables */
  columns: string[];
  /** join type per joined table alias */
  joinTypes: Record<string, 'inner' | 'left'>;
  where: { column: string; op: string; value: string }[];
  /** OR instead of AND between the conditions */
  any: boolean;
  order: { column: string; dir: 'asc' | 'desc' }[];
  limit: number | null;
  distinct: boolean;
}

export const OPERATORS: Record<string, string> = {
  '=': 'equals',
  '<>': 'not equal',
  '<': 'less than',
  '<=': 'at most',
  '>': 'greater than',
  '>=': 'at least',
  like: 'like (% _)',
  ilike: 'like, any case',
  in: 'in (a, b, c)',
  'is null': 'is empty',
  'is not null': 'is not empty',
};

const ident = pg.escapeIdentifier;

export interface BuiltQuery {
  sql: string;
  /** the aliases of the chosen tables, in order */
  aliases: Map<string, string>;
  /** how each table after the first is joined (null: cross join, no foreign key found) */
  joins: { alias: string; table: string; fk: CatalogFk | null }[];
  notes: string[];
}

/** Build the SELECT for a spec, using only names that exist in `relations`. */
export function buildQuery(relations: CatalogRelation[], fks: CatalogFk[], spec: QuerySpec): BuiltQuery | null {
  const byName = new Map(relations.map((r) => [r.name, r]));
  const tables = [...new Set(spec.tables)].filter((t) => byName.has(t));
  if (!tables.length) return null;
  const notes: string[] = [];
  const aliases = new Map(tables.map((t, k) => [t, `t${k + 1}`]));
  const q = (t: string) => `${ident(spec.schema)}.${ident(t)}`;

  // join order: each next table is the first one with a foreign key to or from a table already joined
  const joined = [tables[0]];
  const joins: BuiltQuery['joins'] = [];
  const pending = tables.slice(1);
  while (pending.length) {
    let pick = -1;
    let fk: CatalogFk | null = null;
    for (const [k, t] of pending.entries()) {
      fk = fks.find((f) => f.from !== f.to && ((f.from === t && joined.includes(f.to)) || (f.to === t && joined.includes(f.from)))) ?? null;
      if (fk) {
        pick = k;
        break;
      }
    }
    if (pick < 0) {
      pick = 0;
      notes.push(`No foreign key connects ${pending[0]} to the other tables: it is cross joined.`);
    }
    const t = pending.splice(pick, 1)[0];
    joins.push({ alias: aliases.get(t)!, table: t, fk });
    joined.push(t);
  }

  const colRef = (ref: string) => {
    const [alias, col] = ref.split('.', 2);
    const t = [...aliases].find(([, a]) => a === alias)?.[0];
    if (!t || !col || !byName.get(t)!.columns.some((c) => c.name === col)) return null;
    return `${alias}.${ident(col)}`;
  };

  const chosen = spec.columns.map((c) => [c, colRef(c)] as const).filter((x): x is readonly [string, string] => !!x[1]);
  const select = chosen.length
    ? chosen.map(([ref, sql]) => {
        // distinct output names when two tables have a column of the same name
        const col = ref.split('.', 2)[1];
        const clash = chosen.filter(([r]) => r.split('.', 2)[1] === col).length > 1;
        return clash ? `${sql} as ${ident(`${ref.split('.')[0]}_${col}`)}` : sql;
      })
    : tables.map((t) => `${aliases.get(t)}.*`);

  let from = `${q(tables[0])} ${aliases.get(tables[0])}`;
  for (const j of joins) {
    const a = j.alias;
    if (!j.fk) {
      from += `\n  cross join ${q(j.table)} ${a}`;
      continue;
    }
    const fromAlias = aliases.get(j.fk.from)!;
    const toAlias = aliases.get(j.fk.to)!;
    const on = j.fk.fromCols.map((c, k) => `${fromAlias}.${ident(c)} = ${toAlias}.${ident(j.fk!.toCols[k])}`).join(' and ');
    from += `\n  ${spec.joinTypes[a] === 'left' ? 'left join' : 'join'} ${q(j.table)} ${a} on ${on}`;
  }

  const conds: string[] = [];
  for (const w of spec.where) {
    const col = colRef(w.column);
    if (!col || !(w.op in OPERATORS)) continue;
    if (w.op === 'is null' || w.op === 'is not null') conds.push(`${col} ${w.op}`);
    else if (w.op === 'in') {
      const vals = w.value.split(',').map((v) => v.trim()).filter(Boolean);
      if (vals.length) conds.push(`${col} in (${vals.map((v) => pg.escapeLiteral(v)).join(', ')})`);
    } else conds.push(`${col} ${w.op} ${pg.escapeLiteral(w.value)}`);
  }
  const order = spec.order.flatMap((o) => {
    const col = colRef(o.column);
    return col ? [`${col}${o.dir === 'desc' ? ' desc' : ''}`] : [];
  });

  let sql = `select ${spec.distinct ? 'distinct ' : ''}${select.join(',\n       ')}\n  from ${from}`;
  if (conds.length) sql += `\n where ${conds.join(spec.any ? '\n    or ' : '\n   and ')}`;
  if (order.length) sql += `\n order by ${order.join(', ')}`;
  if (spec.limit) sql += `\n limit ${spec.limit}`;
  return { sql, aliases, joins, notes };
}

/** Tables and views of a schema, with their columns, and the foreign keys between its tables. */
export async function loadCatalog(schema: string) {
  const rels = (
    await owner.query(
      `select c.relname as name, case when c.relkind in ('r', 'p') then 'table' else 'view' end as kind,
              coalesce((select json_agg(json_build_object('name', a.attname, 'type', format_type(a.atttypid, a.atttypmod)) order by a.attnum)
                          from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped), '[]') as columns
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = $1 and c.relkind in ('r', 'p', 'v', 'm')
        order by c.relname`,
      [schema],
    )
  ).rows as CatalogRelation[];
  const fks = (
    await owner.query(
      `select k.conname as name, c.relname as "from", f.relname as "to",
              (select array_agg(a.attname::text order by x.n) from unnest(k.conkey) with ordinality x(attnum, n) join pg_attribute a on a.attrelid = k.conrelid and a.attnum = x.attnum) as "fromCols",
              (select array_agg(a.attname::text order by x.n) from unnest(k.confkey) with ordinality x(attnum, n) join pg_attribute a on a.attrelid = k.confrelid and a.attnum = x.attnum) as "toCols"
         from pg_constraint k
         join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
         join pg_class f on f.oid = k.confrelid join pg_namespace fn on fn.oid = f.relnamespace
        where k.contype = 'f' and n.nspname = $1 and fn.nspname = $1
        order by k.conname`,
      [schema],
    )
  ).rows as CatalogFk[];
  return { rels, fks };
}

const list = (v: unknown): string[] => (v === undefined ? [] : Array.isArray(v) ? v.map(String) : [String(v)]);

/** Read a spec from the query string (the names are checked later, against the catalog). */
export function specFromQuery(q: Record<string, unknown>, schema: string): QuerySpec {
  const wc = list(q.wc);
  const wo = list(q.wo);
  const wv = list(q.wv);
  const oc = list(q.oc);
  const od = list(q.od);
  const limit = Number(q.limit);
  const joinTypes: Record<string, 'inner' | 'left'> = {};
  for (const [k, v] of Object.entries(q)) if (/^jt_t\d+$/.test(k)) joinTypes[k.slice(3)] = v === 'left' ? 'left' : 'inner';
  return {
    schema,
    tables: list(q.t).slice(0, 20),
    columns: list(q.c).slice(0, 500),
    joinTypes,
    where: wc.slice(0, 20).map((column, k) => ({ column, op: wo[k] ?? '=', value: wv[k] ?? '' })),
    any: q.any === 'or',
    order: oc.slice(0, 5).map((column, k) => ({ column, dir: od[k] === 'desc' ? 'desc' : 'asc' })),
    limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100000) : null,
    distinct: q.distinct === '1',
  };
}

export async function queryBuilderRoutes(app: FastifyInstance) {
  app.get(`${BASE}/sql/query`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const schemas = (
      await owner.query(
        `select nspname as name from pg_namespace where nspname !~ '^pg_' and nspname not in ('information_schema') order by nspname = 'meta', nspname`,
      )
    ).rows.map((r) => r.name as string);
    const schema = schemas.find((x) => x === req.query.schema) ?? schemas.find((x) => x === 'public') ?? schemas[0] ?? 'public';
    const { rels, fks } = await loadCatalog(schema);
    const spec = specFromQuery(req.query as Record<string, unknown>, schema);
    const built = buildQuery(rels, fks, spec);
    const chosen = built ? [...built.aliases.keys()] : [];
    const check = (on: boolean) => (on ? raw(' checked') : '');
    const sel = (on: boolean) => (on ? raw(' selected') : '');

    const allCols = chosen.flatMap((t) => rels.find((r) => r.name === t)!.columns.map((c) => ({ ref: `${built!.aliases.get(t)}.${c.name}`, label: `${built!.aliases.get(t)}.${c.name}`, table: t, type: c.type })));
    const colOptions = (current: string) => html`<option value="">-</option>${allCols.map((c) => html`<option value="${c.ref}"${sel(c.ref === current)}>${c.label} (${c.type})</option>`)}`;
    const wheres = [...spec.where.filter((w) => w.column), { column: '', op: '=', value: '' }];
    const orders = [...spec.order.filter((o) => o.column), { column: '', dir: 'asc' as const }];

    const form = html`<form method="get" action="${BASE}/sql/query">
      ${region('1. Tables and views', html`<div class="form-grid"><div class="field"><label class="label" for="f_schema">Schema</label>
          <select id="f_schema" name="schema">${schemas.map((x) => html`<option${sel(x === schema)}>${x}</option>`)}</select></div></div>
        ${rels.length
          ? html`<fieldset class="field"><legend class="label">Tables and views of ${schema}</legend><div class="qb-pick">
              ${rels.map((r) => html`<label class="check"><input type="checkbox" name="t" value="${r.name}"${check(chosen.includes(r.name))}> ${r.name}${r.kind === 'view' ? html` <span class="tag">view</span>` : ''}${chosen.includes(r.name) ? html` <span class="muted small">${built!.aliases.get(r.name)}</span>` : ''}</label>`)}
            </div></fieldset>`
          : html`<p class="muted">This schema has no tables or views.</p>`}
        <div class="buttons"><button class="btn">${icon('check')} Apply</button></div>`)}
      ${built
        ? html`<div class="u-spacer"></div>
        ${built.joins.length
          ? region('2. Joins', html`<p class="muted u-mt0">From the foreign keys between the chosen tables.</p>
              ${built.notes.map((n) => html`<div class="alert alert-error" role="alert">${n}</div>`)}
              <ul class="qb-joins">${built.joins.map((j) => html`<li class="u-mb1">${j.table} <span class="muted">${j.alias}</span>
                ${j.fk ? html` on ${j.fk.from}(${j.fk.fromCols.join(', ')}) → ${j.fk.to}(${j.fk.toCols.join(', ')})
                  <label class="sr-only" for="f_jt_${j.alias}">Join type for ${j.table}</label>
                  <select id="f_jt_${j.alias}" name="jt_${j.alias}"><option value="inner">inner join</option><option value="left"${sel(spec.joinTypes[j.alias] === 'left')}>left join (keep rows without a match)</option></select>` : html` (cross join)`}</li>`)}</ul>`)
          : ''}
        <div class="u-spacer"></div>
        ${region('3. Columns', html`<p class="muted u-mt0">None ticked: all columns.</p>
          <label class="check u-mb1"><input type="checkbox" name="distinct" value="1"${check(spec.distinct)}> Distinct rows</label>
          <div class="qb-pick">${allCols.map((c) => html`<label class="check"><input type="checkbox" name="c" value="${c.ref}"${check(spec.columns.includes(c.ref))}> ${c.label}</label>`)}</div>`)}
        <div class="u-spacer"></div>
        ${region('4. Conditions', html`<fieldset class="field"><legend class="label">Rows must match</legend><div class="radio-group">
            <label class="check"><input type="radio" name="any" value="and"${check(!spec.any)}> all conditions</label>
            <label class="check"><input type="radio" name="any" value="or"${check(spec.any)}> any condition</label></div></fieldset>
          ${wheres.map((w, k) => html`<div class="qb-cond">
            <select name="wc" aria-label="Condition ${k + 1}: column">${colOptions(w.column)}</select>
            <select name="wo" aria-label="Condition ${k + 1}: operator">${Object.entries(OPERATORS).map(([op, label]) => html`<option value="${op}"${sel(op === w.op)}>${op} · ${label}</option>`)}</select>
            <input name="wv" value="${w.value}" aria-label="Condition ${k + 1}: value"></div>`)}
          <div class="buttons"><button class="btn">${icon('plus')} Apply / add a condition</button></div>`)}
        <div class="u-spacer"></div>
        ${region('5. Sort and limit', html`${orders.map((o, k) => html`<div class="qb-cond">
            <select name="oc" aria-label="Sort ${k + 1}: column">${colOptions(o.column)}</select>
            <select name="od" aria-label="Sort ${k + 1}: direction"><option value="asc">ascending</option><option value="desc"${sel(o.dir === 'desc')}>descending</option></select><span></span></div>`)}
          <div class="form-grid"><div class="field"><label class="label" for="f_limit">At most (rows)</label><input id="f_limit" name="limit" type="number" min="1" max="100000" value="${spec.limit ?? ''}"></div></div>
          <div class="buttons"><button class="btn btn-hot">${icon('check')} Apply</button></div>`)}`
        : ''}
    </form>`;

    const output = built
      ? html`<div class="u-spacer"></div>${region('SQL', html`<pre class="source" tabindex="0" aria-label="Generated SQL">${built.sql}</pre>
          <form method="post" action="${BASE}/sql">${csrf(s)}<input type="hidden" name="sql" value="${built.sql}">
            <div class="buttons"><button class="btn btn-hot">${icon('play')} Run in SQL Commands</button></div></form>`)}`
      : '';
    return send(reply, s, shell(s, 'Query Builder', [['SQL Workshop', `${BASE}/sql`], ['Query Builder']], html`<h1 class="u-mb1">SQL Workshop</h1>${workshopTabs('query')}${form}${output}`, 'sql'));
  });
}
