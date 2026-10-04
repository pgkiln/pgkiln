import pg from 'pg';
import { applyBinds, literal } from '../binds.ts';
import { savepoint } from '../db.ts';
import { esc, html, raw, type Raw } from '../html.ts';
import type { Region } from '../metadata.ts';
import { Forbidden, isAuthorized, pageAllowed } from './authz.ts';
import { bindValues, publicError, stripSemicolon, toState, type PageContext } from './context.ts';
import { fillItems, linkAttrs } from './links.ts';
import { regionUrl } from './report.ts';
import { resolveRestRegion } from './rest-sources.ts';

// Calendar region (APEX's Calendar): the SELECT returns start_date,
// optional end_date, title, and any columns referenced in config.link:
//   select starts_at as start_date, ends_at as end_date, name as title, id from events.booking
//   config: {"link": {"page": 3, "items": {"P3_ID": "#id#"}}}
// start_date/end_date may be dates (all-day events) or timestamps.
//
// Views (config.views, default all four; config.view is the one shown first):
//   month  ?r<id>_m=YYYY-MM     a month grid (an agenda list on phones)
//   week   ?r<id>_d=YYYY-MM-DD  the week (Monday first) of that day, by hour
//   day    ?r<id>_d=YYYY-MM-DD  one day by hour
//   list   ?r<id>_m=YYYY-MM     the month's events as a list
// The view is ?r<id>_v=…; everything is a plain link, so it works without JS.
//
// Create on click (config.create = {page, items}): every day and hour slot has
// an "add" link to that page with #start#, #end# and #date# filled in
// (checksummed like every link); with JS a click on the empty slot follows it.
//
// Drag and drop (config.move = SQL, e.g. a PL/pgSQL function call, run as the
// app's role with :EVENT_ID, :NEW_START and :NEW_END): events carry their key
// (config.key, default "id"); public/app.js posts a drop to
// POST /a/<app>/<page>/calendar/<region>/move (routes.ts), which checks the
// CSRF token, page access and the region's visibility; moveCalendarEvent()
// then checks config.move_authz and that the event is in the region's query
// for this user before it runs the SQL. The edit link is the keyboard and
// no-JS way to change dates.

export type CalendarView = 'month' | 'week' | 'day' | 'list';
export const CALENDAR_VIEWS: CalendarView[] = ['month', 'week', 'day', 'list'];

interface Link {
  page: number;
  items?: Record<string, string>;
}

/** The enabled views, in the standard order (all four unless config.views lists some). */
export function calendarViews(config: Record<string, any>): CalendarView[] {
  const listed = Array.isArray(config.views) ? CALENDAR_VIEWS.filter((v) => config.views.includes(v)) : [];
  return listed.length ? listed : CALENDAR_VIEWS;
}

const defaultView = (config: Record<string, any>, views: CalendarView[]) => (views.includes(config.view) ? (config.view as CalendarView) : views[0]);

function formats(lang: string) {
  const make = (l: string) => ({
    MONTHS: new Intl.DateTimeFormat(l, { month: 'long', year: 'numeric', timeZone: 'UTC' }),
    DAY: new Intl.DateTimeFormat(l, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }),
    LONG: new Intl.DateTimeFormat(l, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }),
    RANGE: new Intl.DateTimeFormat(l, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }),
    // Monday first: 1–7 Feb 2021 is Monday to Sunday
    WEEKDAYS: Array.from({ length: 7 }, (_, i) => new Intl.DateTimeFormat(l, { weekday: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2021, 1, 1 + i)))),
  });
  try {
    return make(lang);
  } catch {
    return make('en');
  }
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + n));
const pad = (n: number) => String(n).padStart(2, '0');
const mondayOf = (d: Date) => addDays(d, -((d.getUTCDay() + 6) % 7));

/** A YYYY-MM-DD string as a UTC date, or null when it is not a real date. */
export function parseDay(s: string | null | undefined): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s ?? '');
  if (!m || Number(m[1]) < 1) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return iso(d) === s ? d : null;
}

// ---------------------------------------------------------------- moving (pure, unit tested)

const STAMP = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?)?(.*)$/;

/** A drop target: YYYY-MM-DD or YYYY-MM-DDTHH:MM, checked; null when invalid. */
export function parseTarget(to: string): { date: Date; minutes: number | null } | null {
  const m = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(to);
  if (!m) return null;
  const date = parseDay(m[1]);
  if (!date) return null;
  if (m[2] === undefined) return { date, minutes: null };
  const h = Number(m[2]);
  const min = Number(m[3]);
  return h < 24 && min < 60 ? { date, minutes: h * 60 + min } : null;
}

