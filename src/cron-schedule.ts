// (sprint 101, Database Actions DA-12) pg_cron schedules, without a database: parse, explain and compute the
// next runs of a schedule as pg_cron understands it. SQL Workshop › Scheduling (src/builder/scheduling.ts) uses it
// for the list's "next run" column and the schedule builder's preview; it never decides what pg_cron accepts
// (cron.schedule does), it only explains.
//
// Supported, as in pg_cron (its parser comes from Vixie cron):
//   - five fields "minute hour day-of-month month day-of-week": *, lists (1,15), ranges (1-5), steps (*/15, 0-30/10,
//     5/20 = 5 to the end by 20), month names (jan … dec) and day names (sun … sat), 0 or 7 for Sunday
//   - "$" in day-of-month: the last day of the month (also in a list: "15,$")
//   - day-of-month and day-of-week both restricted (neither starts with "*"): a day matching either runs
//   - "n seconds" (1 to 59): an interval rather than a time of day
//   - macros @yearly, @annually, @monthly, @weekly, @daily, @midnight, @hourly, and @reboot (no next runs)
// pg_cron reads schedules in its cron.timezone (GMT unless set), so the next runs take a time zone.

export interface CronFields {
  minute: string;
  hour: string;
  day: string;
  month: string;
  weekday: string;
}

export type Schedule =
  | { kind: 'cron'; minutes: Set<number>; hours: Set<number>; days: Set<number>; lastDay: boolean; months: Set<number>; weekdays: Set<number>; either: boolean; fields: CronFields }
  | { kind: 'seconds'; seconds: number }
  | { kind: 'reboot' };

export class ScheduleError extends Error {}

const MACROS: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Ready-made schedules for the builder (label, expression). */
export const PRESETS: [string, string][] = [
  ['Every minute', '* * * * *'],
  ['Every 30 seconds', '30 seconds'],
  ['Every 5 minutes', '*/5 * * * *'],
  ['Every 15 minutes', '*/15 * * * *'],
  ['Every hour', '0 * * * *'],
  ['Every day at 02:00', '0 2 * * *'],
  ['Every day at midnight', '0 0 * * *'],
  ['Weekdays at 07:00', '0 7 * * 1-5'],
  ['Every Sunday at 03:00', '0 3 * * 0'],
  ['First day of the month at 01:00', '0 1 1 * *'],
  ['Last day of the month at 23:00', '0 23 $ * *'],
  ['Every year on 1 January', '0 0 1 1 *'],
];

const MAX_LENGTH = 200;

function field(text: string, min: number, max: number, label: string, names?: string[], allowLast = false): { set: Set<number>; last: boolean } {
  const set = new Set<number>();
  let last = false;
  if (text === '') throw new ScheduleError(`${label}: empty`);
  const num = (s: string) => {
    const lower = s.toLowerCase();
    const named = names ? names.indexOf(lower) : -1;
    const n = named >= 0 ? named + (min === 1 ? 1 : 0) : /^\d{1,2}$/.test(s) ? Number(s) : NaN;
    if (!Number.isInteger(n) || n < min || n > max) throw new ScheduleError(`${label}: "${s}" is not between ${min} and ${max}`);
    return n;
  };
  for (const part of text.split(',')) {
    if (allowLast && part === '$') {
      last = true;
      continue;
    }
    const pieces = part.split('/');
    if (pieces.length > 2) throw new ScheduleError(`${label}: bad step in "${part}"`);
    const [range, stepText] = pieces;
    if (stepText !== undefined && !/^\d{1,2}$/.test(stepText)) throw new ScheduleError(`${label}: bad step in "${part}"`);
    const step = stepText === undefined ? 1 : Number(stepText);
    if (step < 1) throw new ScheduleError(`${label}: bad step in "${part}"`);
    let [from, to] = [min, max];
    if (range !== '*') {
      const ends = range.split('-');
      if (ends.length > 2 || ends.some((e) => e === '')) throw new ScheduleError(`${label}: "${part}" is not a number, range or *`);
      from = num(ends[0]);
      to = ends.length === 1 ? (stepText === undefined ? from : max) : num(ends[1]);
      if (to < from) throw new ScheduleError(`${label}: "${range}" runs backwards`);
    }
    for (let n = from; n <= to; n += step) set.add(n);
  }
  return { set, last };
}

