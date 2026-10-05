import type { FastifyRequest } from 'fastify';
import { runtime } from '../db.ts';
import { baseLanguage, fromAcceptLanguage, RTL, translator, type Translate } from '../i18n.ts';
import type { App, Page } from '../metadata.ts';
import type { Session } from '../session.ts';
import { numberSymbols, type NumberSymbols } from '../numformat.ts';
import { dateFormatter, maskedFormatter, type Formatter } from './format.ts';

// The language, texts and theme of a request (APEX: globalization and
// theme styles). Language: ?lang= for the session, then the user's choice,
// then the browser (when the app derives it from there), then the primary
// language. Theme: the user's choice when the app allows it, else the app's.

export type ThemeMode = 'auto' | 'light' | 'dark';

export interface Locale {
  lang: string;
  dir: 'ltr' | 'rtl';
  /** pgapex's own texts, overridable by text messages */
  t: Translate;
  /** translate an application text (label, title, heading, message) */
  tr: (text: string) => string;
  /** the app's text messages in this language (for &APP_TEXT$NAME.) */
  messages: Record<string, string>;
  languages: string[];
  theme: ThemeMode;
  /** whether users may pick light/dark themselves */
  themeChoice: boolean;
  /** dates and timestamps for display (undefined: not a date) */
  format: Formatter;
  number: Intl.NumberFormat;
  /** separators and currency for number format masks */
  numbers: NumberSymbols;
  /** a formatter with a column's or item's format mask (number or date mask; empty: `format`) */
  masked: (mask: string | null | undefined) => Formatter;
  /** the time zone the app's queries run in (SET LOCAL timezone); null: the database's */
  timeZone: string | null;
  /** where the time zone came from */
  timeZoneFrom: 'user' | 'browser' | 'app' | 'database';
}

export const THEME_COOKIE = 'pgapex_theme';
const THEMES: ThemeMode[] = ['auto', 'light', 'dark'];
export const isTheme = (v: unknown): v is ThemeMode => THEMES.includes(v as ThemeMode);

export const appLanguages = (app: App) => [...new Set([app.language, ...(app.languages ?? [])])];

/** Pick an available language matching a wanted one (exact, then base language). */
export function matchLanguage(wanted: string | null | undefined, available: string[]) {
  if (!wanted) return undefined;
  const w = wanted.toLowerCase();
  return available.find((a) => a.toLowerCase() === w) ?? available.find((a) => baseLanguage(a) === baseLanguage(w));
}

// Text messages and translations change rarely; keep them for a few seconds.
const TTL = 10_000;
const cache = new Map<string, { at: number; messages: Record<string, string>; dict: Map<string, string> }>();

export function clearLocaleCache(appId?: number) {
  for (const k of cache.keys()) if (appId === undefined || k.startsWith(`${appId}:`)) cache.delete(k);
}

