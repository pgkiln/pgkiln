import { applyBinds, literal } from '../binds.ts';
import { savepoint } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import type { Region } from '../metadata.ts';
import { pageAllowed } from './authz.ts';
import { bindValues, publicError, stripSemicolon, toState, type PageContext } from './context.ts';
import { linkAttrs } from './links.ts';
import { regionUrl } from './report.ts';

// Calendar region (APEX's Calendar): the SELECT returns start_date,
// optional end_date, title, and any columns referenced in config.link:
//   select hiredate as start_date, ename as title, empno from hr.emp
//   config: {"link": {"page": 3, "items": {"P3_EMPNO": "#empno#"}}}
// Month view on tablets and desktops; an agenda list on phones.
// The month is ?r<id>_m=YYYY-MM.

function formats(lang: string) {
  const make = (l: string) => ({
    MONTHS: new Intl.DateTimeFormat(l, { month: 'long', year: 'numeric', timeZone: 'UTC' }),
    DAY: new Intl.DateTimeFormat(l, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }),
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

interface CalEvent {
  start: string;
  end: string;
  title: string;
  row: Record<string, unknown>;
}

export async function renderCalendar(ctx: PageContext, r: Region): Promise<Raw> {
  const { MONTHS, DAY, WEEKDAYS } = formats(ctx.locale.lang);
  const t = ctx.locale.t;
  const param = `r${r.id}_m`;
  const m = /^(\d{4})-(\d{2})$/.exec(ctx.params.get(param) ?? '');
  const today = new Date();
  const first = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1)) : new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const next = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 1));
  const prev = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() - 1, 1));
  const gridStart = addDays(first, -((first.getUTCDay() + 6) % 7)); // Monday on or before the 1st
  const gridEnd = addDays(next, (7 - ((next.getUTCDay() + 6) % 7)) % 7);

  let events: CalEvent[];
  try {
    const src = stripSemicolon(applyBinds(r.source ?? '', bindValues(ctx)));
    const c = ctx.client!;
    const res = await savepoint(c, () =>
      c.query(
        `select * from (\n${src}\n) "__q"
          where "__q".start_date < ${literal(iso(gridEnd))}::date
            and coalesce("__q".end_date, "__q".start_date) >= ${literal(iso(gridStart))}::date
          order by "__q".start_date limit 2000`,
      ),
    );
    events = res.rows.map((row) => {
      const start = (toState(row.start_date) ?? '').slice(0, 10);
      const end = (toState(row.end_date) ?? '').slice(0, 10) || start;
      return { start, end: end < start ? start : end, title: toState(row.title) ?? '', row };
    });
  } catch (e) {
    return html`<div class="alert alert-error" role="alert">${await publicError(ctx, e, `calendar "${r.title ?? r.id}"`)}</div>`;
  }

  const link = r.config.link as { page: number; items?: Record<string, string> } | undefined;
  const linkOk = link ? await pageAllowed(ctx, link.page) : false;
  const chip = (ev: CalEvent) => {
    if (!linkOk || !link) return html`<span class="cal-event" title="${ev.title}">${ev.title}</span>`;
    const items: Record<string, string> = {};
    for (const [k, v] of Object.entries(link.items ?? {}))
      items[k] = v.replace(/#([A-Za-z0-9_]+)#/g, (mm, col: string) => {
        const key = Object.keys(ev.row).find((x) => x.toLowerCase() === col.toLowerCase());
        return key === undefined ? mm : (toState(ev.row[key]) ?? '');
      });
    return html`<a class="cal-event" ${linkAttrs(ctx, link.page, items)} title="${ev.title}">${ev.title}</a>`;
  };
  const on = (day: string) => events.filter((ev) => ev.start <= day && ev.end >= day);

  const weeks: Raw[] = [];
  for (let d = gridStart; d < gridEnd; d = addDays(d, 7)) {
    const days = [];
    for (let k = 0; k < 7; k++) {
      const day = addDays(d, k);
      const key = iso(day);
      const list = on(key);
      const outside = day.getUTCMonth() !== first.getUTCMonth();
      days.push(html`<td class="${[outside ? 'outside' : '', key === iso(today) ? 'today' : ''].filter(Boolean).join(' ') || null}">
        <span class="cal-day">${day.getUTCDate()}</span>
        ${list.slice(0, 4).map(chip)}
        ${list.length > 4 ? html`<span class="cal-more">+${list.length - 4} more</span>` : ''}
      </td>`);
    }
    weeks.push(html`<tr>${days}</tr>`);
  }

  // agenda (phones): only days of this month that have events
  const agenda: Raw[] = [];
  for (let d = first; d < next; d = addDays(d, 1)) {
    const list = on(iso(d));
    if (list.length) agenda.push(html`<li><h3>${DAY.format(d)}</h3><div class="cal-agenda-events">${list.map(chip)}</div></li>`);
  }

  const nav = (label: string, to: Date | null, cls = 'btn') =>
    html`<a class="${cls}" href="${regionUrl(ctx, r, (p) => (to ? p.set(param, iso(to).slice(0, 7)) : p.delete(param)))}">${label}</a>`;
  return html`<div class="calendar">
    <div class="cal-toolbar">
      <div class="buttons">${nav('‹', prev)}${nav(t('calendar.today'), null)}${nav('›', next)}</div>
      <h3 class="cal-title" aria-live="polite">${MONTHS.format(first)}</h3>
    </div>
    <table class="cal-month">
      <caption class="sr-only">${r.title} ${MONTHS.format(first)}</caption>
      <thead><tr>${WEEKDAYS.map((w) => html`<th scope="col">${w}</th>`)}</tr></thead>
      <tbody>${weeks}</tbody>
    </table>
    <ol class="cal-agenda">${agenda.length ? agenda : html`<li class="empty">${t('calendar.no_events')}</li>`}</ol>
  </div>`;
}
