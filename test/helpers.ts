import type { FastifyInstance } from 'fastify';

/** A tiny cookie-keeping browser on top of fastify.inject. */
export class Browser {
  cookies = new Map<string, string>();
  lastCsrf = '';
  constructor(readonly app: FastifyInstance, readonly headers: Record<string, string> = {}) {}

  async request(method: 'GET' | 'POST', url: string, form?: Record<string, string>) {
    const res = await this.app.inject({
      method,
      url,
      payload: form ? new URLSearchParams(form).toString() : undefined,
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
  post(url: string, form: Record<string, string>) {
    return this.request('POST', url, form);
  }
  /** POST with the CSRF token of the last page. */
  submit(url: string, form: Record<string, string>) {
    return this.request('POST', url, { __csrf: this.lastCsrf, ...form });
  }
  async login(user: string, password = user, alias = 'hr') {
    await this.get(`/a/${alias}/login`);
    return this.post(`/a/${alias}/login`, { __csrf: this.lastCsrf, username: user, password });
  }
}
