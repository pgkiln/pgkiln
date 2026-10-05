// Number format masks, as in Oracle's TO_CHAR(number) and APEX's format masks:
// 999G999G990D00, FML999G990D00, 0000, S9990D0, 990D0%, 9D99EEEE, XXXX, RN.
// The value is handled as a decimal string (no floating point), so numeric
// columns of any size format and round exactly (half away from zero).
//
//   9  a digit; leading zeros are left out        0  a digit, zeros kept from here on
//   G  group separator of the language            D  decimal separator of the language
//   ,  a comma                                     .  a point (the decimal separator)
//   L  currency symbol (app's currency)           C  ISO currency code     U  as L    $  a dollar sign
//   S  sign (+/-) first or last                    MI trailing minus        PR <negative>
//   FM no padding; trailing 9-decimals are dropped B  blank integer part when zero
//   V  multiply by 10^n (n = digits after V)       EEEE scientific notation
//   X  hexadecimal (0X pads with zeros)            RN / rn  Roman numerals  TM  shortest text
//   %, spaces and "text" are shown as they are (% does not multiply the value).
//
// Differences from Oracle (on purpose): the result has no padding blanks
// (HTML collapses them anyway), and a mask without digits after a dropped
// fraction shows no lone decimal separator (FM999D99 on 5 is "5", not "5.").

export interface NumberSymbols {
  /** group separator, e.g. "," (en), "." (nl, de, es), narrow no-break space (fr) */
  group: string;
  /** decimal separator */
  decimal: string;
  /** currency symbol for L and U */
  currency: string;
  /** ISO 4217 code for C */
  iso: string;
}

export const EN_SYMBOLS: NumberSymbols = { group: ',', decimal: '.', currency: '$', iso: 'USD' };

const symbolCache = new Map<string, NumberSymbols>();

/** The separators of a language and the symbol of a currency in that language (Intl). */
export function numberSymbols(lang: string, iso = 'USD'): NumberSymbols {
  const key = `${lang}|${iso}`;
  let s = symbolCache.get(key);
  if (s) return s;
  const parts = (opts: Intl.NumberFormatOptions) => {
    try {
      return new Intl.NumberFormat(lang, opts).formatToParts(1234567.5);
    } catch {
      return new Intl.NumberFormat('en', opts).formatToParts(1234567.5);
    }
  };
  const plain = parts({ useGrouping: true });
  let currency = iso;
  try {
    currency = parts({ style: 'currency', currency: iso }).find((p) => p.type === 'currency')?.value ?? iso;
  } catch {
    // an unknown currency code: show the code
  }
  s = {
    group: plain.find((p) => p.type === 'group')?.value ?? ',',
    decimal: plain.find((p) => p.type === 'decimal')?.value ?? '.',
    currency,
    iso,
  };
  if (symbolCache.size > 200) symbolCache.clear();
  symbolCache.set(key, s);
  return s;
}

// ------------------------------------------------------------------ masks

type Affix = { k: 'cur'; v: 'L' | 'C' | 'U' | '$' } | { k: 'lit'; v: string } | { k: 'sign' };

interface FixedMask {
  kind: 'fixed' | 'sci';
  fm: boolean;
  blank: boolean;
  prefix: Affix[];
  suffix: Affix[];
  sign: 'default' | 'S' | 'MI' | 'PR';
  /** integer positions, left to right: '9', '0', or a group separator ('G' or ',') */
  int: string[];
  /** decimal positions: '9' or '0' */
  frac: string[];
  decimal: 'D' | '.' | null;
  /** digits after V */
  shift: number;
  width: number;
}
interface HexMask { kind: 'hex'; width: number; zero: boolean; lower: boolean }
interface RomanMask { kind: 'roman'; lower: boolean }
interface TmMask { kind: 'tm'; sci: boolean }
export type CompiledMask = FixedMask | HexMask | RomanMask | TmMask;

const ELEMENTS = ['EEEE', 'TM9', 'TME', 'FM', 'MI', 'PR', 'RN', 'TM', '9', '0', 'G', 'D', ',', '.', 'V', 'B', 'S', 'L', 'C', 'U', '$', 'X', '%', ' '];

type Tok = { t: string; raw: string };