/** Parse a pg_cron schedule; throws ScheduleError with a message for people. */
export function parseSchedule(input: string): Schedule {
  const text = String(input ?? '').trim();
  if (!text) throw new ScheduleError('Enter a schedule, for example "0 2 * * *" (every day at 02:00).');
  if (text.length > MAX_LENGTH) throw new ScheduleError(`A schedule is at most ${MAX_LENGTH} characters.`);
  const secs = /^(\d+)\s*seconds?$/i.exec(text);
  if (secs) {
    const n = Number(secs[1]);
    if (n < 1 || n > 59) throw new ScheduleError('An interval in seconds is 1 to 59 seconds; use a cron schedule for longer intervals.');
    return { kind: 'seconds', seconds: n };
  }
  if (text.toLowerCase() === '@reboot') return { kind: 'reboot' };
  const expanded = MACROS[text.toLowerCase()];
  if (!expanded && text.startsWith('@')) throw new ScheduleError(`Unknown shortcut "${text}" (use @hourly, @daily, @weekly, @monthly, @yearly or @reboot).`);
  const parts = (expanded ?? text).split(/\s+/);
  if (parts.length !== 5) throw new ScheduleError('A schedule has five fields: minute hour day-of-month month day-of-week (or "n seconds", or @daily, …).');
  const [minute, hour, day, month, weekday] = parts;
  const days = field(day, 1, 31, 'Day of month', undefined, true);
  const weekdays = field(weekday, 0, 7, 'Day of week', DAYS).set;
  if (weekdays.delete(7)) weekdays.add(0); // 7 is Sunday too
  return {
    kind: 'cron',
    minutes: field(minute, 0, 59, 'Minute').set,
    hours: field(hour, 0, 23, 'Hour').set,
    days: days.set,
    lastDay: days.last,
    months: field(month, 1, 12, 'Month', MONTHS).set,
    weekdays,
    // Vixie cron: a field starting with * counts as unrestricted
    either: !day.startsWith('*') && !weekday.startsWith('*'),
    fields: { minute, hour, day, month, weekday },
  };
}

/** Why a schedule is not usable, or null. */
export function scheduleProblem(text: string): string | null {
  try {
    const s = parseSchedule(text);
    if (s.kind === 'cron') nextRuns(s, new Date(), 1);
    return null;
  } catch (e) {
    if (e instanceof ScheduleError) return e.message;
    throw e;
  }
}

/** The five fields of a cron schedule (macros expanded), or null for "n seconds", @reboot and bad input. */
export function splitSchedule(text: string): CronFields | null {
  try {
    const s = parseSchedule(text);
    return s.kind === 'cron' ? s.fields : null;
  } catch {
    return null;
  }
}

/** A schedule from the builder's five fields (blank fields are *). */
export function joinSchedule(f: Partial<CronFields>): string {
  const v = (x: string | undefined) => String(x ?? '').trim() || '*';
  return [v(f.minute), v(f.hour), v(f.day), v(f.month), v(f.weekday)].join(' ');
}

export function validTimeZone(tz: string) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** pg_cron's time zone names (GMT, UTC, IANA names); unknown ones fall back to UTC. */
export const cronTimeZone = (tz: string | null | undefined) => (tz && validTimeZone(tz) ? tz : 'UTC');

const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const formatter = (timeZone: string) =>
  new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' });

function wallClock(d: Date, fmt: Intl.DateTimeFormat) {
  const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour % 24, minute: +p.minute, weekday: WEEKDAY[p.weekday] };
}

const daysInMonth = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/**
 * The next `count` runs after `after` (exclusive), in the time zone. "n seconds" counts on from `after`;
 * @reboot has none. A schedule that never matches within five years (30 February) throws ScheduleError.
 */
