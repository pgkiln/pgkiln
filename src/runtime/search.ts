// Search region and search configurations (APEX 22.2: the Search region and
// Shared Components → Search Configurations), migration 080.
//
// A search region searches the configurations it names (all of the
// application's when it names none) with one search field, or with a page
// item's value ({"item": "P1_SEARCH"}), and shows the results grouped per
// configuration, the matched words marked. Each configuration searches:
//
//  - table: a table or view, its columns quoted as identifiers;
//  - sql:   a SELECT (binds allowed), wrapped as a subquery;
//  - list:  the entries of a list (Shared Components → Lists) the user may see.
//
// Search type standard: every word of the search text must be found in one
// of the searchable columns (ILIKE, % and _ escaped, the text as a query
// parameter). Search type fulltext (135): the source's tsvector matched
// with websearch_to_tsquery (quotes, or, -word), the best match first
// (ts_rank_cd), title, subtitle and description highlighted by ts_headline
// (between private-use markers that only then become <mark>, everything
// else escaped); the text search configuration is checked against
// pg_ts_config and passed as a parameter. With pg_trgm installed, a
// configuration may suggest the closest words when nothing is found. Search
// type vector (136): the search text embedded by the configuration's vector
// provider (src/ai/embeddings.ts), the rows nearest by the vector column
// (pgvector's cosine, L2 or inner product distance, operators
// schema-qualified, the vector a query parameter), at least the minimum
// similarity. Search type hybrid (136): the full-text and the vector
// rankings merged by reciprocal rank fusion (1 / (60 + rank), summed per
// key). Without pgvector both say what is missing. The
// queries run as the application's role in the page's transaction, each in a
// savepoint, so one configuration that fails shows its error and the others
// still answer. Without JavaScript the field is a GET form; app.js searches
// as the user types (the region endpoint, see routes.ts).
import pg from 'pg';
import { applyBinds } from '../binds.ts';
import { runtime, savepoint } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import { icon } from '../icons.ts';
import type { Region } from '../metadata.ts';
import { embedQuery, vectorLiteral, vectorProviderFor } from '../ai/embeddings.ts';
import { DISTANCES, distanceSql, isDistance, PGVECTOR_MISSING, vectorSchema, type Distance } from '../vector.ts';
import { bindValues, dbg, publicError, stripSemicolon, type PageContext } from './context.ts';
import { fillItems, linkAttrs } from './links.ts';
import { listTree, type ListNode } from './lists.ts';

const ident = pg.escapeIdentifier;

export interface SearchConfig {
  name: string;
  label: string;
  seq: number;
  source_type: 'table' | 'sql' | 'list';
  source: string;
  searchable_columns: string[];
  title_column: string | null;
  subtitle_column: string | null;
  description_column: string | null;
  badge_column: string | null;
  icon: string | null;
  link: { page?: number; items?: Record<string, string> } | null;
  max_results: number;
  /** (135) standard: ILIKE per word · fulltext: PostgreSQL full-text search · (136) vector, hybrid */
  search_type?: (typeof SEARCH_TYPES)[number];
  /** (135) fulltext: a tsvector column or expression; empty: to_tsvector over the searchable columns */
  fts_vector?: string | null;
  /** (135) fulltext: the text search configuration; empty: the application language's */
  fts_config?: string | null;
  /** (135) with pg_trgm: suggest the closest words when nothing is found */
  did_you_mean?: boolean;
  /** (136) vector, hybrid: the vector provider (static ID) that embeds the search text */
  vector_provider?: string | null;
  /** (136) vector, hybrid: the source's vector column */
  vector_column?: string | null;
  /** (136) hybrid: the key that matches the full-text and the vector results */
  key_column?: string | null;
  /** (136) vector, hybrid: cosine, l2 or inner_product */
  distance?: Distance;
  /** (136) vector, hybrid: at least this similarity */
  min_similarity?: number | null;
}

export interface SearchRegionConfig {
  configs?: string[];
  item?: string;
  placeholder?: string;
  min_length?: number;
  empty?: string;
}

