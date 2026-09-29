// Date and timestamp display formats (APEX: application date format masks).
// Masks use Oracle/APEX tokens: YYYY YY MM MON MONTH DD DY DAY HH24 HH12 HH
// MI SS AM PM. Text in double quotes is literal: DD "de" MONTH.

export const DATE_OID = 1082;
export const TIMESTAMP_OIDS = new Set([1114, 1184]);

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

/** A formatter for dates and timestamps with the given masks (null: ISO, as sent by Postgres). */
export function dateFormatter(lang: string, dateMask: string | null, timestampMask: string | null): Formatter {
  return (v, oid) => {
    if (v === null || v === undefined || oid === undefined) return undefined;
    if (oid === DATE_OID) return dateMask ? applyMask(String(v), dateMask, lang) : undefined;
    if (TIMESTAMP_OIDS.has(oid)) return timestampMask ? applyMask(String(v), timestampMask, lang) : String(v).slice(0, 16);
    return undefined;
  };
}