/**
 * The new start and end of an event dropped on `to`. A timed event dropped on
 * an hour slot starts there; anything else moves by whole days and keeps its
 * time of day. The duration never changes; times keep their zone suffix.
 */
export function moveEvent(start: string, end: string | null, to: string): { start: string; end: string | null } | null {
  const target = parseTarget(to);
  const s = STAMP.exec(start);
  const e = end ? STAMP.exec(end) : null;
  if (!target || !s || !parseDay(s[1]) || (end && (!e || !parseDay(e[1])))) return null;
  const timed = s[2] !== undefined;
  const ms = (m: RegExpExecArray) => parseDay(m[1])!.getTime() + (m[2] !== undefined ? (Number(m[2]) * 60 + Number(m[3])) * 60000 : 0);
  const from = ms(s);
  const dest = target.minutes !== null && timed ? target.date.getTime() + target.minutes * 60000 : target.date.getTime() + (from - parseDay(s[1])!.getTime());
  const delta = dest - from;
  const out = (m: RegExpExecArray, t: number) => {
    const d = new Date(t);
    return m[2] !== undefined ? `${iso(d)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}${m[4]}` : iso(d);
  };
  return { start: out(s, from + delta), end: e ? out(e, ms(e) + delta) : null };
}

// ---------------------------------------------------------------- events

interface CalEvent {
  start: string; // first day, YYYY-MM-DD
  end: string; // last day, YYYY-MM-DD
  time: string | null; // HH:MM, null for all-day events
  endTime: string | null;
  title: string;
  key: string | null;
  row: Record<string, unknown>;
}

const column = (row: Record<string, unknown>, name: string) => {
  const k = Object.keys(row).find((x) => x.toLowerCase() === name.toLowerCase());
  return k === undefined ? undefined : row[k];
};

function toEvent(row: Record<string, unknown>, key: string): CalEvent {
  const s = STAMP.exec(toState(row.start_date) ?? '');
  const e = STAMP.exec(toState(row.end_date) ?? '');
  const start = s?.[1] ?? '';
  let time = s?.[2] !== undefined ? `${s[2]}:${s[3]}` : null;
  let endTime = e?.[2] !== undefined ? `${e[2]}:${e[3]}` : null;
  let end = e?.[1] ?? start;
  // a timestamp at midnight without a time at the end is an all-day event
  if (time === '00:00' && (!e || !endTime || endTime === '00:00')) time = endTime = null;
  // a timed event that ends at midnight doesn't reach into that day
  if (time && endTime === '00:00' && end > start) end = iso(addDays(parseDay(end) ?? new Date(0), -1));
  if (end < start) end = start;
  return { start, end, time, endTime, title: toState(row.title) ?? '', key: toState(column(row, key)), row };
}

const hourOf = (ev: CalEvent) => (ev.time ? Number(ev.time.slice(0, 2)) : 0);

// ---------------------------------------------------------------- rendering