function tokenize(mask: string): Tok[] | string {
  const out: Tok[] = [];
  let i = 0;
  while (i < mask.length) {
    if (mask[i] === '"') {
      const end = mask.indexOf('"', i + 1);
      if (end < 0) return 'a quoted text is not closed';
      out.push({ t: 'LIT', raw: mask.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    const rest = mask.slice(i).toUpperCase();
    const el = ELEMENTS.find((e) => rest.startsWith(e));
    if (!el) return `"${mask[i]}" is not a number format element`;
    out.push({ t: el, raw: mask.slice(i, i + el.length) });
    i += el.length;
  }
  return out;
}

const cache = new Map<string, CompiledMask | string>();

/** Compile a mask; a string is the reason it is not valid. */
export function compileMask(mask: string): CompiledMask | string {
  const hit = cache.get(mask);
  if (hit !== undefined) return hit;
  const result = compile(mask);
  if (cache.size > 500) cache.clear();
  cache.set(mask, result);
  return result;
}

/** Why a number format mask is not valid, or null when it is. */
export function maskError(mask: string): string | null {
  const m = compileMask(mask);
  return typeof m === 'string' ? m : null;
}

function compile(mask: string): CompiledMask | string {
  if (!mask.trim()) return 'the mask is empty';
  if (mask.length > 64) return 'the mask is longer than 64 characters';
  const toks = tokenize(mask);
  if (typeof toks === 'string') return toks;
  const fm = toks.some((x) => x.t === 'FM');
  const rest = toks.filter((x) => x.t !== 'FM');
  if (toks.filter((x) => x.t === 'FM').length > 1 || (fm && toks[0].t !== 'FM')) return 'FM must come first, once';

  if (rest.some((x) => x.t === 'RN')) {
    if (rest.length !== 1) return 'RN stands alone (with FM)';
    return { kind: 'roman', lower: rest[0].raw === 'rn' };
  }
  if (rest.some((x) => x.t.startsWith('TM'))) {
    if (rest.length !== 1) return 'TM stands alone';
    return { kind: 'tm', sci: rest[0].t === 'TME' };
  }
  if (rest.some((x) => x.t === 'X')) {
    if (!rest.every((x) => x.t === 'X' || x.t === '0')) return 'a hexadecimal mask has only X and leading 0';
    const firstX = rest.findIndex((x) => x.t === 'X');
    if (rest.slice(firstX).some((x) => x.t === '0')) return 'zeros in a hexadecimal mask come before the X';
    return { kind: 'hex', width: rest.length, zero: rest[0].t === '0', lower: rest.some((x) => x.raw === 'x') };
  }

  const m: FixedMask = { kind: 'fixed', fm, blank: false, prefix: [], suffix: [], sign: 'default', int: [], frac: [], decimal: null, shift: 0, width: 0 };
  // 0: before the digits, 1: in the digits, 2: after the digits
  let phase = 0;
  let afterV = false;
  let currency = 0;
  const setSign = (s: FixedMask['sign']) => {
    if (m.sign !== 'default') return 'only one of S, MI and PR';
    m.sign = s;
    return null;
  };
  for (let i = 0; i < rest.length; i++) {
    const { t, raw } = rest[i];
    const affixes = () => (phase === 2 ? m.suffix : m.prefix);
    switch (t) {
      case '9':
      case '0':
        if (phase === 2) return 'digits must be together';
        phase = 1;
        if (afterV) m.shift++;
        else if (m.decimal) m.frac.push(t);
        else m.int.push(t);
        break;
      case 'G':
      case ',':
        if (phase !== 1 || !m.int.some((p) => p === '9' || p === '0')) return 'a group separator needs digits to its left';
        if (m.decimal || afterV) return 'a group separator must be left of the decimal separator';
        if (!/^[90]$/.test(rest[i + 1]?.t ?? '')) return 'a group separator must be followed by a digit';
        m.int.push(t);
        break;
      case 'D':
      case '.':
        if (phase === 2) return 'the decimal separator must be among the digits';
        if (m.decimal || afterV) return 'only one decimal separator (or V)';
        phase = 1;
        m.decimal = t;
        break;
      case 'V':
        if (phase !== 1 || m.decimal || afterV) return 'V must follow the digits of the integer part, once, without a decimal separator';
        afterV = true;
        break;
      case 'EEEE':
        if (phase !== 1 || m.kind === 'sci') return 'EEEE must follow the digits';
        if (m.int.some((p) => p === 'G' || p === ',') || afterV) return 'EEEE cannot be used with group separators or V';
        m.kind = 'sci';
        phase = 2;
        break;
      case 'B':
        if (phase !== 0) return 'B must come before the digits';
        m.blank = true;
        break;
      case 'S': {
        const e = setSign('S');
        if (e) return e;
        if (phase === 1) phase = 2;
        if (phase === 0 && m.prefix.length) return 'S must be the first or the last element';
        if (phase === 2 && i !== rest.length - 1) return 'S must be the first or the last element';
        affixes().push({ k: 'sign' });
        break;
      }
      case 'MI':
      case 'PR': {
        if (phase === 0 || i !== rest.length - 1) return `${t} must be the last element`;
        const e = setSign(t);
        if (e) return e;
        break;
      }
      case 'L':
      case 'C':
      case 'U':
      case '$':
        if (++currency > 1) return 'only one currency element';
        if (phase === 1) phase = 2;
        affixes().push({ k: 'cur', v: t });
        break;
      case '%':
      case ' ':
      case 'LIT':
        if (phase === 1) phase = 2;
        affixes().push({ k: 'lit', v: t === 'LIT' ? raw : t });
        break;
      default:
        return `${raw} is not allowed here`;
    }
  }
  if (!m.int.length && !m.frac.length && !m.shift) return 'the mask has no digits (9 or 0)';
  if (m.kind === 'sci' && m.int.length !== 1) return 'EEEE needs exactly one digit before the decimal separator';
  m.width = m.int.length + (m.decimal ? 1 : 0) + m.frac.length + (afterV ? m.shift + 1 : 0) + 1;
  return m;
}

// ------------------------------------------------------------------ decimal strings

interface Dec {
  neg: boolean;
  /** integer digits without leading zeros ('' for zero) */
  int: string;
  /** fraction digits */
  frac: string;
}

const NUM = /^([+-])?(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d{1,4}))?$/;

/** Read a number (a JS number, bigint or a decimal string as Postgres sends it). */
export function toDec(v: unknown): Dec | null {
  let s: string;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    s = String(v);
  } else if (typeof v === 'bigint') s = v.toString();
  else if (typeof v === 'string') s = v.trim();
  else return null;
  const m = NUM.exec(s);
  if (!m || (!m[2] && !m[3])) return null;
  let digits = (m[2] ?? '') + (m[3] ?? '');
  let point = (m[2] ?? '').length + Number(m[4] ?? 0);
  if (point < 0) {
    digits = '0'.repeat(-point) + digits;
    point = 0;
  }
  if (point > digits.length) digits = digits.padEnd(point, '0');
  const int = digits.slice(0, point).replace(/^0+/, '');
  const frac = digits.slice(point);
  return { neg: m[1] === '-' && /[1-9]/.test(digits), int, frac };
}

/** Add one to a string of digits ("199" → "200", "99" → "100"). */
function increment(digits: string) {
  const a = digits.split('');
  let i = a.length - 1;
  while (i >= 0 && a[i] === '9') a[i--] = '0';
  if (i < 0) a.unshift('1');
  else a[i] = String(Number(a[i]) + 1);
  return a.join('');
}

/** Round to `places` decimals, half away from zero. */
export function roundDec(d: Dec, places: number): Dec {
  if (d.frac.length <= places) return { ...d, frac: d.frac.padEnd(places, '0') };
  const kept = d.int + d.frac.slice(0, places);
  const up = d.frac[places] >= '5';
  let all = up ? increment(kept || '0') : kept;
  all = all.padStart(places, '0');
  const int = all.slice(0, all.length - places).replace(/^0+/, '');
  const frac = all.slice(all.length - places);
  return { neg: d.neg && /[1-9]/.test(int + frac), int, frac };
}

const isZero = (d: Dec) => !d.int && !/[1-9]/.test(d.frac);

/** The canonical text of a number: "-1234.5", "0.25", "10". */
export function decText(d: Dec) {
  const frac = d.frac.replace(/0+$/, '');
  const body = (d.int || '0') + (frac ? `.${frac}` : '');
  return d.neg && body !== '0' ? `-${body}` : body;
}

// ------------------------------------------------------------------ formatting

const ROMAN: [number, string][] = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];

