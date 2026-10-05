import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { root } from '../env.ts';
import { html, type Raw } from '../html.ts';
import { documentShell } from '../layout.ts';
import { loadApp, type App } from '../metadata.ts';
import { runtime } from '../db.ts';
import { appWithLocale, type Req } from './routes.ts';
import { BASE_STYLES, baseStyleOf } from './styles.ts';

// Progressive Web Apps (APEX: Progressive Web App): an application with
// "pwa" on gets, under its own URL (/a/<alias>/):
//   manifest.webmanifest   name, start page, colours, icons (installable)
//   sw.js                  the service worker (public/sw.js, scoped to the app):
//                          the app shell offline, optionally visited pages,
//                          and an offline page
//   icon-192.png, icon-512.png   the uploaded icon, or a generated tile
//   offline                the page shown offline when nothing is cached
// Forms submitted offline are queued on the device by app.js (when
// pwa_offline_submit is on) and sent again later; pages carry a submission
// id so a resend is never processed twice (routes.ts).

const HEX = /^#[0-9a-f]{6}$/i;
export const accentOf = (a: Pick<App, 'theme'>) => (a.theme?.accent && HEX.test(a.theme.accent) ? a.theme.accent : BASE_STYLES[baseStyleOf(a.theme)].accent);
export const headerOf = (a: Pick<App, 'theme'>) => (a.theme?.header && HEX.test(a.theme.header) ? a.theme.header : BASE_STYLES[baseStyleOf(a.theme)].header);

/** <head> additions of an installable app. */
export function pwaHead(a: Pick<App, 'alias' | 'pwa' | 'theme'>): Raw | '' {
  if (!a.pwa) return '';
  const base = `/a/${a.alias}`;
  return html`<link rel="manifest" href="${base}/manifest.webmanifest">
<meta name="theme-color" content="${headerOf(a)}">
<meta name="mobile-web-app-capable" content="yes">
<link rel="apple-touch-icon" href="${base}/icon-192.png">`;
}

/** <body> data attributes app.js uses: register the service worker, queue offline submissions. */
export function pwaBody(a: Pick<App, 'alias' | 'pwa' | 'pwa_offline_submit'>, user: string): Record<string, string> {
  if (!a.pwa) return {};
  return { 'data-sw': `/a/${a.alias}/sw.js`, ...(a.pwa_offline_submit ? { 'data-offline-queue': '1', 'data-user': user } : {}) };
}

// ------------------------------------------------------------------ icons (PNG, no image library)

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32 = (b: Buffer) => {
  let c = 0xffffffff;
  for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** An RGBA image as PNG. */
export function png(width: number, height: number, rgba: Uint8Array) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// 5 × 7 letters and digits: one row per entry, the 5 low bits are the pixels
const FONT: Record<string, number[]> = {
  A: [14, 17, 17, 31, 17, 17, 17], B: [30, 17, 17, 30, 17, 17, 30], C: [14, 17, 16, 16, 16, 17, 14], D: [30, 17, 17, 17, 17, 17, 30],
  E: [31, 16, 16, 30, 16, 16, 31], F: [31, 16, 16, 30, 16, 16, 16], G: [14, 17, 16, 23, 17, 17, 15], H: [17, 17, 17, 31, 17, 17, 17],
  I: [14, 4, 4, 4, 4, 4, 14], J: [7, 2, 2, 2, 2, 18, 12], K: [17, 18, 20, 24, 20, 18, 17], L: [16, 16, 16, 16, 16, 16, 31],
  M: [17, 27, 21, 21, 17, 17, 17], N: [17, 17, 25, 21, 19, 17, 17], O: [14, 17, 17, 17, 17, 17, 14], P: [30, 17, 17, 30, 16, 16, 16],
  Q: [14, 17, 17, 17, 21, 18, 13], R: [30, 17, 17, 30, 20, 18, 17], S: [15, 16, 16, 14, 1, 1, 30], T: [31, 4, 4, 4, 4, 4, 4],
  U: [17, 17, 17, 17, 17, 17, 14], V: [17, 17, 17, 17, 17, 10, 4], W: [17, 17, 17, 21, 21, 21, 10], X: [17, 17, 10, 4, 10, 17, 17],
  Y: [17, 17, 10, 4, 4, 4, 4], Z: [31, 1, 2, 4, 8, 16, 31], 0: [14, 17, 19, 21, 25, 17, 14], 1: [4, 12, 4, 4, 4, 4, 14],
  2: [14, 17, 1, 2, 4, 8, 31], 3: [31, 2, 4, 2, 1, 17, 14], 4: [2, 6, 10, 18, 31, 2, 2], 5: [31, 16, 30, 1, 1, 17, 14],
  6: [6, 8, 16, 30, 17, 17, 14], 7: [31, 1, 2, 4, 8, 8, 8], 8: [14, 17, 17, 14, 17, 17, 14], 9: [14, 17, 17, 15, 1, 2, 12],
};

/** A square tile: the background colour with the first letter or digit of the name in white (maskable: the letter stays in the middle). */
export function letterIcon(name: string, colour: string, size: number) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(colour.slice(i, i + 2), 16));
  const img = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) img.set([r, g, b, 255], i * 4);
  const ch = (name.normalize('NFD').replace(/[^A-Za-z0-9]/g, '')[0] ?? 'A').toUpperCase();
  const glyph = FONT[ch] ?? FONT.A;
  const cell = Math.floor((size * 0.42) / 7); // the letter covers ~42% of the height (inside the maskable safe zone)
  const ox = Math.floor((size - 5 * cell) / 2);
  const oy = Math.floor((size - 7 * cell) / 2);
  for (let row = 0; row < 7; row++)
    for (let col = 0; col < 5; col++)
      if (glyph[row] & (1 << (4 - col)))
        for (let y = 0; y < cell; y++)
          for (let x = 0; x < cell; x++) img.set([255, 255, 255, 255], ((oy + row * cell + y) * size + ox + col * cell + x) * 4);
  return png(size, size, img);
}

