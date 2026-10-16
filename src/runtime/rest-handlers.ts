import type pg from 'pg';
import { substitute, type BindValues } from '../binds.ts';

// (sprint 104, Database Actions DA-11 part 2; migration 117) The handler source types REST modules gained with
// SQL Workshop › RESTful Services, next to collection, item and sql (rest.ts):
//
//   plpgsql  a PL/pgSQL block run as an anonymous DO block as the application's role. A DO block takes no
//            parameters, so the binds go in as transaction-local settings, set with query parameters (never part
//            of the SQL text), and :NAME in the block becomes meta.rest_param('NAME'). The block answers with
//            meta.rest_reply(body jsonb, status int); without a reply: 204.
//   media    a query whose first row has content_type and content (bytea or text), optional filename: the
//            response is that content. It is served sandboxed (CSP sandbox, nosniff), so an HTML or SVG
//            "image" from the table can't run script in the application's origin.

/** Bind names a PL/pgSQL handler can read (a setting name each): letters, digits and _. */
const BIND_NAME = /^[A-Z_][A-Z0-9_]{0,62}$/;
/** The dollar-quote tag around a PL/pgSQL handler's block. */
export const DO_TAG = '$pgkiln_rest$';
/** At most this many binds go into settings (a body with thousands of fields is not a handler's input). */
const MAX_BINDS = 200;

export class HandlerInputError extends Error {}

/** The DO statement of a PL/pgSQL handler: its binds as meta.rest_param('NAME'), wrapped in begin … end if needed. */
export function plpgsqlBlock(source: string): string {
  if (source.includes(DO_TAG)) throw new Error(`A PL/pgSQL handler may not contain ${DO_TAG}.`);
  let body = substitute(source.trim().replace(/;+\s*$/, ''), (name) => `meta.rest_param('${name}')`);
  if (!/^(declare|begin|<<)/i.test(body.replace(/^(\s*(--[^\n]*(\n|$)|\/\*[\s\S]*?\*\/))*\s*/, ''))) body = `begin\n${body};\nend`;
  return `do ${DO_TAG}\n${body}\n${DO_TAG}`;
}

/** Set the binds as transaction-local settings pgkiln_bind.<name>, as query parameters. */
export async function setBinds(c: pg.PoolClient, binds: BindValues) {
  const entries = Object.entries(binds).filter(([k]) => BIND_NAME.test(k)).slice(0, MAX_BINDS);
  for (const [, v] of entries) if (typeof v === 'string' && v.includes('\0')) throw new HandlerInputError('A parameter contains a NUL byte.');
  if (!entries.length) return;
  await c.query(`select set_config('pgkiln_bind.' || lower(k), coalesce(v, ''), true) from unnest($1::text[], $2::text[]) as b(k, v)`,
    [entries.map(([k]) => k), entries.map(([, v]) => v ?? null)]);
}

/** Run a PL/pgSQL handler; its reply (meta.rest_reply) or none. */
export async function runPlpgsql(c: pg.PoolClient, source: string): Promise<{ body: unknown; status: number | null }> {
  // a reply from an earlier statement of this transaction must not leak into this one
  await c.query(`select set_config('pgkiln_rest.body', '', true), set_config('pgkiln_rest.status', '', true)`);
  await c.query(plpgsqlBlock(source));
  const r = (await c.query(`select current_setting('pgkiln_rest.body', true) as body, current_setting('pgkiln_rest.status', true) as status`)).rows[0];
  return { body: r.body ? JSON.parse(r.body) : undefined, status: r.status ? Number(r.status) : null };
}

/** A content type safe to send as a header: type/subtype with optional parameters, no line breaks. */
export function safeContentType(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : '';
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(\s*;\s*[a-z0-9_-]+=("[^"\r\n]*"|[^;\s\r\n]+))*$/i.test(s) && s.length <= 200 ? s : 'application/octet-stream';
}

/** A file name for Content-Disposition: printable ASCII without quotes, slashes or backslashes. */
export const safeFilename = (v: unknown) => (typeof v === 'string' ? v.replace(/[^\x20-\x7e]|["\\/;]/g, '_').slice(0, 200) : '');

/** The response of a media handler's row. */
export function mediaResponse(row: Record<string, unknown>) {
  if (!('content' in row) || !('content_type' in row)) throw new Error('A media handler\'s query returns the columns content_type and content (and optionally filename).');
  const c = row.content;
  const body = c === null || c === undefined ? Buffer.alloc(0) : Buffer.isBuffer(c) ? c : Buffer.from(typeof c === 'string' ? c : JSON.stringify(c));
  const name = safeFilename(row.filename);
  return {
    body,
    headers: {
      'content-type': safeContentType(row.content_type),
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox",
      'cache-control': 'no-store',
      ...(name ? { 'content-disposition': `inline; filename="${name}"` } : {}),
    } as Record<string, string>,
  };
}
