// (sprint 121, WS-7) The builder in more languages, like APEX's builder (Deutsch, English, Español, Français, …):
// the builder's own texts are keyed messages in src/builder/i18n/<lang>.ts, the same mechanism as the runtime's
// texts in src/i18n.ts. English (en.ts) defines the keys; every other language file is a Record of the same keys
// (TypeScript refuses a missing or an unknown key, test/builder-i18n.test.ts checks the files and the source).
//
// A page gets its translator from the session: `const tx = tr(s)`, then `tx('rail.app_builder')`, or with
// {placeholders}: `tx('ab.count', { n: 3 })`. The result is plain text: the html`` tag escapes it like any value.
// `tx.rich()` puts markup (links) into a sentence: the message is escaped, Raw parameters are kept.
// `tx.dyn()` takes a key made at run time (a region type's gallery label, a SQL Workshop tool) with a fallback.
// A text that is not keyed yet simply stays English. Moving a screen over: docs/guide/12-development.md.
//
// The developer's choice: meta.developer.language (migration 127), copied into the session (__BLANG) at sign-in;
// before signing in, the sign-in page's language links set a cookie (LANG_COOKIE). See language.ts.

import type { FastifyRequest } from 'fastify';
import { esc, raw, Raw } from '../html.ts';
import type { Session } from '../session.ts';
import { de } from './i18n/de.ts';
import { en } from './i18n/en.ts';
import { es } from './i18n/es.ts';
import { fr } from './i18n/fr.ts';
import { nl } from './i18n/nl.ts';
import { pt } from './i18n/pt.ts';

export type BuilderKey = keyof typeof en;
export type BuilderMessages = Record<BuilderKey, string>;
export type Params = Record<string, string | number | null | undefined>;

/** The builder's languages, in the order of the language menu and the sign-in page's links (names in their own language). */
export const BUILDER_LANGUAGES = [
  ['de', 'Deutsch'], ['en', 'English'], ['es', 'Español'], ['fr', 'Français'], ['nl', 'Nederlands'], ['pt', 'Português'],
] as const;
export type BuilderLang = (typeof BUILDER_LANGUAGES)[number][0];

const MESSAGES: Record<BuilderLang, Readonly<Record<string, string>>> = { en, de, es, fr, nl, pt };

/** The cookie with the sign-in page's language on this device (the builder's path only). */
export const LANG_COOKIE = 'pgkiln_blang';

/** A known builder language code, or null: only the codes in BUILDER_LANGUAGES, exactly. */
export const validBuilderLanguage = (v: unknown): BuilderLang | null =>
  typeof v === 'string' && Object.hasOwn(MESSAGES, v) ? (v as BuilderLang) : null;

/** The language of a developer's session (English when none was chosen). */
export const builderLanguage = (s: Pick<Session, 'state'> | null | undefined): BuilderLang => validBuilderLanguage(s?.state?.__BLANG) ?? 'en';

/** The language of a visitor's sign-in page (or a builder error page): the cookie, else English. */
export const cookieLanguage = (req: FastifyRequest): BuilderLang =>
  validBuilderLanguage((req.cookies as Record<string, string> | undefined)?.[LANG_COOKIE]) ?? 'en';

export const languageName = (lang: BuilderLang) => BUILDER_LANGUAGES.find(([c]) => c === lang)![1];

const fill = (text: string, params?: Params) =>
  params ? text.replace(/\{(\w+)\}/g, (m, k: string) => (params[k] === undefined || params[k] === null ? m : String(params[k]))) : text;

export interface BuilderTranslate {
  (key: BuilderKey, params?: Params): string;
  readonly lang: BuilderLang;
  /** A key made at run time: its text in this language, else in English, else the fallback (never the raw key). */
  dyn(key: string, fallback: string, params?: Params): string;
  /** A sentence with markup: the message is escaped, string parameters too; Raw parameters (links) are kept. */
  rich(key: BuilderKey, params: Record<string, string | number | Raw>): Raw;
  /** An English label passed around as text (a breadcrumb, a page title) in this language, when it is a known one. */
  label(text: string): string;
}

/**
 * English labels that many builder pages pass to shell() as text (breadcrumbs, titles): translated there, so a
 * page that isn't keyed yet still gets a translated breadcrumb trail for these.
 */
const LABELS: Record<string, BuilderKey> = {
  'App Builder': 'rail.app_builder',
  'SQL Workshop': 'rail.sql_workshop',
  Home: 'rail.home',
  'App Gallery': 'rail.gallery',
  'Data Reporter': 'rail.reporter',
  'Team Development': 'rail.team',
  Search: 'common.search',
  'Workspace home': 'wh.title',
  'Workspace utilities': 'admin.utilities',
  Dashboard: 'ab.tile.dashboard',
  Import: 'ab.tile.import',
  Developers: 'admin.developers',
  Users: 'nav.users',
  'Shared Components': 'app.tab.shared',
  Settings: 'app.tab.settings',
};

/** A translator: the language's messages (`own`, for tests: a partial file), then English, then the key itself. */
export function builderTranslator(lang: BuilderLang, own: Readonly<Record<string, string>> = MESSAGES[lang]): BuilderTranslate {
  const text = (key: string): string | undefined => own[key] ?? (en as Record<string, string>)[key];
  const tx = ((key: BuilderKey, params?: Params) => fill(text(key) ?? key, params)) as BuilderTranslate;
  Object.defineProperty(tx, 'lang', { value: lang });
  tx.dyn = (key, fallback, params) => fill(text(key) ?? fallback, params);
  tx.rich = (key, params) =>
    raw(esc(text(key) ?? key).replace(/\{(\w+)\}/g, (m, k: string) => {
      const v = params[k];
      return v === undefined ? m : v instanceof Raw ? v.value : esc(v);
    }));
  tx.label = (label) => (Object.hasOwn(LABELS, label) ? tx(LABELS[label]) : label);
  return tx;
}

const CACHE = new Map<BuilderLang, BuilderTranslate>();
/** The translator of a language (one per language, kept). */
export const translatorFor = (lang: BuilderLang) => {
  let t = CACHE.get(lang);
  if (!t) CACHE.set(lang, (t = builderTranslator(lang)));
  return t;
};

/** The translator of a developer's session. */
export const tr = (s: Pick<Session, 'state'> | null | undefined) => translatorFor(builderLanguage(s));

/** For tests and the coverage check: the message files. */
export const builderMessages = (lang: BuilderLang): Readonly<Record<string, string>> => MESSAGES[lang];