export function nextRuns(schedule: Schedule, after: Date, count = 5, timeZone = 'UTC'): Date[] {
  if (schedule.kind === 'reboot') return [];
  if (schedule.kind === 'seconds') {
    const start = Math.floor(after.getTime() / 1000) * 1000;
    return Array.from({ length: count }, (_, i) => new Date(start + (i + 1) * schedule.seconds * 1000));
  }
  const fmt = formatter(timeZone);
  const out: Date[] = [];
  let lastKey = ''; // a wall-clock minute that comes twice (end of summer time) runs once
  let t = Math.floor(after.getTime() / 60_000) * 60_000 + 60_000;
  const limit = t + 5 * 366 * 86_400_000;
  while (out.length < count && t < limit) {
    const w = wallClock(new Date(t), fmt);
    const domOk = schedule.days.has(w.day) || (schedule.lastDay && w.day === daysInMonth(w.year, w.month));
    const dowOk = schedule.weekdays.has(w.weekday);
    const dayOk = schedule.either ? domOk || dowOk : domOk && dowOk;
    if (!schedule.months.has(w.month) || !dayOk) {
      // to (nearly) the end of the wall-clock day: an hour short, for a day that daylight saving time shortens;
      // then by quarters of an hour, which are the same instants in every time zone
      const left = (24 * 60 - (w.hour * 60 + w.minute)) - 60;
      t += left > 15 ? Math.floor(left / 15) * 15 * 60_000 : (15 - (w.minute % 15)) * 60_000;
    } else if (!schedule.hours.has(w.hour)) t += (15 - (w.minute % 15)) * 60_000;
    else if (schedule.minutes.has(w.minute)) {
      const key = `${w.year}-${w.month}-${w.day} ${w.hour}:${w.minute}`;
      if (key !== lastKey) out.push(new Date(t));
      lastKey = key;
      t += 60_000;
    } else t += 60_000;
  }
  if (!out.length) throw new ScheduleError('The schedule never matches (for example 30 February).');
  return out;
}