function roman(n: number) {
  let out = '';
  for (const [v, s] of ROMAN)
    while (n >= v) {
      out += s;
      n -= v;
    }
  return out;
}

function scientific(d: Dec, places: number | null, dec: string): string {
  if (isZero(d)) return `0${places ? dec + '0'.repeat(places) : ''}E+00`;
  const all = d.int + d.frac;
  const first = all.search(/[1-9]/);
  let exp = d.int.length - first - 1;
  let digits = all.slice(first);
  if (places === null) digits = digits.replace(/0+$/, '') || '0';
  else {
    const r = roundDec({ neg: false, int: digits[0], frac: digits.slice(1) }, places);
    if (r.int.length > 1) {
      exp++;
      digits = r.int[0] + (r.int.slice(1) + r.frac).slice(0, places);
    } else digits = r.int + r.frac;
  }
  const mant = digits[0] + (digits.length > 1 ? dec + digits.slice(1) : '');
  return `${mant}E${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`;
}

/**
 * Format a number with a mask. Returns undefined when the value is not a
 * number or the mask is not valid (the caller then shows the value as it is).
 */
export function formatNumber(value: unknown, mask: string, sym: NumberSymbols = EN_SYMBOLS): string | undefined {
  const m = compileMask(mask);
  if (typeof m === 'string') return undefined;
  const d = toDec(value);
  if (!d) return undefined;

  if (m.kind === 'roman') {
    const r = roundDec(d, 0);
    const n = Number(r.int || '0');
    if (r.neg || n < 1 || n > 3999 || r.int.length > 4) return '#'.repeat(15);
    return m.lower ? roman(n).toLowerCase() : roman(n);
  }
  if (m.kind === 'hex') {
    const r = roundDec(d, 0);
    if (r.neg) return '#'.repeat(m.width + 1);
    const hex = BigInt(r.int || '0').toString(16);
    if (hex.length > m.width) return '#'.repeat(m.width + 1);
    const out = m.zero ? hex.padStart(m.width, '0') : hex;
    return m.lower ? out : out.toUpperCase();
  }
  if (m.kind === 'tm') {
    const body = m.sci ? scientific(d, null, sym.decimal) : decText({ ...d, neg: false }).replace('.', sym.decimal);
    return d.neg ? `-${body}` : body;
  }

  // fixed point and scientific
  let body: string;
  let neg: boolean;
  const decChar = m.decimal === '.' ? '.' : sym.decimal;
  if (m.kind === 'sci') {
    body = scientific(d, m.frac.length, decChar);
    neg = d.neg && !isZero(roundDec(d, 40));
  } else {
    let x = d;
    if (m.shift) x = { ...d, int: (d.int + d.frac.slice(0, m.shift).padEnd(m.shift, '0')).replace(/^0+/, ''), frac: d.frac.slice(m.shift) };
    const places = m.shift ? 0 : m.frac.length;
    const r = roundDec(x, places);
    neg = r.neg;
    const intDigits = m.int.filter((p) => p === '9' || p === '0').length + m.shift;
    if (r.int.length > intDigits) return '#'.repeat(m.width);
    if (m.blank && isZero(r)) return '';
    // the integer part: at least as many digits as from the leftmost 0 on
    const positions = [...m.int, ...Array(m.shift).fill('9')];
    const digitPositions = positions.filter((p) => p === '9' || p === '0');
    const firstZero = digitPositions.indexOf('0');
    const min = m.blank && !r.int ? 0 : firstZero < 0 ? 0 : digitPositions.length - firstZero;
    const shown = r.int.padStart(min, '0');
    let intOut = '';
    let j = shown.length - 1;
    for (let p = positions.length - 1; p >= 0 && j >= 0; p--) {
      if (positions[p] === '9' || positions[p] === '0') intOut = shown[j--] + intOut;
      else intOut = (positions[p] === 'G' ? sym.group : ',') + intOut;
    }
    // the fraction: FM drops trailing zeros where the mask has 9s
    let fracOut = r.frac;
    if (m.fm) {
      const keep = m.frac.lastIndexOf('0') + 1;
      fracOut = fracOut.replace(/0+$/, '');
      if (fracOut.length < keep) fracOut = r.frac.slice(0, keep);
    }
    if (!intOut && !fracOut) intOut = '0';
    body = intOut + (fracOut ? decChar + fracOut : '');
  }

  const affix = (list: Affix[]) =>
    list
      .map((a) =>
        a.k === 'lit' ? a.v
        : a.k === 'sign' ? (neg ? '-' : '+')
        : a.v === 'C' ? sym.iso
        : a.v === '$' ? '$'
        : sym.currency,
      )
      .join('');
  let out = affix(m.prefix) + body + affix(m.suffix);
  if (m.sign === 'MI') out += neg ? '-' : '';
  else if (m.sign === 'PR') out = neg ? `<${out}>` : out;
  else if (m.sign === 'default' && neg) out = `-${out}`;
  return out.trim();
}

