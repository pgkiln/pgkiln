import { html, type Raw } from '../html.ts';
import { checksumValid, signText } from '../security.ts';
import { browserSpans } from './export.ts';
import { currentCtx, now, SPAN_KIND, type Span } from './trace.ts';

// (sprint 139, AP-6) Browser spans: a page whose trace is sent carries a signed
// <meta name="pgkiln-trace"> (layout.ts); app.js reports the page load and the
// page's Ajax calls to POST /a/:alias/telemetry (src/telemetry/http.ts), and
// relay() turns them into spans of the page's trace. The token is bound to the
// trace, the page's span, the time and the application, and is good for 30
// minutes and 200 spans. No collector address or token reaches the browser.

const TOKEN_MINUTES = 30;
const MAX_PER_TOKEN = 200;
const used = new Map<string, number>();
let usedSince = Date.now();

/** The page's <meta> for browser spans: its trace, span, time and a signature (empty when not wanted). */
export function browserTraceMeta(): Raw | '' {
  const ctx = currentCtx();
  if (!ctx?.trace.browser || !ctx.trace.sampled || !ctx.trace.alias) return '';
  const root = ctx.trace.spans[0];
  const ts = Math.floor(Date.now() / 1000);
  const payload = `${root.traceId}.${root.spanId}.${ts}`;
  return html`<meta name="pgkiln-trace" content="${payload}.${signText('otel-browser', `${payload}.${ctx.trace.alias.toLowerCase()}`)}">`;
}

interface BrowserSpan {
  k?: unknown;
  path?: unknown;
  method?: unknown;
  status?: unknown;
  start?: unknown;
  dur?: unknown;
  t?: Record<string, unknown>;
}

const num = (v: unknown, max: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(v, 0), max) : null);

/** Check a page's token and turn its reports into spans. Returns the number kept, or null for a bad token. */
export function relay(alias: string, token: unknown, spans: unknown): number | null {
  const m = typeof token === 'string' ? /^([0-9a-f]{32})\.([0-9a-f]{16})\.(\d{1,12})\.([\w-]{22})$/.exec(token) : null;
  if (!m) return null;
  const [, traceId, spanId, ts, sig] = m;
  if (!checksumValid(signText('otel-browser', `${traceId}.${spanId}.${ts}.${alias.toLowerCase()}`), sig)) return null;
  if (Date.now() / 1000 - Number(ts) > TOKEN_MINUTES * 60) return null;
  if (Date.now() - usedSince > 3_600_000) {
    used.clear();
    usedSince = Date.now();
  }
  const list = Array.isArray(spans) ? (spans as BrowserSpan[]).slice(0, 50) : [];
  const room = MAX_PER_TOKEN - (used.get(`${traceId}.${spanId}`) ?? 0);
  if (room <= 0 || !list.length) return 0;
  const prefix = `/a/${alias}/`.toLowerCase();
  const out: Span[] = [];
  const t = now();
  for (const b of list.slice(0, room)) {
    const dur = num(b.dur, 600_000);
    const start = num(b.start, 8.64e15);
    if (dur === null || start === null || Math.abs(start - t) > 3_600_000) continue;
    const path = typeof b.path === 'string' ? b.path.split('#')[0] : '';
    const [p, query] = path.split('?');
    const s: Span = {
      traceId, spanId: '', parentId: spanId, kind: SPAN_KIND.client, start, end: start + dur, name: '', attrs: { 'pgkiln.browser': true },
    };
    if (b.k === 'load') {
      s.kind = SPAN_KIND.internal;
      s.name = 'browser page load';
      for (const k of ['ttfb', 'dom_interactive', 'dom_complete', 'load']) {
        const v = num(b.t?.[k], 600_000);
        if (v !== null) s.attrs[`pgkiln.browser.${k}_ms`] = Math.round(v);
      }
    } else if (b.k === 'ajax' && p.toLowerCase().startsWith(prefix) && p.length <= 500) {
      const method = typeof b.method === 'string' && /^(GET|POST|PUT|PATCH|DELETE)$/.test(b.method) ? b.method : 'GET';
      s.name = `browser ${method}`;
      s.attrs['http.request.method'] = method;
      s.attrs['url.path'] = p;
      const st = num(b.status, 599);
      if (st !== null) {
        s.attrs['http.response.status_code'] = Math.round(st);
        if (st >= 500 || st === 0) s.error = st ? `HTTP ${Math.round(st)}` : 'network error';
      }
      if (query) s.vals = { 'url.query': query.slice(0, 2000) };
    } else continue;
    out.push(s);
  }
  used.set(`${traceId}.${spanId}`, MAX_PER_TOKEN - room + out.length);
  if (out.length) browserSpans(traceId, alias, out);
  return out.length;
}

