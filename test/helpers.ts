import { inflateSync } from 'node:zlib';
import type { FastifyInstance } from 'fastify';

/** A tiny cookie-keeping browser on top of fastify.inject. */
export class Browser {
  cookies = new Map<string, string>();
  lastCsrf = '';
  constructor(readonly app: FastifyInstance, readonly headers: Record<string, string> = {}) {}

  async request(method: 'GET' | 'POST', url: string, form?: Record<string, string | string[]>) {
    // an array posts the field once per value (checkboxes with one name)
    const payload = form ? new URLSearchParams(Object.entries(form).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : [[k, v]]))).toString() : undefined;
    const res = await this.app.inject({
      method,
      url,
      payload,
      headers: {
        ...this.headers,
        cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
        ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
    });
    for (const c of res.cookies as { name: string; value: string; expires?: Date }[]) {
      if (!c.value || (c.expires && c.expires.getTime() < Date.now())) this.cookies.delete(c.name);
      else this.cookies.set(c.name, c.value);
    }
    const m = /name="__csrf" value="([^"]+)"/.exec(res.body);
    if (m) this.lastCsrf = m[1];
    return res;
  }
  get(url: string) {
    return this.request('GET', url);
  }
  post(url: string, form: Record<string, string | string[]>) {
    return this.request('POST', url, form);
  }
  /** POST with the CSRF token of the last page. */
  submit(url: string, form: Record<string, string | string[]>) {
    return this.request('POST', url, { __csrf: this.lastCsrf, ...form });
  }
  /** POST multipart/form-data (file items) with the CSRF token of the last page. */
  async upload(url: string, form: Record<string, string>, files: Record<string, { name: string; type: string; data: Buffer }>) {
    const fd = new FormData();
    fd.set('__csrf', this.lastCsrf);
    for (const [k, v] of Object.entries(form)) fd.set(k, v);
    for (const [k, f] of Object.entries(files)) fd.set(k, new Blob([new Uint8Array(f.data)], { type: f.type }), f.name);
    const body = new Response(fd);
    const payload = Buffer.from(await body.arrayBuffer());
    const res = await this.app.inject({
      method: 'POST',
      url,
      payload,
      headers: {
        ...this.headers,
        cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
        'content-type': body.headers.get('content-type')!,
      },
    });
    const m = /name="__csrf" value="([^"]+)"/.exec(res.body);
    if (m) this.lastCsrf = m[1];
    return res;
  }
  async login(user: string, password = user, alias = 'hr') {
    await this.get(`/a/${alias}/login`);
    return this.post(`/a/${alias}/login`, { __csrf: this.lastCsrf, username: user, password });
  }
}

/** The text drawn in a PDF made by pdfkit with a standard font (hex strings in TJ operators). */
export function pdfText(pdf: Buffer) {
  let text = '';
  const raw = pdf.toString('latin1');
  for (const m of raw.matchAll(/stream\r?\n/g)) {
    const start = m.index! + m[0].length;
    const end = raw.indexOf('endstream', start);
    let content: string;
    try {
      content = inflateSync(pdf.subarray(start, end)).toString('latin1');
    } catch {
      continue;
    }
    for (const s of content.matchAll(/<([0-9a-f]+)>/gi)) text += Buffer.from(s[1], 'hex').toString('latin1');
    text += '\n';
  }
  return text;
}
