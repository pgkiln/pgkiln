import { owner, type Db } from './db.ts';
import { LIMITS } from './blueprint.ts';

// A blueprint from an existing application (sprint 66; APEX 26.1: create a
// blueprint from an application). The application's tables (those its
// regions read: a form's table, the first schema.table after FROM in a
// query) become the blueprint's tables, its pages the blueprint's pages and
// its menu the navigation. The result is a starting point that the developer
// reviews in the blueprint editor: checkBlueprint() checks it like any other,
// and `notes` say what did not carry over.
//
// Only tables the application's database role may read are used (the owner's
// catalog is not a way to see other schemas). Sample rows are read only when
// asked for, at most 20 per table, read only, on the connection the caller
// gives (the builder: devDbForApp, an isolated workspace's developer login).

const NAME = /^[a-z][a-z0-9_]{0,62}$/;
const SAMPLE_ROWS = 20;

interface Col {
  name: string;
  type: string;
  required: boolean;
  unique: boolean;
  values: string[];
  references: string | null;
}
interface Table {
  key: string; // schema.table
  name: string;
  label: string | null;
  hasId: boolean;
  columns: Col[];
}

/** The first schema.table after FROM in a query (lower case, quotes removed), or null. */
export function firstTable(source: string | null | undefined): string | null {
  const m = /\bfrom\s+("?[a-z_][\w$]*"?)\s*\.\s*("?[a-z_][\w$]*"?)/i.exec(source ?? '');
  return m ? `${m[1].replace(/"/g, '').toLowerCase()}.${m[2].replace(/"/g, '').toLowerCase()}` : null;
}

/** The literals of a CHECK (col = ANY (ARRAY['a'::text, …])) or (col IN ('a', …)), or null. */
export function checkValues(def: string): string[] | null {
  const m = /^CHECK \(\(?\(?"?[a-z_][\w$]*"?\)?(?:::text)? = ANY \(\(?ARRAY\[(.*)\]\)?(?:::text\[\])?\)\)\)?$/i.exec(def.trim());
  if (!m) return null;
  const values = [...m[1].matchAll(/'((?:[^']|'')*)'(?:::[a-z ]+)?/gi)].map((x) => x[1].replace(/''/g, "'"));
  return values.length ? values : null;
}

const TYPES: Record<string, string> = {
  int2: 'integer', int4: 'integer', int8: 'integer', numeric: 'number', float4: 'number', float8: 'number', money: 'number',
  date: 'date', timestamp: 'timestamp', timestamptz: 'timestamp', bool: 'boolean', text: 'text', varchar: 'text', bpchar: 'text', citext: 'text',
};