/** A run time as "2026-10-17 02:00" (with seconds for interval schedules) in the time zone. */
export function formatRun(d: Date, timeZone = 'UTC', seconds = false): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}${seconds ? `:${p.second}` : ''}`;
}

// ------------------------------------------------------------------ in words

const pad = (n: number) => String(n).padStart(2, '0');
const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b);
const isAll = (s: Set<number>, min: number, max: number) => s.size === max - min + 1;
/** a list of numbers with runs as ranges: 1-5, 7 */
function compact(values: number[], name: (n: number) => string = String, t: CronWords = EN_WORDS) {
  const out: string[] = [];
  for (let i = 0; i < values.length; i++) {
    let j = i;
    while (j + 1 < values.length && values[j + 1] === values[j] + 1) j++;
    out.push(j - i >= 2 ? fillWords(t('cron.range'), { from: name(values[i]), to: name(values[j]) }) : j > i ? `${name(values[i])}, ${name(values[j])}` : name(values[i]));
    i = j;
  }
  return out.join(', ');
}
/** an evenly spaced set from 0: its step, else 0 */
function stepOf(s: Set<number>, min: number, max: number) {
  const v = sorted(s);
  if (v.length < 2 || v[0] !== min) return 0;
  const step = v[1] - v[0];
  return v.every((x, i) => x === min + i * step) && v[v.length - 1] + step > max ? step : 0;
}

/** The schedule in words ("At 02:00, every day"). */
/**
 * (sprint 162, CD-8) The phrases of a schedule in words, by key: English here; the builder passes its translator
 * (the same keys, cron.*, in src/builder/i18n/*.ts) and the language for the day and month names.
 */
export const EN_WORDS_TEXT: Record<string, string> = {
  'cron.reboot': 'When the database server starts', 'cron.every_second': 'Every second', 'cron.every_seconds': 'Every {n} seconds',
  'cron.every_minute': 'Every minute', 'cron.every_minutes': 'Every {n} minutes', 'cron.every_hour': 'Every hour',
  'cron.minute_of_hour': 'At minute {m} of every hour', 'cron.minutes_of_hour': 'At minutes {list} of every hour', 'cron.at': 'At {times}',
  'cron.at_minute': 'At minute {m}', 'cron.at_minutes': 'At minutes {list}', 'cron.of_every_hours': '{mins} of every {n} hours',
  'cron.past_hours': '{mins} past hours {list}', 'cron.day_and_last': 'on day {list} and the last day of the month',
  'cron.last_day': 'on the last day of the month', 'cron.day_of_month': 'on day {list} of the month', 'cron.weekdays': 'on weekdays',
  'cron.on_days': 'on {list}', 'cron.a_days': 'a {list}', 'cron.either': '{dom} or {dow}', 'cron.if': '{dom} if it is {dow}',
  'cron.every_day': 'every day', 'cron.in_months': 'in {list}', 'cron.range': '{from} to {to}',
};
export type CronWords = (key: string) => string;
const EN_WORDS: CronWords = (k) => EN_WORDS_TEXT[k] ?? k;
const fillWords = (text: string, p: Record<string, string | number>) => text.replace(/\{(\w+)\}/g, (m, k: string) => (k in p ? String(p[k]) : m));

/** Day (0 = Sunday) and month (1 = January) names in a language (English: as before). */
const dayName = (lang: string, d: number) => (lang === 'en' ? DAY_NAMES[d] : new Intl.DateTimeFormat(lang, { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2023, 0, 1 + d))));
const monthName = (lang: string, m: number) => (lang === 'en' ? MONTH_NAMES[m - 1] : new Intl.DateTimeFormat(lang, { month: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2023, m - 1, 1))));

export function describeSchedule(s: Schedule, t: CronWords = EN_WORDS, lang = 'en'): string {
  const w = (key: string, p: Record<string, string | number> = {}) => fillWords(t(key), p);
  const list = (v: number[], name?: (n: number) => string) => compact(v, name, t);
  if (s.kind === 'reboot') return w('cron.reboot');
  if (s.kind === 'seconds') return s.seconds === 1 ? w('cron.every_second') : w('cron.every_seconds', { n: s.seconds });
  const minutes = sorted(s.minutes);
  const hours = sorted(s.hours);
  let time: string;
  // whether the time already says how often (then no "every day")
  let often = false;
  if (isAll(s.minutes, 0, 59) && isAll(s.hours, 0, 23)) {
    time = w('cron.every_minute');
    often = true;
  } else if (isAll(s.hours, 0, 23)) {
    const step = stepOf(s.minutes, 0, 59);
    often = true;
    time = step ? w('cron.every_minutes', { n: step }) : minutes.length === 1 ? (minutes[0] === 0 ? w('cron.every_hour') : w('cron.minute_of_hour', { m: minutes[0] })) : w('cron.minutes_of_hour', { list: list(minutes) });
  } else if (hours.length * minutes.length <= 6) time = w('cron.at', { times: hours.flatMap((h) => minutes.map((m) => `${pad(h)}:${pad(m)}`)).join(', ') });
  else {
    const step = stepOf(s.hours, 0, 23);
    const mins = isAll(s.minutes, 0, 59) ? w('cron.every_minute') : minutes.length === 1 ? w('cron.at_minute', { m: minutes[0] }) : w('cron.at_minutes', { list: list(minutes) });
    time = step ? w('cron.of_every_hours', { mins, n: step }) : w('cron.past_hours', { mins, list: list(hours) });
  }
  const parts = [time];
  const domAll = isAll(s.days, 1, 31) && !s.lastDay;
  const dowAll = isAll(s.weekdays, 0, 6);
  const dom = s.lastDay ? (s.days.size ? w('cron.day_and_last', { list: list(sorted(s.days)) }) : w('cron.last_day')) : w('cron.day_of_month', { list: list(sorted(s.days)) });
  const weekdays = sorted(s.weekdays);
  const days = list(weekdays, (d) => dayName(lang, d));
  const dow = weekdays.join() === '1,2,3,4,5' ? w('cron.weekdays') : w('cron.on_days', { list: days });
  if (s.either) parts.push(w('cron.either', { dom, dow }));
  else if (!domAll && !dowAll) parts.push(w('cron.if', { dom, dow: weekdays.join() === '1,2,3,4,5' ? w('cron.weekdays') : w('cron.a_days', { list: days }) }));
  else if (!domAll) parts.push(dom);
  else if (!dowAll) parts.push(dow);
  else if (!often) parts.push(w('cron.every_day'));
  if (!isAll(s.months, 1, 12)) parts.push(w('cron.in_months', { list: list(sorted(s.months), (m) => monthName(lang, m)) }));
  return parts.join(', ');
}