export async function renderCalendar(ctx: PageContext, r: Region): Promise<Raw> {
  const F = formats(ctx.locale.lang);
  const t = ctx.locale.t;
  const cfg = r.config as Record<string, any>;
  const views = calendarViews(cfg);
  const pView = `r${r.id}_v`;
  const pMonth = `r${r.id}_m`;
  const pDay = `r${r.id}_d`;
  const asked = ctx.params.get(pView) as CalendarView | null;
  const view: CalendarView = asked && views.includes(asked) ? asked : defaultView(cfg, views);
  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const m = /^(\d{4})-(\d{2})$/.exec(ctx.params.get(pMonth) ?? '');
  const anchor = parseDay(ctx.params.get(pDay)) ?? (m && Number(m[1]) >= 1 && Number(m[2]) >= 1 && Number(m[2]) <= 12 ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1)) : today);
  const first = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1));
  const nextMonth = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 1));

  let from: Date;
  let to: Date;
  if (view === 'week') [from, to] = [mondayOf(anchor), addDays(mondayOf(anchor), 7)];
  else if (view === 'day') [from, to] = [anchor, addDays(anchor, 1)];
  else if (view === 'list') [from, to] = [first, nextMonth];
  else [from, to] = [mondayOf(first), addDays(nextMonth, (7 - ((nextMonth.getUTCDay() + 6) % 7)) % 7)];

  const keyCol = typeof cfg.key === 'string' && cfg.key ? cfg.key : 'id';
  let events: CalEvent[];
  try {
    const src = stripSemicolon(applyBinds(r.source ?? '', bindValues(ctx)));
    const c = ctx.client!;
    const res = await savepoint(c, () =>
      c.query(
        `select * from (\n${src}\n) "__q"
          where "__q".start_date < ${literal(iso(to))}::date
            and coalesce("__q".end_date, "__q".start_date) >= ${literal(iso(from))}::date
          order by "__q".start_date limit 2000`,
      ),
    );
    events = res.rows.map((row) => toEvent(row, keyCol)).filter((ev) => ev.start);
  } catch (e) {
    return html`<div class="alert alert-error" role="alert">${await publicError(ctx, e, `calendar "${r.title ?? r.id}"`)}</div>`;
  }
  // per day: all-day events first, then by time
  events.sort((a, b) => a.start.localeCompare(b.start) || (a.time ?? '').localeCompare(b.time ?? '') || a.title.localeCompare(b.title));

  const link = cfg.link as Link | undefined;
  const linkOk = link && Number.isInteger(link.page) ? await pageAllowed(ctx, link.page) : false;
  const create = cfg.create as Link | undefined;
  const createOk = create && Number.isInteger(create.page) ? await pageAllowed(ctx, create.page) : false;
  const movable = typeof cfg.move === 'string' && cfg.move.trim() !== '' && (await isAuthorized(ctx, cfg.move_authz ?? null));

  const timeRange = (ev: CalEvent) => (ev.time ? `${ev.time}${ev.endTime && (ev.endTime !== ev.time || ev.end !== ev.start) ? `–${ev.endTime}` : ''}` : '');
  const chip = (ev: CalEvent, withTime = true) => {
    const label = withTime && ev.time ? `${ev.time} ${ev.title}` : ev.title;
    const drag = movable && ev.key !== null ? raw(` draggable="true" data-move="${esc(ev.key)}"`) : '';
    const inner = withTime && ev.time ? html`<span class="cal-time">${ev.time}</span> ${ev.title}` : ev.title;
    const cls = `cal-event${ev.time ? ' timed' : ''}`;
    if (!linkOk || !link) return html`<span class="${cls}" title="${label}"${drag}>${inner}</span>`;
    const items = fillItems(link.items, (col) => {
      const v = column(ev.row, col);
      return v === undefined ? undefined : (toState(v) ?? '');
    });
    return html`<a class="${cls}" ${linkAttrs(ctx, link.page, items)} title="${label}"${drag}>${inner}</a>`;
  };
  const addLink = (day: Date, hour: number | null) => {
    if (!createOk || !create) return '';
    const date = iso(day);
    const start = hour === null ? date : `${date} ${pad(hour)}:00`;
    const end = hour === null ? date : hour < 23 ? `${date} ${pad(hour + 1)}:00` : `${iso(addDays(day, 1))} 00:00`;
    const values: Record<string, string> = { start, end, date };
    const items = fillItems(create.items, (col) => values[col.toLowerCase()]);
    const label = hour === null ? t('calendar.add', { date: F.LONG.format(day) }) : t('calendar.add_at', { date: F.LONG.format(day), time: `${pad(hour)}:00` });
    return html`<a class="cal-add" ${linkAttrs(ctx, create.page, items)} aria-label="${label}" title="${label}">+</a>`;
  };
  const cellAttrs = (day: Date, hour: number | null) =>
    raw(`${movable ? ` data-drop="${iso(day)}${hour === null ? '' : `T${pad(hour)}:00`}"` : ''}${createOk ? ' data-add' : ''}`);
  const on = (day: string) => events.filter((ev) => ev.start <= day && ev.end >= day);
  const go = (v: CalendarView, day: Date | null) =>
    regionUrl(ctx, r, (p) => {
      if (v === defaultView(cfg, views)) p.delete(pView);
      else p.set(pView, v);
      p.delete(pMonth);
      p.delete(pDay);
      if (!day) return;
      if (v === 'month' || v === 'list') p.set(pMonth, iso(day).slice(0, 7));
      else p.set(pDay, iso(day));
    });
  const dayLink = (day: Date, label: unknown) => (views.includes('day') ? html`<a href="${go('day', day)}">${label}</a>` : label);

  /** Days with events as a list: the list view, and month and week views on phones. */
  const agenda = (a: Date, b: Date, cls: string) => {
    const out: Raw[] = [];
    for (let d = a; d < b; d = addDays(d, 1)) {
      const key = iso(d);
      const list = on(key);
      if (list.length)
        out.push(html`<li><h3>${dayLink(d, (cls === 'cal-list' ? F.LONG : F.DAY).format(d))}</h3><ul class="cal-agenda-events">${list.map(
          (ev) => html`<li>${ev.time && ev.start === key ? html`<span class="cal-when">${timeRange(ev)}</span>` : ''}${chip(ev, false)}</li>`,
        )}</ul></li>`);
    }
    return html`<ol class="${cls}">${out.length ? out : html`<li class="empty">${t(view === 'month' ? 'calendar.no_events' : 'calendar.no_events_period')}</li>`}</ol>`;
  };

  let body: Raw;
  let title: string;
  let prev: Date;
  let next: Date;
  let prevLabel: string;
  let nextLabel: string;
  if (view === 'week' || view === 'day') {
    const days = Array.from({ length: view === 'week' ? 7 : 1 }, (_, k) => addDays(from, k));
    const keys = days.map(iso);
    // hours shown: config day_start..day_end (default 8–18), widened to fit the events
    const startH = Number.isInteger(cfg.day_start) && cfg.day_start >= 0 && cfg.day_start <= 23 ? (cfg.day_start as number) : 8;
    const endH = Number.isInteger(cfg.day_end) && cfg.day_end > startH && cfg.day_end <= 24 ? (cfg.day_end as number) : Math.max(startH + 1, 18);
    // a timed event shows in its start hour on its first day; on later days (and all-day events) at the top
    const inSlot = (ev: CalEvent, key: string) => ev.time !== null && ev.start === key;
    const hours = events.filter((ev) => keys.some((k) => inSlot(ev, k))).map(hourOf);
    const lo = Math.min(startH, ...hours);
    const hi = Math.max(endH, ...hours.map((h) => h + 1));
    const top = (key: string) => on(key).filter((ev) => !inSlot(ev, key));
    const headers = days.map(
      (d) => html`<th scope="col"${iso(d) === iso(today) ? raw(' class="today"') : ''}>${view === 'week' ? dayLink(d, F.DAY.format(d)) : F.LONG.format(d)}</th>`,
    );
    const allDay = html`<tr class="cal-allday"><th scope="row">${t('calendar.all_day')}</th>${days.map(
      (d) => html`<td${cellAttrs(d, null)}>${addLink(d, null)}${top(iso(d)).map((ev) => chip(ev))}</td>`,
    )}</tr>`;
    const rows: Raw[] = [];
    for (let h = lo; h < hi; h++)
      rows.push(html`<tr><th scope="row" class="cal-hour">${pad(h)}:00</th>${days.map(
        (d) => html`<td${cellAttrs(d, h)}>${addLink(d, h)}${events
          .filter((ev) => inSlot(ev, iso(d)) && hourOf(ev) === h)
          .map((ev) => html`<span class="cal-slot-event">${chip(ev, false)}<span class="cal-when">${timeRange(ev)}</span></span>`)}</td>`,
      )}</tr>`);
    body = html`<div class="table-wrap cal-scroll"><table class="cal-grid cal-${view}">
        <caption class="sr-only">${r.title} ${days.length > 1 ? `${F.RANGE.format(days[0])} – ${F.RANGE.format(days[6])}` : F.LONG.format(days[0])}</caption>
        <thead><tr><th scope="col"><span class="sr-only">${t('calendar.time')}</span></th>${headers}</tr></thead>
        <tbody>${allDay}${rows}</tbody>
      </table></div>
      ${view === 'week' ? agenda(from, to, 'cal-agenda') : ''}`;
    title = view === 'week' ? `${F.RANGE.format(days[0])} – ${F.RANGE.format(days[6])}` : F.LONG.format(anchor);
    const step = view === 'week' ? 7 : 1;
    prev = addDays(from, -step);
    next = addDays(from, step);
    prevLabel = t(view === 'week' ? 'calendar.previous_week' : 'calendar.previous_day');
    nextLabel = t(view === 'week' ? 'calendar.next_week' : 'calendar.next_day');
  } else {
    if (view === 'list') body = agenda(first, nextMonth, 'cal-list');
    else {
      const weeks: Raw[] = [];
      for (let d = from; d < to; d = addDays(d, 7)) {
        const cells = [];
        for (let k = 0; k < 7; k++) {
          const day = addDays(d, k);
          const key = iso(day);
          const list = on(key);
          const outside = day.getUTCMonth() !== first.getUTCMonth();
          const more = list.length - 4;
          const moreText = t('calendar.more', { n: more });
          cells.push(html`<td class="${[outside ? 'outside' : '', key === iso(today) ? 'today' : ''].filter(Boolean).join(' ') || null}"${cellAttrs(day, null)}>
            <span class="cal-day">${day.getUTCDate()}</span>${addLink(day, null)}
            ${list.slice(0, 4).map((ev) => chip(ev))}
            ${more > 0 ? (views.includes('day') ? html`<a class="cal-more" href="${go('day', day)}">${moreText}</a>` : html`<span class="cal-more">${moreText}</span>`) : ''}
          </td>`);
        }
        weeks.push(html`<tr>${cells}</tr>`);
      }
      body = html`<table class="cal-month">
        <caption class="sr-only">${r.title} ${F.MONTHS.format(first)}</caption>
        <thead><tr>${F.WEEKDAYS.map((w) => html`<th scope="col">${w}</th>`)}</tr></thead>
        <tbody>${weeks}</tbody>
      </table>
      ${agenda(first, nextMonth, 'cal-agenda')}`;
    }
    title = F.MONTHS.format(first);
    prev = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() - 1, 1));
    next = nextMonth;
    prevLabel = t('calendar.previous');
    nextLabel = t('calendar.next');
  }

  const nav = (label: string, day: Date | null, aria?: string) =>
    html`<a class="btn" href="${go(view, day)}"${aria ? html` aria-label="${aria}" title="${aria}"` : ''}>${label}</a>`;
  const switcher = views.length > 1
    ? html`<nav class="cal-views buttons" aria-label="${t('calendar.views')}">${views.map(
        (v) => html`<a class="btn${v === view ? ' active' : ''}" href="${go(v, anchor)}"${v === view ? raw(' aria-current="page"') : ''}>${t(`calendar.view_${v}`)}</a>`,
      )}</nav>`
    : '';
  return html`<div class="calendar cal-view-${view}"${movable ? raw(` data-calendar="${r.id}"`) : ''}>
    <div class="cal-toolbar">
      <div class="buttons">${nav('‹', prev, prevLabel)}${nav(t('calendar.today'), null)}${nav('›', next, nextLabel)}</div>
      <h3 class="cal-title" aria-live="polite">${title}</h3>
      ${switcher}
    </div>
    ${movable && view !== 'list' ? html`<p class="cal-hint">${t('calendar.drag_hint')}</p>` : ''}
    <p class="cal-status sr-only" role="status"></p>
    ${body}
  </div>`;
}