export async function blueprintFromApp(appId: number, opts: { sampleRows?: Db | null } = {}) {
  const db = owner;
  const notes: string[] = [];
  const app = await db.one<{ name: string; alias: string; authentication: string; db_role: string | null }>(
    'select name, alias, authentication, db_role from meta.app where id = $1', [appId]);
  if (!app) throw new Error('No such application.');
  const regions = (await db.query<{ page_no: number; page_name: string; type: string; table_name: string | null; source: string | null; config: any }>(
    `select p.page_no, p.name as page_name, r.type, r.table_name, r.source, r.config
       from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 order by p.page_no, r.seq, r.id`, [appId])).rows;
  const tableOf = (r: (typeof regions)[number]) => (r.table_name ? r.table_name.toLowerCase().replace(/"/g, '') : firstTable(r.source));

  // ---------------------------------------------------------------- tables
  const wanted = [...new Set(regions.map(tableOf).filter((t): t is string => !!t))];
  const readable = (await db.query<{ key: string; oid: number; label: string | null }>(
    `select format('%s.%s', n.nspname, c.relname) as key, c.oid::int, obj_description(c.oid, 'pg_class') as label
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind in ('r', 'p') and format('%s.%s', n.nspname, c.relname) = any($1::text[])
        and ($2::text is null or has_table_privilege($2::text, c.oid, 'SELECT'))
      order by array_position($1::text[], format('%s.%s', n.nspname, c.relname))`, [wanted, app.db_role])).rows;
  const tables: Table[] = [];
  for (const t of readable.slice(0, LIMITS.tables)) {
    const name = t.key.split('.')[1];
    if (!NAME.test(name) || tables.some((x) => x.name === name)) {
      notes.push(`Table ${t.key} is left out: ${NAME.test(name) ? 'another schema has a table with that name' : 'its name is not a-z, 0-9 and _'}.`);
      continue;
    }
    const cols = (await db.query<{ name: string; typname: string; typtype: string; notnull: boolean; has_default: boolean; generated: boolean; pk: boolean; uniq: boolean; enum_values: string[] | null; checks: string[]; fk_table: string | null; fk_col: string | null }>(
      `select a.attname as name, t.typname, t.typtype, a.attnotnull as notnull, a.atthasdef as has_default, a.attgenerated <> '' as generated,
              exists (select 1 from pg_constraint k where k.conrelid = a.attrelid and k.contype = 'p' and k.conkey = array[a.attnum]) as pk,
              exists (select 1 from pg_constraint k where k.conrelid = a.attrelid and k.contype = 'u' and k.conkey = array[a.attnum]) as uniq,
              (select array_agg(e.enumlabel order by e.enumsortorder) from pg_enum e where e.enumtypid = t.oid) as enum_values,
              coalesce((select array_agg(pg_get_constraintdef(k.oid)) from pg_constraint k where k.conrelid = a.attrelid and k.contype = 'c' and k.conkey = array[a.attnum]), '{}') as checks,
              (select format('%s.%s', fn.nspname, fc.relname) from pg_constraint k join pg_class fc on fc.oid = k.confrelid join pg_namespace fn on fn.oid = fc.relnamespace
                where k.conrelid = a.attrelid and k.contype = 'f' and k.conkey = array[a.attnum] limit 1) as fk_table,
              (select fa.attname from pg_constraint k join pg_attribute fa on fa.attrelid = k.confrelid and fa.attnum = k.confkey[1]
                where k.conrelid = a.attrelid and k.contype = 'f' and k.conkey = array[a.attnum] limit 1) as fk_col
         from pg_attribute a join pg_type t on t.oid = a.atttypid
        where a.attrelid = $1 and a.attnum > 0 and not a.attisdropped order by a.attnum`, [t.oid])).rows;
    const table: Table = { key: t.key, name, label: t.label?.split('\n')[0].slice(0, 80) || null, hasId: false, columns: [] };
    for (const c of cols) {
      if (c.name === 'id' && c.pk) {
        table.hasId = true;
        continue;
      }
      if (c.generated) continue;
      if (!NAME.test(c.name) || c.name === 'id') {
        notes.push(`${t.key}.${c.name} is left out: the blueprint gives every table an id, and names are a-z, 0-9 and _.`);
        continue;
      }
      if (table.columns.length >= LIMITS.columns) {
        notes.push(`${t.key}: only the first ${LIMITS.columns} columns are kept.`);
        break;
      }
      if (c.typname === 'bytea') {
        notes.push(`${t.key}.${c.name} is left out: blueprints have no column type for files or binary data.`);
        continue;
      }
      const type = c.typtype === 'e' ? 'text' : TYPES[c.typname];
      if (!type) notes.push(`${t.key}.${c.name} (${c.typname}) becomes text.`);
      if (c.pk) notes.push(`${t.key}'s key is ${c.name}: the blueprint's tables get an id key; ${c.name} stays a required, unique column.`);
      const values = c.enum_values ?? c.checks.map(checkValues).find((v) => v) ?? [];
      table.columns.push({
        name: c.name, type: type ?? 'text', required: c.pk || (c.notnull && !c.has_default), unique: c.pk || c.uniq,
        values: (type ?? 'text') === 'text' ? values.slice(0, LIMITS.values).filter((v) => v && v.length <= 100) : [],
        references: c.fk_table && c.fk_col === 'id' ? c.fk_table : null,
      });
      if (c.fk_table && c.fk_col !== 'id') notes.push(`${t.key}.${c.name} refers to ${c.fk_table}.${c.fk_col}: blueprint references point at an id, so it stays a plain column.`);
    }
    if (!table.columns.length) {
      notes.push(`Table ${t.key} is left out: it has no columns besides its id.`);
      continue;
    }
    tables.push(table);
  }
  // references only to tables of the blueprint (by their name there)
  const byKey = new Map(tables.map((t) => [t.key, t.name]));
  for (const t of tables)
    for (const c of t.columns)
      if (c.references) {
        const target = byKey.get(c.references);
        if (!target) notes.push(`${t.key}.${c.name} refers to ${c.references}, which the application doesn't show: it stays a plain column.`);
        c.references = target ?? null;
        if (!target) c.type = 'integer';
      }
  for (const w of wanted) if (!readable.some((r) => r.key === w)) notes.push(`${w} is left out: not a table the application's role may read.`);

  // ---------------------------------------------------------------- pages
  const PRIORITY = ['grid', 'facets', 'calendar', 'cards', 'map', 'chart', 'report', 'form'];
  const byPage = new Map<number, (typeof regions)>();
  for (const r of regions) byPage.set(r.page_no, [...(byPage.get(r.page_no) ?? []), r]);
  const known = new Set(tables.map((t) => t.key));
  const nameOf = (key: string | null) => (key && known.has(key) ? byKey.get(key)! : null);
  const pages: Record<string, unknown>[] = [];
  const formPages = new Map<string, number>(); // table → the first page with just a form on it
  for (const [no, rs] of byPage) {
    const data = rs.filter((r) => PRIORITY.includes(r.type));
    if (no > 1 && data.length === 1 && data[0].type === 'form' && nameOf(tableOf(data[0])) && !formPages.has(nameOf(tableOf(data[0]))!))
      formPages.set(nameOf(tableOf(data[0]))!, no);
  }
  const consumed = new Set<number>();
  const pageNos = [...byPage.keys()].filter((n) => n >= 2 && n <= 99999).sort((a, b) => a - b);
  const used = new Set<number>([1, ...pageNos]);
  const freeNo = () => {
    let n = Math.max(...used) + 1;
    while (used.has(n)) n++;
    used.add(n);
    return n;
  };
  for (const no of pageNos) {
    if (consumed.has(no) || pages.length >= LIMITS.pages) continue;
    const rs = byPage.get(no)!;
    const label = rs[0].page_name;
    const main = [...rs].filter((r) => PRIORITY.includes(r.type)).sort((a, b) => PRIORITY.indexOf(a.type) - PRIORITY.indexOf(b.type))[0];
    const table = main
      ? nameOf(main.type === 'facets' ? firstTable(rs.find((r) => r.type === 'report')?.source) : tableOf(main))
      : null;
    if (!main || !table) {
      pages.push({ type: 'blank', page: no, label });
      continue;
    }
    if (main.type === 'report') {
      const form = formPages.get(table);
      const formPage = form && form !== no && !consumed.has(form) ? form : freeNo();
      consumed.add(formPage);
      pages.push({ type: 'report_form', table, page: no, form_page: formPage, label });
    } else if (main.type === 'form') {
      if (formPages.get(table) === no && pages.some((p) => p.table === table && p.type === 'report_form')) continue;
      pages.push({ type: 'form', table, page: no, label });
    } else pages.push({ type: main.type, table, page: no, label });
  }
  if (pageNos.length > LIMITS.pages) notes.push(`Only the first ${LIMITS.pages} pages are kept.`);

  // ---------------------------------------------------------------- navigation
  const pageSet = new Set<number>([1, ...pages.flatMap((p) => [p.page as number, ...(p.form_page ? [p.form_page as number] : [])])]);
  const navigation = (await db.query<{ label: string; page: number; icon: string | null }>(
    `select label, target_page as page, icon from meta.nav_entry where app_id = $1 and target_page is not null order by seq, id`, [appId])).rows
    .filter((n) => pageSet.has(n.page) && n.label)
    .slice(0, LIMITS.pages)
    .map((n) => ({ label: n.label.slice(0, 80), page: n.page, ...(n.icon && /^[a-z-]{1,30}$/.test(n.icon) ? { icon: n.icon } : {}) }));

  // ---------------------------------------------------------------- sample rows (asked for only)
  const sample_data: { table: string; columns: string[]; rows: unknown[][] }[] = [];
  if (opts.sampleRows) {
    for (const t of tables) {
      const columns = [...(t.hasId ? ['id'] : []), ...t.columns.map((c) => c.name)];
      const [schema, rel] = t.key.split('.');
      const res = await opts.sampleRows.tx(async (c) => {
        await c.query('set transaction read only');
        await c.query(`set local statement_timeout = '10s'`);
        return c.query({ text: `select ${columns.map((x) => `"${x}"`).join(', ')} from "${schema}"."${rel}" ${t.hasId ? 'order by id' : ''} limit ${SAMPLE_ROWS}`, rowMode: 'array' });
      }).catch((e: Error) => {
        notes.push(`No sample rows from ${t.key}: ${e.message}`);
        return null;
      });
      if (!res?.rows.length) continue;
      sample_data.push({
        table: t.name, columns,
        rows: res.rows.map((row: unknown[]) => row.map((v) =>
          v === null || typeof v === 'boolean' || typeof v === 'number' ? v
            : v instanceof Date ? v.toISOString()
            : typeof v === 'object' ? JSON.stringify(v).slice(0, 2000)
            : String(v).slice(0, 2000))),
      });
    }
  }

  const alias = `${app.alias}-copy`.slice(0, 50);
  const spec = {
    blueprint: 1,
    name: `${app.name} (copy)`.slice(0, 100),
    alias,
    schema: alias.replace(/-/g, '_'),
    authentication: app.authentication === 'none' ? 'none' : 'app_users',
    tables: tables.map((t) => ({
      name: t.name, ...(t.label ? { label: t.label } : {}),
      columns: t.columns.map((c) => ({
        name: c.name, ...(c.references ? { references: c.references } : { type: c.type }),
        ...(c.required ? { required: true } : {}), ...(c.unique ? { unique: true } : {}), ...(c.values.length ? { values: c.values } : {}),
      })),
    })),
    pages,
    ...(navigation.length ? { navigation } : {}),
    ...(sample_data.length ? { sample_data } : {}),
  };
  return { spec, notes };
}