// ------------------------------------------------------------------ parsing (items)

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SPACES = /[\s    ]/g;

function fromRoman(s: string): string | null {
  const up = s.toUpperCase();
  if (!/^[MDCLXVI]+$/.test(up)) return null;
  const val: Record<string, number> = { M: 1000, D: 500, C: 100, L: 50, X: 10, V: 5, I: 1 };
  let n = 0;
  for (let i = 0; i < up.length; i++) n += val[up[i]] < (val[up[i + 1]] ?? 0) ? -val[up[i]] : val[up[i]];
  return n >= 1 && n <= 3999 && roman(n) === up ? String(n) : null;
}

/**
 * Read text typed into a number item with a mask back into a number
 * ("1.234,50 €" with nl → "1234.5"). Lenient about what the mask adds
 * (currency, %, signs, spaces, literal text) but strict about separators:
 * groups must have three digits, so "1.5" in German is not 15; it is read
 * as a plain number (1.5), as a dynamic action or SQL would set it.
 * Returns the canonical number text, '' for empty input, or null when it
 * isn't a number.
 */
export function parseNumber(text: string, mask: string | null | undefined, sym: NumberSymbols = EN_SYMBOLS): string | null {
  let s = String(text ?? '').trim();
  if (!s) return '';
  if (s.length > 200) return null;
  const compiled = mask ? compileMask(mask) : 'none';
  const m = typeof compiled === 'string' ? null : compiled;
  if (m?.kind === 'roman') return fromRoman(s);
  if (m?.kind === 'hex') return /^[0-9a-f]{1,32}$/i.test(s) ? BigInt(`0x${s}`).toString() : null;

  // what the mask adds around the digits
  const fixed = m && (m.kind === 'fixed' || m.kind === 'sci') ? m : null;
  for (const a of [...(fixed?.prefix ?? []), ...(fixed?.suffix ?? [])])
    if (a.k === 'lit' && a.v.trim() && a.v !== '%') s = s.split(a.v.trim()).join(' ');
  s = s.replace(/%/g, ' ');
  for (const c of [sym.currency, sym.iso, '$']) if (c.trim()) s = s.split(c).join(' ');
  s = s.replace(new RegExp(escapeRe(sym.iso), 'gi'), ' ').trim();

  let neg = false;
  const wrapped = /^<(.*)>$/.exec(s) ?? /^\((.*)\)$/.exec(s);
  if (wrapped) {
    neg = true;
    s = wrapped[1].trim();
  }
  const lead = /^([+-])\s*/.exec(s);
  if (lead) {
    if (wrapped) return null;
    neg = lead[1] === '-';
    s = s.slice(lead[0].length);
  }
  const trail = /\s*([+-])$/.exec(s);
  if (trail) {
    if (wrapped || lead) return null;
    neg = trail[1] === '-';
    s = s.slice(0, -trail[0].length);
  }

  const groupIsSpace = !sym.group.replace(SPACES, '');
  const group = !fixed || fixed.int.includes('G') ? (groupIsSpace ? ' ' : sym.group) : fixed.int.includes(',') ? ',' : groupIsSpace ? ' ' : sym.group;
  const decimal = fixed?.decimal === '.' ? '.' : sym.decimal;
  // spaces only count as group separators (French); elsewhere a space inside the number is an error
  s = s.replace(SPACES, ' ').trim();

  let dec: Dec | null;
  if (fixed?.kind === 'sci' || (m?.kind === 'tm')) {
    dec = toDec(s.split(decimal).join('.'));
    if (!dec || /\s/.test(s)) return null;
  } else {
    const g = escapeRe(group);
    const d = escapeRe(decimal);
    const re = new RegExp(`^(?:(\\d{1,3}(?:${g}\\d{3})+)|(\\d*))(?:${d}(\\d*))?$`);
    const x = re.exec(s);
    if (x && /\d/.test(s)) dec = toDec(`${(x[1] ?? x[2] ?? '').split(group).join('')}.${x[3] ?? ''}`);
    // not in the language's notation: a plain number as SQL writes it ("1234.5", e.g. set by a
    // dynamic action) is read as such; "1.500" in German stays 1500 (it matched above)
    else dec = /^\d*\.?\d*$/.test(s) && /\d/.test(s) ? toDec(s) : null;
    if (!dec) return null;
  }
  if (fixed?.shift) {
    const all = dec.int.padStart(fixed.shift, '0');
    dec = { neg: dec.neg, int: all.slice(0, all.length - fixed.shift).replace(/^0+/, ''), frac: all.slice(all.length - fixed.shift) + dec.frac };
  }
  dec.neg = neg && !isZero(dec);
  return decText(dec);
}

/** Whether text is a plain number as SQL reads it (what a number item without a mask must hold). */
export const isPlainNumber = (v: string) => /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d{1,4})?\s*$/.test(v);