const icons = new Map<string, Buffer>(); // generated tiles by name|colour|size

// ------------------------------------------------------------------ routes

const SW = readFileSync(join(root, 'public', 'sw.js'), 'utf8');

export async function pwaRoutes(app: FastifyInstance) {
  const pwaApp = async (alias: string) => {
    const a = await loadApp(alias);
    return a?.pwa ? a : null;
  };

  app.get<{ Params: { alias: string } }>('/a/:alias/manifest.webmanifest', async (req, reply) => {
    const a = await pwaApp(req.params.alias);
    if (!a) return reply.code(404).send('Not found');
    const base = `/a/${a.alias}`;
    return reply
      .type('application/manifest+json')
      .header('cache-control', 'no-cache')
      .send({
        id: `${base}/`,
        name: a.name,
        short_name: a.pwa_short_name || a.name.slice(0, 12),
        start_url: `${base}/${a.home_page}`,
        scope: `${base}/`,
        display: 'standalone',
        orientation: 'any',
        lang: a.language,
        theme_color: headerOf(a),
        background_color: '#ffffff',
        icons: [
          { src: `${base}/icon-192.png`, sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: `${base}/icon-512.png`, sizes: '512x512', type: 'image/png', purpose: 'any' },
          ...(a.pwa_has_icon ? [] : [{ src: `${base}/icon-512.png`, sizes: '512x512', type: 'image/png', purpose: 'maskable' }]),
        ],
      });
  });

  const icon = (size: 192 | 512) => async (req: { params: { alias: string } }, reply: import('fastify').FastifyReply) => {
    const a = await pwaApp(req.params.alias);
    if (!a) return reply.code(404).send('Not found');
    let body: Buffer;
    if (a.pwa_has_icon) {
      body = (await runtime.one<{ pwa_icon: Buffer }>('select pwa_icon from meta.app where id = $1', [a.id]))!.pwa_icon;
    } else {
      const k = `${a.name}|${accentOf(a)}|${size}`;
      if (!icons.has(k)) icons.set(k, letterIcon(a.name, accentOf(a), size));
      body = icons.get(k)!;
    }
    return reply.type('image/png').header('cache-control', 'public, max-age=3600').send(body);
  };
  app.get<{ Params: { alias: string } }>('/a/:alias/icon-192.png', icon(192));
  app.get<{ Params: { alias: string } }>('/a/:alias/icon-512.png', icon(512));

  app.get<{ Params: { alias: string } }>('/a/:alias/sw.js', async (req, reply) => {
    const a = await pwaApp(req.params.alias);
    if (!a) return reply.code(404).send('// not an installable application');
    const base = `/a/${a.alias}`;
    // the settings the worker needs, as a JSON literal (no user input in it)
    const config = JSON.stringify({ base, offlinePages: a.pwa_offline_pages, offlineSubmit: a.pwa_offline_submit, version: SW_VERSION });
    return reply
      .type('text/javascript; charset=utf-8')
      .header('cache-control', 'no-cache')
      .header('service-worker-allowed', `${base}/`)
      .send(`const PGAPEX = ${config};\n${SW}`);
  });

  app.get<{ Params: { alias: string } }>('/a/:alias/offline', async (req, reply) => {
    const loaded = await appWithLocale(req as unknown as Req, req.params.alias);
    if (!loaded || !loaded.app.pwa) return reply.code(404).send('Not found');
    const { app: a, locale } = loaded;
    const t = locale.t;
    return reply
      .type('text/html')
      .header('cache-control', 'no-cache')
      .send(
        documentShell(
          `${t('pwa.offline_title')} · ${a.name}`,
          html`<main class="login"><div class="login-card">
            <h1>${t('pwa.offline_title')}</h1>
            <p>${t('pwa.offline_text')}</p>
            <ul class="offline-pages" data-offline-pages></ul>
            <p><a class="btn btn-hot" href="/a/${a.alias}/${a.home_page}">${t('pwa.try_again')}</a></p>
          </div></main>`,
          'login-body',
          {},
          pwaHead(a),
          { lang: locale.lang },
        ),
      );
  });
}

// changes whenever pgapex's static files change (a new service worker then replaces the old one)
const SW_VERSION = (() => {
  let h = 0;
  for (const f of ['public/app.css', 'public/app.js', 'public/icons.svg', 'public/sw.js'])
    for (const ch of readFileSync(join(root, f), 'utf8')) h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0;
  return (h >>> 0).toString(36);
})();

