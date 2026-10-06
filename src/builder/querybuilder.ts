import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { owner } from '../db.ts';
import { html, raw } from '../html.ts';
import { icon } from '../icons.ts';
import { BASE, csrf, developer, region, send, shell, workshopTabs, type Req } from './ui.ts';

// SQL Workshop → Query Builder: pick tables and views of a schema; joins
// follow their foreign keys, or columns joined by the developer (drawn on
// the canvas from one column to another, or chosen in a form); choose
// columns (with count/sum/avg/min/max: the other columns are grouped by),
// conditions and the sort order; the SELECT is shown and can be run in SQL
// Commands. The whole state is in the query string (a GET form), so it
// works without JavaScript and can be bookmarked. (0.31) The chosen tables
// are boxes on a canvas: builder.js places them (positions in p=table:x,y),
// lets them be dragged and draws the joins as lines.
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
  /** (0.31) joins chosen by the developer: alias.column = alias.column */
  joins: { a: string; b: string }[];
  /** (0.31) a function per column (alias.column → one of FUNCTIONS) */
  fns: Record<string, string>;
  /** (0.31) canvas positions per table name */
  positions: Record<string, { x: number; y: number }>;
}

/** Column functions; any of them makes the other chosen columns the GROUP BY. */
export const FUNCTIONS: Record<string, string> = {
  count: 'count',
  count_distinct: 'count distinct',
  sum: 'sum',
  avg: 'average',
  min: 'minimum',
  max: 'maximum',
};
const fnSql = (fn: string, col: string) => (fn === 'count_distinct' ? `count(distinct ${col})` : `${fn}(${col})`);

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
  /** how each table after the first is joined (fk and custom empty: cross join) */
  joins: { alias: string; table: string; fk: CatalogFk | null; custom: { a: string; b: string }[] }[];
  /** whether the query groups (a column has a function) */
  grouped: boolean;
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

  const tableOf = (ref: string) => {
    const [alias, col] = ref.split('.', 2);
    const t = [...aliases].find(([, a]) => a === alias)?.[0];
    return t && col && byName.get(t)!.columns.some((c) => c.name === col) ? t : null;
  };
  const colRef = (ref: string) => (tableOf(ref) ? `${ref.split('.', 2)[0]}.${ident(ref.split('.', 2)[1])}` : null);
  // the developer's joins: two existing columns of two different chosen tables
  const custom = spec.joins.filter((j) => tableOf(j.a) && tableOf(j.b) && tableOf(j.a) !== tableOf(j.b));

  // join order: each next table is the first one joined by the developer, or with a foreign key, to a table already joined
  const joined = [tables[0]];
  const joins: BuiltQuery['joins'] = [];
  const pending = tables.slice(1);
  const customFor = (t: string) =>
    custom.filter((j) => (tableOf(j.a) === t && joined.includes(tableOf(j.b)!)) || (tableOf(j.b) === t && joined.includes(tableOf(j.a)!)));
  while (pending.length) {
    let pick = pending.findIndex((t) => customFor(t).length);
    let fk: CatalogFk | null = null;
    if (pick < 0)
      for (const [k, t] of pending.entries()) {
        fk = fks.find((f) => f.from !== f.to && ((f.from === t && joined.includes(f.to)) || (f.to === t && joined.includes(f.from)))) ?? null;
        if (fk) {
          pick = k;
          break;
        }
      }
    if (pick < 0) {
      pick = 0;
      notes.push(`No foreign key connects ${pending[0]} to the other tables: it is cross joined. Join two of their columns on the canvas, or under Joins.`);
    }
    const t = pending.splice(pick, 1)[0];
    joins.push({ alias: aliases.get(t)!, table: t, fk: customFor(t).length ? null : fk, custom: customFor(t) });
    joined.push(t);
  }

  // a column with a function is chosen even when it isn't ticked
  const fns = Object.fromEntries(Object.entries(spec.fns).filter(([ref, fn]) => fn in FUNCTIONS && colRef(ref)));
  const refs = [...new Set([...spec.columns, ...Object.keys(fns)])];
  const chosen = refs.map((c) => [c, colRef(c)] as const).filter((x): x is readonly [string, string] => !!x[1]);
  const grouped = Object.keys(fns).length > 0;
  const outName = (ref: string) => {
    const col = ref.split('.', 2)[1];
    if (fns[ref]) return `${fns[ref]}_${col}`;
    // distinct output names when two tables have a column of the same name
    return chosen.filter(([r]) => !fns[r] && r.split('.', 2)[1] === col).length > 1 ? `${ref.split('.')[0]}_${col}` : null;
  };
  const expr = (ref: string, sql: string) => (fns[ref] ? fnSql(fns[ref], sql) : sql);
  const select = chosen.length
    ? chosen.map(([ref, sql]) => {
        const name = outName(ref);
        return name ? `${expr(ref, sql)} as ${ident(name)}` : sql;
      })
    : tables.map((t) => `${aliases.get(t)}.*`);
  const groupBy = grouped ? chosen.filter(([ref]) => !fns[ref]).map(([, sql]) => sql) : [];

  let from = `${q(tables[0])} ${aliases.get(tables[0])}`;
  for (const j of joins) {
    const a = j.alias;
    if (j.custom.length) {
      const on = j.custom.map((c) => `${colRef(c.a)} = ${colRef(c.b)}`).join(' and ');
      from += `\n  ${spec.joinTypes[a] === 'left' ? 'left join' : 'join'} ${q(j.table)} ${a} on ${on}`;
      continue;
    }
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
    // grouped: a column with a function sorts by its result; others must be grouped by
    if (!col || (grouped && !fns[o.column] && !groupBy.includes(col))) return [];
    return [`${expr(o.column, col)}${o.dir === 'desc' ? ' desc' : ''}`];
  });

  let sql = `select ${spec.distinct ? 'distinct ' : ''}${select.join(',\n       ')}\n  from ${from}`;
  if (conds.length) sql += `\n where ${conds.join(spec.any ? '\n    or ' : '\n   and ')}`;
  if (groupBy.length) sql += `\n group by ${groupBy.join(', ')}`;
  if (order.length) sql += `\n order by ${order.join(', ')}`;
  if (spec.limit) sql += `\n limit ${spec.limit}`;
  return { sql, aliases, joins, notes, grouped };
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
    // in the order they were chosen (o: the previous order; the form lists the tables alphabetically), so aliases stay
    tables: ((order) => list(q.t).slice(0, 20).map((t, k) => [t, order.indexOf(t) < 0 ? 1000 + k : order.indexOf(t)] as const).sort((a, b) => a[1] - b[1]).map(([t]) => t))(
      list(q.o).join(',').split(','),
    ),
    columns: list(q.c).slice(0, 500),
    joinTypes,
    where: wc.slice(0, 20).map((column, k) => ({ column, op: wo[k] ?? '=', value: wv[k] ?? '' })),
    any: q.any === 'or',
    order: oc.slice(0, 5).map((column, k) => ({ column, dir: od[k] === 'desc' ? 'desc' : 'asc' })),
    limit: Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100000) : null,
    distinct: q.distinct === '1',
    joins: [
      ...list(q.j).slice(0, 20).map((v) => v.split('=', 2)),
      // the form's "add a join" pair
      ...(list(q.ja)[0] && list(q.jb)[0] ? [[list(q.ja)[0], list(q.jb)[0]]] : []),
    ].filter((x) => x.length === 2 && x[0] && x[1]).map(([a, b]) => ({ a, b })),
    fns: Object.fromEntries(list(q.fn).slice(0, 500).map((v) => [v.slice(0, v.lastIndexOf(':')), v.slice(v.lastIndexOf(':') + 1)]).filter(([ref, fn]) => ref && fn in FUNCTIONS)),
    positions: Object.fromEntries(
      list(q.p).slice(0, 20).flatMap((v) => {
        const m = /^(.+):(\d{1,5}),(\d{1,5})$/.exec(v);
        return m ? [[m[1], { x: Math.min(Number(m[2]), 20000), y: Math.min(Number(m[3]), 20000) }]] : [];
      }),
    ),
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
    // the canvas's lines: foreign keys (first column pair) and the developer's joins
    const lines = built
      ? built.joins.flatMap((j) =>
          j.custom.length
            ? j.custom.map((c) => ({ a: c.a, b: c.b, custom: true }))
            : j.fk ? [{ a: `${built.aliases.get(j.fk.from)}.${j.fk.fromCols[0]}`, b: `${built.aliases.get(j.fk.to)}.${j.fk.toCols[0]}`, custom: false }] : [],
        )
      : [];
    const wheres = [...spec.where.filter((w) => w.column), { column: '', op: '=', value: '' }];
    const orders = [...spec.order.filter((o) => o.column), { column: '', dir: 'asc' as const }];

    const form = html`<form method="get" action="${BASE}/sql/query">${chosen.length ? html`<input type="hidden" name="o" value="${chosen.join(',')}">` : ''}
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
        ${region('2. Columns', html`<p class="muted u-mt0">None ticked: all columns. A function (count, sum, …) groups the rows by the other chosen columns. Drag a table by its handle (or focus the handle and use the arrow keys); drag the dot next to a column onto a column of another table to join them.</p>
          <label class="check u-mb1"><input type="checkbox" name="distinct" value="1"${check(spec.distinct)}> Distinct rows</label>
          <div class="qb-canvas" data-joins="${JSON.stringify(lines)}">${chosen.map((t, k) => {
            const a = built!.aliases.get(t)!;
            const pos = spec.positions[t] ?? { x: 16 + k * 272, y: 16 };
            return html`<div class="qb-table" data-table="${t}" data-alias="${a}" data-x="${pos.x}" data-y="${pos.y}">
              ${spec.positions[t] ? html`<input type="hidden" name="p" value="${t}:${pos.x},${pos.y}">` : ''}
              <div class="qb-table-head"><button type="button" class="qb-move" hidden aria-label="Move ${t} (arrow keys)" title="Drag to move">${icon('menu')}</button>
                <strong>${t}</strong> <span class="muted small">${a}</span></div>
              <ul class="qb-cols">${rels.find((r) => r.name === t)!.columns.map((c) => {
                const ref = `${a}.${c.name}`;
                return html`<li class="qb-col" data-ref="${ref}">
                  <label class="check"><input type="checkbox" name="c" value="${ref}"${check(spec.columns.includes(ref))}> ${c.name}</label>
                  <span class="muted small qb-type">${c.type}</span>
                  <select name="fn" aria-label="Function for ${ref}"><option value="">-</option>${Object.entries(FUNCTIONS).map(([fn, label]) => html`<option value="${ref}:${fn}"${sel(spec.fns[ref] === fn)}>${label}</option>`)}</select>
                  ${chosen.length > 1 ? html`<button type="button" class="qb-link" hidden data-ref="${ref}" aria-label="Join ${ref} to a column of another table" title="Drag onto a column of another table to join them"></button>` : ''}
                </li>`;
              })}</ul></div>`;
          })}</div>`)}
        ${built.joins.length
          ? html`<div class="u-spacer"></div>${region('3. Joins', html`<p class="muted u-mt0">From the foreign keys between the chosen tables, or the columns you joined.</p>
              ${built.notes.map((n) => html`<div class="alert alert-error" role="alert">${n}</div>`)}
              <ul class="qb-joins">${built.joins.map((j) => html`<li class="u-mb1">${j.table} <span class="muted">${j.alias}</span>
                ${j.custom.length
                  ? html` on ${j.custom.map((c, k) => html`${k ? ' and ' : ''}<label class="check qb-inline"><input type="checkbox" name="j" value="${c.a}=${c.b}" checked> ${c.a} = ${c.b}</label>`)}`
                  : j.fk ? html` on ${j.fk.from}(${j.fk.fromCols.join(', ')}) → ${j.fk.to}(${j.fk.toCols.join(', ')})` : html` (cross join)`}
                ${j.fk || j.custom.length ? html`<label class="sr-only" for="f_jt_${j.alias}">Join type for ${j.table}</label>
                  <select id="f_jt_${j.alias}" name="jt_${j.alias}"><option value="inner">inner join</option><option value="left"${sel(spec.joinTypes[j.alias] === 'left')}>left join (keep rows without a match)</option></select>` : ''}</li>`)}</ul>
              <fieldset class="field"><legend class="label">Join two columns</legend><div class="qb-cond">
                <select name="ja" aria-label="Join: column">${colOptions('')}</select><span class="qb-eq">=</span>
                <select name="jb" aria-label="Join: column of another table">${colOptions('')}</select></div></fieldset>
              <div class="buttons"><button class="btn">${icon('check')} Apply</button></div>`)}`
          : ''}
        <div class="u-spacer"></div>
        ${region(`${built.joins.length ? 4 : 3}. Conditions`, html`<fieldset class="field"><legend class="label">Rows must match</legend><div class="radio-group">
            <label class="check"><input type="radio" name="any" value="and"${check(!spec.any)}> all conditions</label>
            <label class="check"><input type="radio" name="any" value="or"${check(spec.any)}> any condition</label></div></fieldset>
          ${wheres.map((w, k) => html`<div class="qb-cond">
            <select name="wc" aria-label="Condition ${k + 1}: column">${colOptions(w.column)}</select>
            <select name="wo" aria-label="Condition ${k + 1}: operator">${Object.entries(OPERATORS).map(([op, label]) => html`<option value="${op}"${sel(op === w.op)}>${op} · ${label}</option>`)}</select>
            <input name="wv" value="${w.value}" aria-label="Condition ${k + 1}: value"></div>`)}
          <div class="buttons"><button class="btn">${icon('plus')} Apply / add a condition</button></div>`)}
        <div class="u-spacer"></div>
        ${region(`${built.joins.length ? 5 : 4}. Sort and limit`, html`${orders.map((o, k) => html`<div class="qb-cond">
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