/** At most this many words of the search text count. */
const MAX_WORDS = 8;
const MAX_TEXT = 200;
const COLUMN = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/;
const TABLE = /^([A-Za-z_][A-Za-z0-9_$]{0,62}\.)?[A-Za-z_][A-Za-z0-9_$]{0,62}$/;

/** A client, a pool or pgkiln's Db: something that runs a query with parameters. */
type Queryable = { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> };

/** (135) The search types; (136) vector and hybrid. */
export const SEARCH_TYPES = ['standard', 'fulltext', 'vector', 'hybrid'] as const;
/** (136) Rows each ranking of a hybrid search contributes, and reciprocal rank fusion's constant. */
const HYBRID_DEPTH = 50;
const RRF_K = 60;
const TS_CONFIG = /^[a-z_][a-z0-9_]{0,62}$/;

/** (135) The text search configuration of a language: pgkiln's languages that PostgreSQL has a stemmer for. */
const TS_BY_LANGUAGE: Record<string, string> = {
  ar: 'arabic', ca: 'catalan', da: 'danish', de: 'german', el: 'greek', en: 'english', es: 'spanish', eu: 'basque', fi: 'finnish',
  fr: 'french', ga: 'irish', hi: 'hindi', hu: 'hungarian', hy: 'armenian', id: 'indonesian', it: 'italian', lt: 'lithuanian',
  nb: 'norwegian', ne: 'nepali', nl: 'dutch', nn: 'norwegian', no: 'norwegian', pt: 'portuguese', ro: 'romanian', ru: 'russian',
  sr: 'serbian', sv: 'swedish', ta: 'tamil', tr: 'turkish', yi: 'yiddish',
};
export const tsConfigFor = (language: string | null | undefined) => TS_BY_LANGUAGE[String(language ?? '').toLowerCase().split(/[-_]/)[0]] ?? 'simple';

/**
 * (135) The text search configuration to use: the one asked for, else the language's, if it exists in
 * pg_ts_config; else simple. Only a name that exists is returned (and it is still passed as a parameter).
 */
export async function textSearchConfig(db: Queryable, wanted: string | null | undefined, language: string | null | undefined): Promise<string> {
  const names = [wanted, tsConfigFor(language)].filter((x): x is string => !!x && TS_CONFIG.test(x));
  if (!names.length) return 'simple';
  const found = (await db.query('select cfgname from pg_catalog.pg_ts_config where cfgname = any($1::text[])', [names])).rows.map((r: { cfgname: string }) => r.cfgname);
  return names.find((n) => found.includes(n)) ?? 'simple';
}

/** (135) The schema of pg_trgm when it is installed (its functions are called schema-qualified), else null. */
export async function trigramSchema(db: Queryable): Promise<string | null> {
  return (await db.query(`select n.nspname as s from pg_catalog.pg_extension e join pg_catalog.pg_namespace n on n.oid = e.extnamespace where e.extname = 'pg_trgm'`)).rows[0]?.s ?? null;
}

/** (135) The markers ts_headline puts around a matched word (private-use characters, removed from the text first). */
export const HL_START = '\uE000';
export const HL_STOP = '\uE001';

/** (135) A ts_headline result as HTML: everything escaped, only the text between the markers in <mark>. */
export function headlined(value: string): Raw {
  const parts: Raw[] = [];
  let last = 0;
  for (const m of value.matchAll(/\uE000([^\uE000\uE001]*)\uE001/g)) {
    parts.push(html`${value.slice(last, m.index).replace(/[\uE000\uE001]/g, '')}${m[1] ? html`<mark>${m[1]}</mark>` : ''}`);
    last = m.index! + m[0].length;
  }
  parts.push(html`${value.slice(last).replace(/[\uE000\uE001]/g, '')}`);
  return html`${parts}`;
}

