// Date and timestamp display formats (APEX: application date format masks).
// Masks use Oracle/APEX tokens: YYYY YY MM MON MONTH DD DY DAY HH24 HH12 HH
// MI SS AM PM. Text in double quotes is literal: DD "de" MONTH.
// Number format masks (999G990D00) are in ../numformat.ts; maskedFormatter()
// applies either kind to a column or item.
import { compileMask, formatNumber, maskError, type NumberSymbols } from '../numformat.ts';

export const DATE_OID = 1082;
export const TIMESTAMP_OIDS = new Set([1114, 1184]);
/** int2, int4, int8, oid, float4, float8, numeric */
export const NUMBER_OIDS = new Set([20, 21, 23, 26, 700, 701, 1700]);

export type Formatter = (value: unknown, typeOid?: number) => string | undefined;

const TOKEN = /"[^"]*"|YYYY|YY|MONTH|MON|MM|DAY|DY|DD|HH24|HH12|HH|MI|SS|AM|PM/gi;

const names = new Map<string, { months: string[]; monthsShort: string[]; days: string[]; daysShort: string[] }>();
function localeNames(lang: string) {
  let n = names.get(lang);
  if (!n) {
    const make = (opts: Intl.DateTimeFormatOptions, count: number, at: (i: number) => Date) => {
      let f: Intl.DateTimeFormat;
      try {
        f = new Intl.DateTimeFormat(lang, { ...opts, timeZone: 'UTC' });
      } catch {
        f = new Intl.DateTimeFormat('en', { ...opts, timeZone: 'UTC' });
      }
      return Array.from({ length: count }, (_, i) => f.format(at(i)));
    };
    const month = (i: number) => new Date(Date.UTC(2021, i, 1));
    const day = (i: number) => new Date(Date.UTC(2021, 1, 7 + i)); // 7 Feb 2021 is a Sunday
    n = {
      months: make({ month: 'long' }, 12, month),
      monthsShort: make({ month: 'short' }, 12, month).map((m) => m.replace(/\.$/, '')),
      days: make({ weekday: 'long' }, 7, day),
      daysShort: make({ weekday: 'short' }, 7, day).map((d) => d.replace(/\.$/, '')),
    };
    names.set(lang, n);
  }
  return n;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** Format "YYYY-MM-DD[ HH:MI:SS[.fff][+tz]]" (as Postgres sends it) with a mask. */
export function applyMask(value: string, mask: string, lang: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(value);
  if (!m) return value;
  const [y, mo, d, h = 0, mi = 0, s = 0] = m.slice(1).map((x) => (x === undefined ? 0 : Number(x)));
  const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  const n = localeNames(lang);
  return mask.replace(TOKEN, (tok) => {
    if (tok.startsWith('"')) return tok.slice(1, -1);
    const up = tok.toUpperCase();
    const cased = (text: string) => (tok === up ? text.toUpperCase() : tok[0] === up[0] && tok[1] !== up[1] ? text[0].toUpperCase() + text.slice(1) : text);
    switch (up) {
      case 'YYYY': return String(y);
      case 'YY': return pad(y % 100);
      case 'MM': return pad(mo);
      case 'MONTH': return cased(n.months[mo - 1]);
      case 'MON': return cased(n.monthsShort[mo - 1]);
      case 'DD': return pad(d);
      case 'DAY': return cased(n.days[dow]);
      case 'DY': return cased(n.daysShort[dow]);
      case 'HH24': return pad(h);
      case 'HH12':
      case 'HH': return pad(h % 12 || 12);
      case 'MI': return pad(mi);
      case 'SS': return pad(s);
      case 'AM':
      case 'PM': return h < 12 ? 'AM' : 'PM';
      default: return tok;
    }
  });
}

/** (sprint 76) The month names of a language (long and short), for the date picker. */
export function monthNames(lang: string) {
  const n = localeNames(lang);
  return { long: n.months, short: n.monthsShort };
}

/**
 * (sprint 76) Read a date typed in a date mask back as "YYYY-MM-DD": YYYY, YY (2000–2099), MM, DD, MON and
 * MONTH (the language's names, any case), DY and DAY (names, not checked), quoted text and other characters as
 * they are. An ISO date is read too. Null when the text doesn't fit the mask or isn't a real date.
 */
export function parseDateMask(value: string, mask: string, lang: string): string | null {
  const v = value.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  const n = localeNames(lang);
  let y: number | undefined, mo: number | undefined, d: number | undefined;
  if (iso) [y, mo, d] = iso.slice(1).map(Number);
  else {
    const parts: string[] = [];
    const groups: string[] = [];
    let last = 0;
    const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const m of mask.matchAll(TOKEN)) {
      parts.push(esc(mask.slice(last, m.index)));
      last = m.index! + m[0].length;
      const tok = m[0];
      if (tok.startsWith('"')) { parts.push(esc(tok.slice(1, -1))); continue; }
      const up = tok.toUpperCase();
      const names = (list: string[]) => `(${list.map(esc).join('|')})`;
      const re: Record<string, string> = { YYYY: '(\\d{4})', YY: '(\\d{2})', MM: '(\\d{1,2})', DD: '(\\d{1,2})', MONTH: names(n.months), MON: names(n.monthsShort), DAY: names(n.days), DY: names(n.daysShort) };
      if (!re[up]) return null; // a time in a date mask: not a date item's
      parts.push(re[up]);
      groups.push(up);
    }
    parts.push(esc(mask.slice(last)));
    const m = new RegExp(`^${parts.join('')}$`, 'i').exec(v);
    if (!m) return null;
    groups.forEach((g, i) => {
      const x = m[i + 1];
      if (g === 'YYYY') y = Number(x);
      else if (g === 'YY') y = 2000 + Number(x);
      else if (g === 'MM') mo = Number(x);
      else if (g === 'DD') d = Number(x);
      else if (g === 'MONTH' || g === 'MON') mo = (g === 'MONTH' ? n.months : n.monthsShort).findIndex((name) => name.toLowerCase() === x.toLowerCase()) + 1;
    });
  }
  if (!y || !mo || !d) return null;
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, '0')}-${pad(mo)}-${pad(d)}`;
}

/** A formatter for dates and timestamps with the given masks (null: ISO, as sent by Postgres). */
export function dateFormatter(lang: string, dateMask: string | null, timestampMask: string | null): Formatter {
  return (v, oid) => {
    if (v === null || v === undefined || oid === undefined) return undefined;
    if (oid === DATE_OID) return dateMask ? applyMask(String(v), dateMask, lang) : undefined;
    if (TIMESTAMP_OIDS.has(oid)) return timestampMask ? applyMask(String(v), timestampMask, lang) : String(v).slice(0, 16);
    return undefined;
  };
}

/**
 * A formatter with a column's or item's own format mask: a number mask for
 * numbers, a date mask for dates and timestamps; anything else (and a value
 * the mask doesn't fit) goes to `base`.
 */
export function maskedFormatter(base: Formatter, lang: string, numbers: NumberSymbols, mask: string | null | undefined): Formatter {
  const m = typeof mask === 'string' ? mask.trim() : '';
  if (!m) return base;
  const numeric = typeof compileMask(m) !== 'string';
  return (v, oid) => {
    if (v === null || v === undefined) return undefined;
    if (oid === DATE_OID || (oid !== undefined && TIMESTAMP_OIDS.has(oid))) return numeric ? base(v, oid) : applyMask(String(v), m, lang);
    if (numeric && (typeof v === 'number' || typeof v === 'bigint' || (oid !== undefined && NUMBER_OIDS.has(oid)))) return formatNumber(v, m, numbers) ?? base(v, oid);
    return base(v, oid);
  };
}

/** Why a column's format mask (a number mask or a date mask) is not valid, or null. */
export function formatMaskError(mask: unknown): string | null {
  if (typeof mask !== 'string' || !mask.trim()) return 'a format mask is a non-empty text';
  const number = maskError(mask.trim());
  if (!number) return null;
  return new RegExp(TOKEN.source, 'i').test(mask) && !/^[0-9GD.,$LSV]+$/i.test(mask.trim()) ? null : number;
}

/**
 * The problems of the format settings in a region's or item's attributes:
 * "formats" (column → mask) and "format_mask" (a number mask).
 */
export function formatSettingsProblem(config: unknown): string | null {
  const c = typeof config === 'string' ? safeJson(config) : config;
  if (!c || typeof c !== 'object') return null;
  const { formats, format_mask: one } = c as Record<string, unknown>;
  if (formats !== undefined) {
    if (!formats || typeof formats !== 'object' || Array.isArray(formats)) return 'formats: an object of column names and format masks, e.g. {"sal": "FML999G990D00"}.';
    for (const [col, m] of Object.entries(formats)) {
      const e = formatMaskError(m);
      if (e) return `formats.${col}: ${e}.`;
    }
  }
  if (one !== undefined) {
    const e = typeof one === 'string' && one.trim() ? maskError(one.trim()) : 'a number format mask such as 999G990D00';
    if (e) return `format_mask: ${e}.`;
  }
  return null;
}

function safeJson(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
