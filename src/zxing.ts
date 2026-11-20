import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';

// (sprint 239, MG-4) The barcode decoder for browsers without BarcodeDetector (Safari on iOS and macOS, Firefox,
// Chrome on desktop): zxing-wasm (MIT; ZXing-C++, Apache-2.0) from its own package, never a CDN. Two files are served:
// the reader's script (an IIFE that defines window.ZXingWASM) and its WebAssembly binary. app.js loads them only when
// someone presses a scan button and the browser has no BarcodeDetector; pages with a scan item allow the compile in
// their Content-Security-Policy ('wasm-unsafe-eval', src/security.ts).

const DIST = join(dirname(createRequire(import.meta.url).resolve('zxing-wasm/reader')), '..', '..');
export const ZXING_VERSION: string = JSON.parse(readFileSync(join(DIST, '..', 'package.json'), 'utf8')).version;
/** The decoder's URLs (with the package version, so a cached copy is never stale). */
export const ZXING_SCRIPT = `/static/vendor/zxing/reader.js?v=${ZXING_VERSION}`;
export const ZXING_WASM = `/static/vendor/zxing/zxing_reader.wasm?v=${ZXING_VERSION}`;

const FILES: Record<string, [string, string]> = {
  'reader.js': [join(DIST, 'iife', 'reader', 'index.js'), 'text/javascript; charset=utf-8'],
  'zxing_reader.wasm': [join(DIST, 'reader', 'zxing_reader.wasm'), 'application/wasm'],
};
const cache = new Map<string, Buffer>();

export function zxingRoutes(app: FastifyInstance) {
  app.get<{ Params: { file: string } }>('/static/vendor/zxing/:file', async (req, reply) => {
    const f = Object.hasOwn(FILES, req.params.file) ? FILES[req.params.file] : undefined;
    if (!f) return reply.code(404).type('text/plain').send('Not found');
    let body = cache.get(req.params.file);
    if (!body) cache.set(req.params.file, (body = readFileSync(f[0])));
    return reply.header('cache-control', 'public, max-age=31536000, immutable').type(f[1]).send(body);
  });
}