// ---------------------------------------------------------------- drag and drop: the server side

/**
 * Move an event of a calendar region to `to` (YYYY-MM-DD or YYYY-MM-DDTHH:MM).
 * The caller has checked the CSRF token, page access and the region's
 * visibility, inside the app's transaction. Throws Forbidden when moving isn't
 * allowed or the event isn't one this user sees, RangeError for a bad target.
 */
export async function moveCalendarEvent(ctx: PageContext, r: Region, key: string, to: string) {
  const t = ctx.locale.t;
  const cfg = r.config as Record<string, any>;
  if (typeof cfg.move !== 'string' || !cfg.move.trim() || !(await isAuthorized(ctx, cfg.move_authz ?? null))) throw new Forbidden(t('calendar.cannot_move'));
  if (!parseTarget(to)) throw new RangeError(t('calendar.bad_target'));
  const keyCol = typeof cfg.key === 'string' && cfg.key ? cfg.key : 'id';
  const c = ctx.client!;
  // the event must be one this user sees in the region (its query, as the app's role, with RLS)
  await resolveRestRegion(ctx, r);
  const src = stripSemicolon(applyBinds(r.source ?? '', bindValues(ctx)));
  const res = await savepoint(c, () => c.query(`select * from (\n${src}\n) "__q" where "__q".${pg.escapeIdentifier(keyCol)}::text = ${literal(key)} limit 2`));
  if (res.rows.length !== 1) throw new Forbidden(t('calendar.cannot_move'));
  const row = res.rows[0];
  const moved = moveEvent(toState(row.start_date) ?? '', toState(row.end_date), to);
  if (!moved) throw new RangeError(t('calendar.bad_target'));
  const sql = stripSemicolon(applyBinds(cfg.move, { ...bindValues(ctx), EVENT_ID: key, NEW_START: moved.start, NEW_END: moved.end }));
  await savepoint(c, () => c.query(sql));
  return { title: toState(row.title) ?? '', start: moved.start };
}
