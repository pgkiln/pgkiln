// Static application files (migration 068; APEX: Static Application Files).
// A developer uploads JavaScript, CSS, JSON, images and fonts to an
// application; they are served at /a/<alias>/static/<name> from the
// application's own origin, so the Content-Security-Policy can stay
// script-src 'self': a page loads them with <script src> and <link>, never
// inline. HTML (and anything else a browser would run as a document) is
// refused by the database and by the type list below, and SVG is served
// with a policy of its own so a script in it never runs.
import type { FastifyInstance } from 'fastify';
import { html } from '../html.ts';
import { runtime } from '../db.ts';
import { loadApp } from '../metadata.ts';
import type { PageContext } from './context.ts';
import { pluginsOnPage } from './plugins.ts';

/** The file types an application may have, by extension. */
export const STATIC_TYPES: Record<string, string> = {
  js: 'text/javascript', mjs: 'text/javascript', css: 'text/css', json: 'application/json', map: 'application/json',
  txt: 'text/plain', csv: 'text/csv', md: 'text/markdown',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  svg: 'image/svg+xml', ico: 'image/x-icon',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  pdf: 'application/pdf', mp3: 'audio/mpeg', mp4: 'video/mp4', webm: 'video/webm',
};

/** The most a file may hold (the database checks it as well). */
export const STATIC_MAX = 5 * 1024 * 1024;

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;

/** The type of a file name, or null when the name or its extension is not allowed. */
export function staticType(name: string) {
  if (!NAME.test(name) || name.includes('..')) return null;
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  return name.includes('.') ? (STATIC_TYPES[ext] ?? null) : null;
}

/** Whether a page can load the file itself (a script or a stylesheet). */
export const includable = (name: string) => /\.(m?js|css)$/i.test(name);

/** The <script> and <link> tags for the application's and the page's included files. */
export function staticHead(ctx: PageContext) {
  // the plug-ins' files (at their version) after the application's, then the page's
  const version = new Map<string, number>((ctx.app.static_files ?? []).map((f) => [f.name, f.v]));
  const pluginFiles = pluginsOnPage(ctx).flatMap((p) => p.files.filter((n) => version.has(n)).map((name) => ({ name, v: version.get(name)! })));
  const files = [...(ctx.app.static_includes ?? []), ...pluginFiles, ...(ctx.page.static_includes ?? [])];
  const seen = new Set<string>();
  return files
    .filter((f) => includable(f.name) && !seen.has(f.name) && seen.add(f.name))
    .map((f) => {
      const src = `${ctx.base}/static/${encodeURIComponent(f.name)}?v=${f.v}`;
      return /\.css$/i.test(f.name) ? html`<link rel="stylesheet" href="${src}">` : html`<script src="${src}" defer></script>`;
    });
}

export async function staticFileRoutes(app: FastifyInstance) {
  app.get<{ Params: { alias: string; name: string }; Querystring: { v?: string } }>('/a/:alias/static/:name', async (req, reply) => {
    const type = staticType(req.params.name);
    const a = type ? await loadApp(req.params.alias) : null;
    const f = a
      ? await runtime.one<{ content: Buffer; v: string }>('select content, floor(extract(epoch from updated_at) * 1000)::bigint::text as v from meta.static_file where app_id = $1 and name = $2', [a.id, req.params.name])
      : null;
    if (!f) return reply.code(404).type('text/plain').send('Not found');
    const etag = `"${Number(f.v).toString(36)}"`;
    reply
      .type(type!.startsWith('text/') ? `${type}; charset=utf-8` : type!)
      .header('etag', etag)
      // a versioned link (?v=…, as pages write them) never changes; a bare one is checked again
      .header('cache-control', req.query.v ? 'public, max-age=31536000, immutable' : 'no-cache');
    // opened on its own, an SVG or PDF is a document: no scripts, no requests
    if (type === 'image/svg+xml' || type === 'application/pdf')
      reply.header('content-security-policy', `default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'${type === 'image/svg+xml' ? '; sandbox' : ''}`);
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();
    return reply.send(f.content);
  });
}