/** The columns a configuration names (for the Advisor's check of its source). */
export const configColumns = (c: Pick<SearchConfig, 'title_column' | 'subtitle_column' | 'description_column' | 'badge_column' | 'searchable_columns' | 'icon'>) =>
  [...new Set([c.title_column, c.subtitle_column, c.description_column, c.badge_column, ...(c.searchable_columns ?? []), /^#(.+)#$/.exec(c.icon ?? '')?.[1]]
    .filter((x): x is string => !!x && COLUMN.test(x)))];

/** The words of a search text (at most MAX_WORDS, each once, case kept). */
export function searchWords(text: string | null | undefined) {
  const words = (text ?? '').slice(0, MAX_TEXT).split(/\s+/).map((w) => w.trim()).filter(Boolean);
  return [...new Map(words.map((w) => [w.toLowerCase(), w])).values()].slice(0, MAX_WORDS);
}

/** A word as an ILIKE pattern that matches it anywhere, literally. */
export const likePattern = (word: string) => `%${word.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** The parameter of the region's own search field. */
export const searchParam = (r: Region) => `s${r.id}`;

/** Problems of a configuration (the builder shows them; the runtime refuses the configuration). */
export function searchConfigProblems(c: Partial<SearchConfig>): string[] {
  const out: string[] = [];
  const cols = [c.title_column, c.subtitle_column, c.description_column, c.badge_column, ...(c.searchable_columns ?? [])].filter((x): x is string => !!x);
  if (c.source_type !== 'list') {
    for (const col of cols) if (!COLUMN.test(col)) out.push(`"${col}" is not a column name.`);
    if (!c.title_column) out.push('Choose the column that is the title of each result.');
  }
  if (c.source_type === 'sql' && !/^\s*(select|with)\b/i.test(c.source ?? '')) out.push('The source of an SQL query configuration is a SELECT.');
  if (c.source_type === 'table' && !TABLE.test((c.source ?? '').trim())) out.push('The source of a table configuration is a table or view name, e.g. sales.customers.');
  if (c.icon && !/^(#[A-Za-z_][A-Za-z0-9_$]*#|[a-z0-9-]{1,40})$/.test(c.icon)) out.push('The icon is an icon name, or #COLUMN# for a column that holds icon names.');
  if (c.link && (typeof c.link !== 'object' || !Number.isInteger(c.link.page))) out.push('The link is {"page": 3, "items": {"P3_ID": "#ID#"}}.');
  if (c.search_type && !SEARCH_TYPES.includes(c.search_type)) out.push(`The search type is one of ${SEARCH_TYPES.join(', ')}.`);
  if (c.search_type === 'fulltext') {
    if (c.source_type === 'list') out.push('Full-text search needs a table or SQL source.');
    if (c.fts_config && !TS_CONFIG.test(c.fts_config)) out.push('The text search configuration is a name, e.g. english, dutch or simple.');
    if (c.fts_vector && /;|--|\/\*/.test(c.fts_vector)) out.push('The tsvector is one column or expression (no ; or comments).');
  }
  if (c.search_type === 'vector' || c.search_type === 'hybrid') {
    if (c.source_type === 'list') out.push('Vector search needs a table or SQL source.');
    if (!c.vector_provider || !/^[A-Z][A-Z0-9_]{0,59}$/.test(c.vector_provider)) out.push('Choose the vector provider that embeds the search text.');
    if (!c.vector_column || !COLUMN.test(c.vector_column)) out.push('Name the vector column of the source (e.g. embedding).');
    if (c.distance !== undefined && c.distance !== null && !isDistance(c.distance)) out.push('The distance is cosine, l2 or inner_product.');
    if (c.min_similarity !== undefined && c.min_similarity !== null && !(Number.isFinite(Number(c.min_similarity)) && Number(c.min_similarity) >= -1 && Number(c.min_similarity) <= 1))
      out.push('The minimum similarity is a number from -1 to 1 (empty: none).');
  }
  if (c.search_type === 'hybrid') {
    if (!c.key_column || !COLUMN.test(c.key_column)) out.push('A hybrid search needs the key column that matches full-text and vector results (e.g. id).');
    if (c.fts_config && !TS_CONFIG.test(c.fts_config)) out.push('The text search configuration is a name, e.g. english, dutch or simple.');
    if (c.fts_vector && /;|--|\/\*/.test(c.fts_vector)) out.push('The tsvector is one column or expression (no ; or comments).');
  }
  if (c.key_column && !COLUMN.test(c.key_column)) out.push(`"${c.key_column}" is not a column name.`);
  return out;
}

/** The configurations a region searches, in sequence order (components of an excluded build option left out). */
async function configsOf(ctx: PageContext, r: Region): Promise<SearchConfig[]> {
  const conf = (r.config ?? {}) as SearchRegionConfig;
  const names = Array.isArray(conf.configs) ? conf.configs.map((n) => String(n).toUpperCase()) : [];
  return (
    await runtime.query<SearchConfig>(
      `select name, label, seq, source_type, source, searchable_columns, title_column, subtitle_column, description_column,
              badge_column, icon, link, max_results,
              search_type, fts_vector, fts_config, did_you_mean,
              vector_provider, vector_column, key_column, distance, min_similarity
         from meta.search_config
        where app_id = $1 and meta.build_option_on(app_id, build_option) and (cardinality($2::text[]) = 0 or name = any($2))
        order by seq, name`,
      [ctx.app.id, names],
    )
  ).rows;
}

interface Hit {
  title: string;
  subtitle: string | null;
  description: string | null;
  badge: string | null;
  icon: string | null;
  href: Raw | null;
  /** (135) full-text search: title, subtitle and description as highlighted by ts_headline */
  headlines?: { title: Raw; subtitle: Raw | null; description: Raw | null };
  /** (136) vector: the similarity; hybrid: the fused score */
  score?: number;
}

const text = (v: unknown) => (v === null || v === undefined ? null : typeof v === 'object' ? JSON.stringify(v) : String(v));

/** A row's value of a column, case-insensitively. */
function col(row: Record<string, unknown>, name: string | null) {
  if (!name) return null;
  const key = Object.keys(row).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? null : text(row[key]);
}

/** The columns a configuration searches: its searchable columns, else title, subtitle and description. */
const searchedColumns = (c: SearchConfig) =>
  (c.searchable_columns.length ? c.searchable_columns : [c.title_column, c.subtitle_column, c.description_column]).filter((x): x is string => !!x);

/** The FROM of a table or SQL configuration (the source as `t`). */
async function sourceFrom(ctx: PageContext, c: SearchConfig) {
  if (c.source_type === 'table') {
    const table = (await ctx.client!.query('select $1::regclass::text as t', [c.source])).rows[0].t as string;
    return `${table} t`;
  }
  return `(${stripSemicolon(applyBinds(c.source, bindValues(ctx)))}) t`;
}

/**
 * (135) The tsvector of a full-text configuration as SQL over `t`: its column, its expression, or to_tsvector
 * over the searchable columns (`cfg` is the placeholder of the text search configuration).
 */
export function tsvectorSql(c: Pick<SearchConfig, 'fts_vector' | 'searchable_columns' | 'title_column' | 'subtitle_column' | 'description_column'>, cfg: string) {
  const v = (c.fts_vector ?? '').trim();
  if (v) return COLUMN.test(v) ? `t.${ident(v)}` : `(${v})`;
  const cols = searchedColumns(c as SearchConfig);
  return `to_tsvector(${cfg}, ${cols.map((x) => `coalesce(t.${ident(x)}::text, '')`).join(` || ' ' || `) || `''`})`;
}

/** One configuration's results on a table or a query: up to max_results, and whether there are more. */
async function searchRows(ctx: PageContext, c: SearchConfig, words: string[], query: string): Promise<{ hits: Hit[]; more: boolean }> {
  const from = await sourceFrom(ctx, c);
  let rows: Record<string, unknown>[];
  const fulltext = c.search_type === 'fulltext';
  if (c.search_type === 'vector' || c.search_type === 'hybrid') {
    rows = await vectorRows(ctx, c, from, query);
  } else if (fulltext) {
    // $1 the text search configuration (a name from pg_ts_config), $2 the user's text, $3 the headline options,
    // $4 the marker characters (taken out of the values first, so only ts_headline's markers become markup)
    const cfg = await textSearchConfig(ctx.client!, c.fts_config, ctx.app.language);
    const vec = tsvectorSql(c, '$1::regconfig');
    const hl = (column: string | null, alias: string, options: string) =>
      column ? `, ts_headline($1::regconfig, translate(s.${ident(column)}::text, $4, ''), "pgkiln$q".query, ${options}) as "pgkiln$${alias}"` : '';
    const sql = `select s.*${hl(c.title_column, 'title', '$3::text || \', HighlightAll=true\'')}${hl(c.subtitle_column, 'subtitle', '$3::text || \', HighlightAll=true\'')}${hl(c.description_column, 'description', '$3::text || \', MaxWords=35, MinWords=15, MaxFragments=2, FragmentDelimiter=" … "\'')}
      from (select t.*, ts_rank_cd(${vec}, "pgkiln$q".query) as "pgkiln$rank"
              from ${from}, websearch_to_tsquery($1::regconfig, $2) "pgkiln$q"(query)
             where ${vec} @@ "pgkiln$q".query
             order by "pgkiln$rank" desc${c.title_column ? `, t.${ident(c.title_column)}` : ''}
             limit ${c.max_results + 1}) s, websearch_to_tsquery($1::regconfig, $2) "pgkiln$q"(query)
      order by s."pgkiln$rank" desc${c.title_column ? `, s.${ident(c.title_column)}` : ''}`;
    rows = (await ctx.client!.query(sql, [cfg, query, `StartSel="${HL_START}", StopSel="${HL_STOP}"`, HL_START + HL_STOP])).rows;
  } else {
    const searched = searchedColumns(c);
    const conditions = words.map((_, i) => `(${searched.map((s) => `t.${ident(s)}::text ilike $${i + 1} escape '\\'`).join(' or ')})`);
    const sql = `select t.* from ${from} where ${conditions.join(' and ') || 'true'}${c.title_column ? ` order by t.${ident(c.title_column)}` : ''} limit ${c.max_results + 1}`;
    rows = (await ctx.client!.query(sql, words.map(likePattern))).rows;
  }
  const iconCol = /^#(.+)#$/.exec(c.icon ?? '')?.[1] ?? null;
  const h = (row: Record<string, unknown>, alias: string) => (typeof row[`pgkiln$${alias}`] === 'string' ? headlined(row[`pgkiln$${alias}`] as string) : null);
  return {
    more: rows.length > c.max_results,
    hits: rows.slice(0, c.max_results).map((row) => ({
      title: col(row, c.title_column) ?? '',
      subtitle: col(row, c.subtitle_column),
      description: col(row, c.description_column),
      badge: col(row, c.badge_column),
      icon: iconCol ? col(row, iconCol) : c.icon,
      href:
        c.link && Number.isInteger(c.link.page)
          ? linkAttrs(ctx, c.link.page!, fillItems(c.link.items, (name) => col(row, name) ?? undefined))
          : null,
      ...(fulltext ? { headlines: { title: h(row, 'title') ?? html`${col(row, c.title_column) ?? ''}`, subtitle: h(row, 'subtitle'), description: h(row, 'description') } } : {}),
      ...(typeof row['pgkiln$score'] === 'number' ? { score: Math.round((row['pgkiln$score'] as number) * 10_000) / 10_000 } : {}),
    })),
  };
}

/**
 * (136) A vector or hybrid configuration's rows (up to max_results + 1), best first, each with "pgkiln$score"
 * (vector: the similarity; hybrid: the fused score). Runs on ctx.client: the application's role, through RLS.
 */
async function vectorRows(ctx: PageContext, c: SearchConfig, from: string, query: string): Promise<Record<string, unknown>[]> {
  const client = ctx.client!;
  const schema = await vectorSchema(client);
  if (!schema) throw new Error(PGVECTOR_MISSING);
  const provider = await vectorProviderFor(ctx.app.id, c.vector_provider!);
  const vector = await embedQuery(provider, query, { appId: ctx.app.id, pageNo: ctx.page?.page_no ?? null, user: ctx.user, debug: (l, x) => dbg(ctx, l, 'search', x) }, client);
  const distance: Distance = isDistance(c.distance) ? c.distance : 'cosine';
  const vcol = `t.${ident(c.vector_column!)}`;
  const d = distanceSql(schema, distance, vcol, `$1::text::${ident(schema)}.vector`);
  const minSim = c.min_similarity === null || c.min_similarity === undefined ? null : Number(c.min_similarity);
  const sim = DISTANCES[distance].similarity;
  if (c.search_type === 'vector') {
    // the nearest rows (an HNSW index serves "order by distance limit n"), then those similar enough
    const sql = `select s.*, ${sim('s."pgkiln$distance"')}::float8 as "pgkiln$score"
      from (select t.*, ${d} as "pgkiln$distance" from ${from} where ${vcol} is not null order by ${d} limit ${c.max_results + 1}) s
      where $2::float8 is null or ${sim('s."pgkiln$distance"')} >= $2::float8
      order by s."pgkiln$distance"`;
    return (await client.query(sql, [vectorLiteral(vector), minSim])).rows;
  }
  // hybrid: each ranking's best HYBRID_DEPTH rows, fused by reciprocal rank (1 / (60 + rank)) per key
  const cfg = await textSearchConfig(client, c.fts_config, ctx.app.language);
  const vec = tsvectorSql(c, '$3::regconfig');
  const key = ident(c.key_column!);
  const sql = `with v as (select k, row_number() over (order by dist) as r
                  from (select t.${key} as k, ${d} as dist from ${from} where ${vcol} is not null order by ${d} limit ${HYBRID_DEPTH}) x
                 where $2::float8 is null or ${sim('dist')} >= $2::float8),
       f as (select k, row_number() over (order by rank desc) as r
               from (select t.${key} as k, ts_rank_cd(${vec}, q.query) as rank from ${from}, websearch_to_tsquery($3::regconfig, $4) q(query)
                      where ${vec} @@ q.query order by 2 desc limit ${HYBRID_DEPTH}) y),
       s as (select k, sum(1.0 / (${RRF_K} + r))::float8 as score from (select k, r from v union all select k, r from f) z group by k)
    select t.*, s.score as "pgkiln$score" from ${from} join s on s.k = t.${key}
     order by s.score desc${c.title_column ? `, t.${ident(c.title_column)}` : ''} limit ${c.max_results + 1}`;
  return (await client.query(sql, [vectorLiteral(vector), minSim, cfg, query])).rows;
}

/**
 * (136) The Retrieve tool of an AI agent: a table or SQL configuration's best rows for a text, as the application's
 * role (ctx.client, in the caller's read-only transaction): title, subtitle, description and badge, and the score.
 */
export async function retrieve(ctx: PageContext, name: string, query: string, max: number) {
  const c = (await ctx.client!.query<SearchConfig>(
    `select name, label, seq, source_type, source, searchable_columns, title_column, subtitle_column, description_column,
            badge_column, icon, link, max_results, search_type, fts_vector, fts_config, did_you_mean,
            vector_provider, vector_column, key_column, distance, min_similarity
       from meta.search_config where app_id = $1 and name = $2 and meta.build_option_on(app_id, build_option)`, [ctx.app.id, name.toUpperCase()])).rows[0];
  if (!c) throw new Error(`There is no search configuration ${name.toUpperCase()}.`);
  if (c.source_type === 'list') throw new Error(`Search configuration ${c.name} searches a list: a Retrieve tool needs a table or SQL source.`);
  const problems = searchConfigProblems(c);
  if (problems.length) throw new Error(`Search configuration ${c.name}: ${problems.join(' ')}`);
  const { hits, more } = await searchRows(ctx, { ...c, max_results: max }, searchWords(query), query.slice(0, MAX_TEXT).trim());
  return {
    rows: hits.map((h) => ({ title: h.title, ...(h.subtitle ? { subtitle: h.subtitle } : {}), ...(h.description ? { text: h.description } : {}), ...(h.badge ? { badge: h.badge } : {}), ...(h.score !== undefined ? { score: h.score } : {}) })),
    ...(more ? { more_rows: true } : {}),
  };
}

/**
 * (135) "Did you mean": with pg_trgm installed, each search word that is not a word of the configuration's
 * searched columns replaced by the most similar one (similarity 0.3 or more), from the first 10,000 rows of the
 * source. Null when there is nothing better to suggest.
 */
async function suggestion(ctx: PageContext, c: SearchConfig, words: string[], trgm: string): Promise<string | null> {
  const cols = searchedColumns(c);
  if (!cols.length || !words.length) return null;
  const sim = `${ident(trgm)}.similarity`;
  const res = await ctx.client!.query<{ word: string; best: string | null; known: boolean }>(
    `with v as (select distinct w from (select concat_ws(' ', ${cols.map((x) => `t.${ident(x)}::text`).join(', ')}) as doc from ${await sourceFrom(ctx, c)} limit 10000) d,
                regexp_split_to_table(lower(d.doc), '[^[:alnum:]]+') w where length(w) between 2 and 40)
     select u.word, exists (select from v where v.w = lower(u.word)) as known,
            (select v.w from v where ${sim}(v.w, lower(u.word)) >= 0.3 order by ${sim}(v.w, lower(u.word)) desc, v.w limit 1) as best
       from unnest($1::text[]) with ordinality u(word, n) order by u.n`,
    [words],
  );
  let changed = false;
  const out = res.rows.map((r) => {
    if (r.known || !r.best) return r.word;
    changed = true;
    return r.best;
  });
  return changed ? out.join(' ') : null;
}

/** One configuration's results on a list: the entries (and their children) the user may see. */
async function searchList(ctx: PageContext, c: SearchConfig, words: string[]): Promise<{ hits: Hit[]; more: boolean }> {
  const nodes = (await listTree(ctx, c.source)) ?? [];
  const flat: ListNode[] = [];
  const walk = (ns: ListNode[]) => ns.forEach((n) => (flat.push(n), walk(n.children)));
  walk(nodes);
  const found = flat.filter((n) => n.href && words.every((w) => `${n.label} ${n.description ?? ''}`.toLowerCase().includes(w.toLowerCase())));
  return {
    more: found.length > c.max_results,
    hits: found.slice(0, c.max_results).map((n) => ({
      title: n.label,
      subtitle: null,
      description: n.description,
      badge: n.badge,
      icon: n.icon ?? c.icon,
      href: html`href="${n.href}"${n.external ? raw(' rel="noopener noreferrer"') : ''}${n.modal ? raw(' data-dialog') : ''}`,
    })),
  };
}

/** The text with the search words marked (<mark>), escaped. */
export function marked(value: string, words: string[]): Raw {
  if (!words.length || !value) return html`${value}`;
  const re = new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).sort((a, b) => b.length - a.length).join('|'), 'gi');
  const parts: Raw[] = [];
  let last = 0;
  for (const m of value.matchAll(re)) {
    if (!m[0]) continue;
    parts.push(html`${value.slice(last, m.index)}<mark>${m[0]}</mark>`);
    last = m.index! + m[0].length;
  }
  parts.push(html`${value.slice(last)}`);
  return html`${parts}`;
}

/** The search text of a region: its page item's value, or its own field's. */
export function searchText(ctx: PageContext, r: Region) {
  const conf = (r.config ?? {}) as SearchRegionConfig;
  const item = typeof conf.item === 'string' ? conf.item.toUpperCase() : null;
  return ((item ? ctx.session.state[item] : ctx.params.get(searchParam(r))) ?? '').slice(0, MAX_TEXT);
}

/** The results part of a search region (also what app.js swaps in while the user types). */
async function searchResults(ctx: PageContext, r: Region, query: string): Promise<Raw> {
  const conf = (r.config ?? {}) as SearchRegionConfig;
  const words = searchWords(query);
  const minLength = Number.isInteger(conf.min_length) && conf.min_length! > 0 ? conf.min_length! : 1;
  if (!words.length || query.trim().length < minLength) return html``;
  const groups: Raw[] = [];
  const configs = await configsOf(ctx, r);
  for (const c of configs) {
    let body: Raw;
    try {
      const problems = searchConfigProblems(c);
      if (problems.length) throw new Error(`Search configuration ${c.name}: ${problems.join(' ')}`);
      const { hits, more } = await savepoint(ctx.client!, () => (c.source_type === 'list' ? searchList(ctx, c, words) : searchRows(ctx, c, words, query.trim())));
      if (!hits.length) continue;
      body = html`<ul class="search-hits">${hits.map((h) => {
        // (135) full-text results: ts_headline's highlights (stemmed words: "running" marks "run"); else the words
        const title = h.headlines?.title ?? marked(h.title, words);
        const subtitle = h.subtitle ? (h.headlines?.subtitle ?? marked(h.subtitle, words)) : null;
        const description = h.description ? (h.headlines?.description ?? marked(h.description, words)) : null;
        const inner = html`${h.icon ? html`<span class="search-icon">${icon(h.icon)}</span>` : ''}
          <span class="search-text"><span class="search-title">${title}</span>${
            subtitle ? html`<span class="search-subtitle">${subtitle}</span>` : ''}${
            description ? html`<span class="search-description">${description}</span>` : ''}</span>
          ${h.badge ? html`<span class="badge-pill">${marked(h.badge, words)}</span>` : ''}`;
        return html`<li>${h.href ? html`<a class="search-hit" ${h.href}>${inner}</a>` : html`<div class="search-hit">${inner}</div>`}</li>`;
      })}</ul>${more ? html`<p class="muted search-more">${ctx.locale.t('region.first_rows', { n: String(c.max_results) })}</p>` : ''}`;
    } catch (e) {
      body = html`<div class="alert alert-error" role="alert">${await publicError(ctx, e, `search configuration ${c.name}`)}</div>`;
    }
    // the label is translated like the page's own texts (Shared Components → Globalization)
    groups.push(html`<section class="search-group"><h3>${ctx.locale.tr(c.label)}</h3>${body}</section>`);
  }
  // (a configuration that failed shows its error as a group of its own)
  if (groups.length) return html`${groups}`;
  return html`<p class="muted search-empty">${conf.empty ?? ctx.locale.t('lov.no_rows')}</p>${await didYouMean(ctx, r, configs, words)}`;
}

/** (135) Nothing found: the first suggestion of a configuration that asks for one (pg_trgm installed), as a link. */
async function didYouMean(ctx: PageContext, r: Region, configs: SearchConfig[], words: string[]): Promise<Raw | ''> {
  const asking = configs.filter((c) => c.did_you_mean && c.source_type !== 'list' && !searchConfigProblems(c).length);
  if (!asking.length) return '';
  const trgm = await trigramSchema(ctx.client!);
  if (!trgm) return '';
  for (const c of asking) {
    // a configuration that fails here suggests nothing (its error was shown, or there was none to show)
    const s = await savepoint(ctx.client!, () => suggestion(ctx, c, words, trgm)).catch(() => null);
    if (!s) continue;
    const conf = (r.config ?? {}) as SearchRegionConfig;
    const label = ctx.locale.t('search.did_you_mean');
    // the region's own field: a link that searches for the suggestion; a page item: the words only
    if (typeof conf.item === 'string' && conf.item) return html`<p class="muted search-suggestion">${label} <b>${s}</b></p>`;
    const params = new URLSearchParams([...ctx.params].filter(([k]) => k !== searchParam(r)));
    params.set(searchParam(r), s);
    return html`<p class="muted search-suggestion">${label} <a href="${ctx.base}/${ctx.page.page_no}?${params}">${s}</a></p>`;
  }
  return '';
}

export async function renderSearch(ctx: PageContext, r: Region): Promise<Raw> {
  const conf = (r.config ?? {}) as SearchRegionConfig;
  const t = ctx.locale.t;
  const query = searchText(ctx, r);
  const results = html`<div class="search-results" id="R${r.id}_results" aria-live="polite">${await searchResults(ctx, r, query)}</div>`;
  if (typeof conf.item === 'string' && conf.item) return results;
  // its own field: a GET form that keeps the page's other parameters (item values with their checksum)
  const param = searchParam(r);
  const keep = [...ctx.params].filter(([k]) => k !== param);
  const fieldId = `R${r.id}_q`;
  return html`<form method="get" action="${ctx.base}/${ctx.page.page_no}" class="search-form" role="search">
      ${keep.map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}
      <label class="label" for="${fieldId}">${t('report.search')}</label>
      <div class="input-with-button">
        <input type="search" id="${fieldId}" name="${param}" value="${query}" maxlength="${MAX_TEXT}" autocomplete="off"
          placeholder="${conf.placeholder ?? t('report.search_placeholder')}" data-search-region="${r.id}">
        <button class="btn">${icon('search')} ${t('report.search')}</button>
      </div>
    </form>
    ${results}`;
}
