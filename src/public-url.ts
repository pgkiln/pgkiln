// (sprint 250, MG-25; migration 206) The installation's public address for absolute URLs built in SQL
// (meta.page_url(…, p_absolute => true), meta.app_url()). The server records it at start-up in
// meta.instance_setting 'public_url' from PUBLIC_URL (else the same fallback as single sign-on,
// http://127.0.0.1:<PORT>), so SQL that runs outside a request (automations, workflows, pg_cron) has
// it too. Never from a request's Host header; application code can't change it (owner only).
import { owner } from './db.ts';

/** The address the server records: PUBLIC_URL without a trailing slash, query or fragment, or the fallback. */
export function publicUrlToRecord(env = process.env): string {
  const raw = (env.PUBLIC_URL ?? '').trim();
  if (raw && URL.canParse(raw)) {
    const u = new URL(raw);
    if (u.protocol === 'https:' || u.protocol === 'http:') return `${u.origin}${u.pathname}`.replace(/\/+$/, '');
  }
  if (raw) console.warn(`pgkiln: PUBLIC_URL (${raw}) is not an http(s) address: absolute URLs use http://127.0.0.1:${env.PORT ?? 3100}.`);
  return `http://127.0.0.1:${env.PORT ?? 3100}`;
}

/** Record the public address for meta.public_url() (at start-up). */
export async function recordPublicUrl(url = publicUrlToRecord()) {
  await owner.query(
    `insert into meta.instance_setting (name, value) values ('public_url', $1)
     on conflict (name) do update set value = excluded.value where meta.instance_setting.value is distinct from excluded.value`, [url]);
  return url;
}