async function texts(app: App, lang: string) {
  const key = `${app.id}:${lang}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit;
  const base = baseLanguage(lang);
  const [msgs, trans] = await Promise.all([
    runtime.query<{ name: string; language: string; text: string }>(
      'select name, language, text from meta.text_message where app_id = $1 and language = any($2)',
      [app.id, [...new Set([app.language, base, lang])]],
    ),
    lang === app.language
      ? Promise.resolve({ rows: [] as { source: string; target: string }[] })
      : runtime.query<{ source: string; target: string }>('select source, target from meta.translation where app_id = $1 and language = $2', [app.id, lang]),
  ]);
  // exact language beats the base language, which beats the primary language
  const rank = (l: string) => (l === lang ? 3 : l === base ? 2 : 1);
  const best = new Map<string, { r: number; text: string }>();
  for (const m of msgs.rows) {
    const name = m.name.toUpperCase();
    const r = rank(m.language);
    if ((best.get(name)?.r ?? 0) < r) best.set(name, { r, text: m.text });
  }
  const entry = {
    at: Date.now(),
    messages: Object.fromEntries([...best].map(([k, v]) => [k, v.text])),
    dict: new Map(trans.rows.map((t) => [t.source, t.target])),
  };
  cache.set(key, entry);
  return entry;
}

// ------------------------------------------------------------------ time zones

let zones: { at: number; names: Set<string>; sorted: string[] } | null = null;

/** The time zone names PostgreSQL knows (pg_timezone_names), read once an hour. */
export async function timeZoneNames() {
  if (!zones || Date.now() - zones.at > 3_600_000) {
    const rows = (await runtime.query<{ name: string }>(`select name from pg_timezone_names where name !~ '^(posix|right)/' order by name`)).rows;
    zones = { at: Date.now(), names: new Set(rows.map((r) => r.name)), sorted: rows.map((r) => r.name) };
  }
  return zones;
}

/** The name if PostgreSQL knows it as a time zone (exactly, as pg_timezone_names spells it). */
export async function validTimeZone(name: unknown): Promise<string | undefined> {
  if (typeof name !== 'string' || !name || name.length > 64) return undefined;
  return (await timeZoneNames()).names.has(name) ? name : undefined;
}

/**
 * The request's time zone. With an automatic time zone (APEX: Automatic Time
 * Zone) the user's own choice (My account), else the browser's (sent once per
 * session by app.js), else the application's; without it, the application's.
 */
async function timeZoneFor(app: App, session: Session | undefined): Promise<{ tz: string | null; from: Locale['timeZoneFrom'] }> {
  if (app.time_zone_auto) {
    const own = await validTimeZone(session?.state.__TZ_PREF);
    if (own) return { tz: own, from: 'user' };
    const browser = await validTimeZone(session?.state.__TZ);
    if (browser) return { tz: browser, from: 'browser' };
  }
  const tz = await validTimeZone(app.time_zone);
  return tz ? { tz, from: 'app' } : { tz: null, from: 'database' };
}

function themeFor(app: App, session: Session | undefined, req: FastifyRequest): ThemeMode {
  const mode = isTheme(app.theme?.mode) ? app.theme.mode : 'auto';
  if (app.theme?.user_choice === false) return mode;
  const own = session?.state.__THEME ?? req.cookies?.[THEME_COOKIE];
  return isTheme(own) ? own : mode;
}

/**
 * Work out the request's language and theme. A valid ?lang= is remembered
 * in the session (the caller saves session state).
 */
export async function resolveLocale(req: FastifyRequest, app: App, session?: Session): Promise<Locale> {
  const languages = appLanguages(app);
  const query = new URLSearchParams(req.url.split('?')[1] ?? '').get('lang');
  let lang: string | undefined;
  if (app.language_from !== 'primary' || languages.length > 1) {
    const asked = matchLanguage(query, languages);
    if (asked && session) session.state.__LANG = asked;
    lang = asked ?? matchLanguage(session?.state.__LANG, languages);
    if (!lang && app.language_from !== 'primary') lang = fromAcceptLanguage(req.headers['accept-language'], languages);
  }
  lang ??= app.language;
  const { messages, dict } = await texts(app, lang);
  const t = translator(lang, Object.fromEntries(Object.entries(messages).map(([k, v]) => [k.toLowerCase(), v])));
  // masks: a text message for this language, else the app's, else pgapex's default for the language
  const mask = (key: 'format.date' | 'format.timestamp', appMask: string | null) =>
    messages[key.toUpperCase()] ?? (appMask || t(key) || null);
  let number: Intl.NumberFormat;
  try {
    number = new Intl.NumberFormat(lang, { maximumFractionDigits: 2 });
  } catch {
    number = new Intl.NumberFormat('en', { maximumFractionDigits: 2 });
  }
  // the currency of L and C in number masks: a text message, the app's, the language's default
  const iso = [messages['FORMAT.CURRENCY'], app.currency, t('format.currency')].find((c) => typeof c === 'string' && /^[A-Z]{3}$/.test(c)) ?? 'USD';
  const numbers = numberSymbols(lang, iso);
  const format = dateFormatter(lang, mask('format.date', app.date_format), mask('format.timestamp', app.timestamp_format));
  const { tz, from } = await timeZoneFor(app, session);
  return {
    lang,
    dir: RTL.has(baseLanguage(lang)) ? 'rtl' : 'ltr',
    t,
    tr: (text) => dict.get(text) ?? text,
    messages,
    languages,
    theme: themeFor(app, session, req),
    themeChoice: app.theme?.user_choice !== false,
    format,
    number,
    numbers,
    masked: (m) => maskedFormatter(format, lang, numbers, m),
    timeZone: tz,
    timeZoneFrom: from,
  };
}

// ------------------------------------------------------------------ translating an application

/** Translate a static list of values: "STATIC:Yes;Y,No;N" → "STATIC:Ja;Y,Nee;N". */
function translateStaticLov(lov: string | null, tr: (s: string) => string) {
  if (!lov || !/^STATIC2?:/i.test(lov)) return lov;
  const [prefix, rest] = [lov.slice(0, lov.indexOf(':') + 1), lov.slice(lov.indexOf(':') + 1)];
  return prefix + rest.split(',').map((pair) => {
    const i = pair.lastIndexOf(';');
    return i < 0 ? pair : tr(pair.slice(0, i)) + pair.slice(i);
  }).join(',');
}

/** Apply translations to the app's own texts (in place; the objects are per request). */
export function translateApp(app: App, tr: (s: string) => string) {
  app.name = tr(app.name);
  for (const p of app.pages) {
    p.name = tr(p.name);
    if (p.title) p.title = tr(p.title);
  }
  for (const n of app.nav) n.label = tr(n.label);
  for (const s of app.authz_schemes) if (s.error_message) s.error_message = tr(s.error_message);
}

export function translatePage(page: Page, tr: (s: string) => string) {
  page.name = tr(page.name);
  if (page.title) page.title = tr(page.title);
  for (const r of page.regions) {
    if (r.title) r.title = tr(r.title);
    const c = r.config ?? {};
    if (typeof c.empty === 'string') c.empty = tr(c.empty);
    if (c.headings) for (const k of Object.keys(c.headings)) c.headings[k] = tr(c.headings[k]);
    if (Array.isArray(c.facets))
      for (const f of c.facets) {
        if (f?.label) f.label = tr(f.label);
        if (Array.isArray(f?.ranges)) for (const x of f.ranges) if (typeof x?.label === 'string') x.label = tr(x.label);
      }
    if (typeof c.placeholder === 'string') c.placeholder = tr(c.placeholder);
    if (typeof c.display_selector === 'string') c.display_selector = tr(c.display_selector);
    if (r.type === 'static' && r.source) r.source = tr(r.source);
  }
  for (const i of page.items) {
    if (i.label) i.label = tr(i.label);
    if (i.help) i.help = tr(i.help);
    i.lov = translateStaticLov(i.lov, tr);
    if (typeof i.config?.null_label === 'string') i.config.null_label = tr(i.config.null_label);
    if (typeof i.config?.placeholder === 'string') i.config.placeholder = tr(i.config.placeholder);
  }
  for (const b of page.buttons) {
    b.label = tr(b.label);
    if (b.confirm) b.confirm = tr(b.confirm);
    if (b.badge) b.badge = tr(b.badge);
    for (const e of Array.isArray(b.menu) ? b.menu : []) {
      e.label = tr(e.label);
      if (e.confirm) e.confirm = tr(e.confirm);
    }
  }
  for (const d of page.dynamic_actions) if (d.message) d.message = tr(d.message);
  for (const v of page.validations) if (v.message) v.message = tr(v.message);
  for (const p of page.processes) if (p.success_message) p.success_message = tr(p.success_message);
}

/**
 * Every translatable text of an application with where it is used, for the
 * builder's translation page and the XLIFF/CSV export.
 */
export async function translatableTexts(appId: number, q: { query: (sql: string, params: unknown[]) => Promise<{ rows: any[] }> }) {
  const rows = (
    await q.query(
      `select text, string_agg(distinct place, ', ') as places from (
         select name as text, 'application name' as place from meta.app where id = $1
         union all select name, 'page ' || page_no from meta.page where app_id = $1
         union all select title, 'page ' || page_no || ' title' from meta.page where app_id = $1
         union all select label, 'navigation' from meta.nav_entry where app_id = $1
         union all select error_message, 'authorization ' || name from meta.authz_scheme where app_id = $1
         union all select r.title, 'page ' || p.page_no || ' region' from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1
         union all select r.config->>'empty', 'page ' || p.page_no || ' region' from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1
         union all select h.value, 'page ' || p.page_no || ' heading' from meta.region r join meta.page p on p.id = r.page_id,
                          jsonb_each_text(case when jsonb_typeof(r.config->'headings') = 'object' then r.config->'headings' else '{}' end) h where p.app_id = $1
         union all select f->>'label', 'page ' || p.page_no || ' facet' from meta.region r join meta.page p on p.id = r.page_id,
                          jsonb_array_elements(case when jsonb_typeof(r.config->'facets') = 'array' then r.config->'facets' else '[]' end) f where p.app_id = $1
         union all select g->>'label', 'page ' || p.page_no || ' facet range' from meta.region r join meta.page p on p.id = r.page_id,
                          jsonb_array_elements(case when jsonb_typeof(r.config->'facets') = 'array' then r.config->'facets' else '[]' end) f,
                          jsonb_array_elements(case when jsonb_typeof(f->'ranges') = 'array' then f->'ranges' else '[]' end) g where p.app_id = $1
         union all select r.config->>'placeholder', 'page ' || p.page_no || ' region' from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1
         union all select r.config->>'display_selector', 'page ' || p.page_no || ' tab' from meta.region r join meta.page p on p.id = r.page_id
                    where p.app_id = $1 and jsonb_typeof(r.config->'display_selector') = 'string'
         union all select r.source, 'page ' || p.page_no || ' static region' from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and r.type = 'static'
         union all select i.label, 'page ' || p.page_no || ' item ' || i.name from meta.item i join meta.page p on p.id = i.page_id where p.app_id = $1
         union all select i.help, 'page ' || p.page_no || ' help ' || i.name from meta.item i join meta.page p on p.id = i.page_id where p.app_id = $1
         union all select i.config->>'null_label', 'page ' || p.page_no || ' item ' || i.name from meta.item i join meta.page p on p.id = i.page_id where p.app_id = $1
         union all select i.config->>'placeholder', 'page ' || p.page_no || ' item ' || i.name from meta.item i join meta.page p on p.id = i.page_id where p.app_id = $1
         union all select left(pair, length(pair) - strpos(reverse(pair), ';')), 'page ' || p.page_no || ' list ' || i.name
             from meta.item i join meta.page p on p.id = i.page_id,
                  regexp_split_to_table(substr(i.lov, strpos(i.lov, ':') + 1), ',') pair
            where p.app_id = $1 and i.lov ~* '^STATIC2?:' and strpos(pair, ';') > 0
         union all select b.label, 'page ' || p.page_no || ' button' from meta.button b join meta.page p on p.id = b.page_id where p.app_id = $1
         union all select b.confirm, 'page ' || p.page_no || ' confirm' from meta.button b join meta.page p on p.id = b.page_id where p.app_id = $1
         union all select b.badge, 'page ' || p.page_no || ' badge' from meta.button b join meta.page p on p.id = b.page_id where p.app_id = $1
         union all select e->>'label', 'page ' || p.page_no || ' menu ' || b.name from meta.button b join meta.page p on p.id = b.page_id,
                  jsonb_array_elements(case when jsonb_typeof(b.menu) = 'array' then b.menu else '[]' end) e where p.app_id = $1
         union all select d.message, 'page ' || p.page_no || ' dynamic action' from meta.dynamic_action d join meta.page p on p.id = d.page_id where p.app_id = $1
         union all select v.message, 'page ' || p.page_no || ' validation' from meta.validation v join meta.page p on p.id = v.page_id where p.app_id = $1
         union all select x.success_message, 'page ' || p.page_no || ' process' from meta.process x join meta.page p on p.id = x.page_id where p.app_id = $1
       ) t
       where coalesce(trim(text), '') <> ''
       group by text order by min(place), text`,
      [appId],
    )
  ).rows as { text: string; places: string }[];
  return rows;
}
