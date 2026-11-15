// (sprint 202, AX-2) A region's settings forms (the Page Designer's Attributes tab) are part of the property editor's
// one form: the toolbar's Save (and Ctrl+S) sends the region's properties and its settings together.
//
// Each settings form is still written as a form of its own (report-settings.ts, region-settings.ts, templates.ts,
// assistant.ts, reporter.ts, form-designer.ts) with its own route, which the API, tests and older pages post to.
// embedSettings() turns such a form into a group of the property editor's form: its <form> becomes a <div> (the forms
// have no Save button of their own: the toolbar's Save is the only one), and every control joins the property editor's form through the form attribute under the name
// "<key>:<name>", the key being the last part of the form's action (report-settings, column-templates, …). The
// component route takes the posted body apart again (settingsBodies) and calls each form's saver.
import type { FastifyReply } from 'fastify';
import { html, raw, type Raw } from '../html.ts';
import type { Session } from '../session.ts';
import { back, BASE, developer, flash, type Req } from './ui.ts';

export type Body = Record<string, string | undefined>;

/** What a settings form's save did: the message to show (an error when error is true). */
export interface SettingsSaved { message: string; error?: boolean }
/** Saves one settings form of region rid on page pid; null when there is no such region (of the form's type). */
export type SettingsSaver = (pid: string, rid: string, body: Body, s: Session) => Promise<SettingsSaved | null>;

/** A settings form's own route: the saver, then its message and back to the region in the Page Designer. */
export async function settingsRoute(req: Req, reply: FastifyReply, saver: SettingsSaver) {
  const s = await developer(req, reply);
  if (!s) return;
  const { pid, rid } = req.params as { pid: string; rid: string };
  const saved = await saver(pid, rid, (req.body ?? {}) as Body, s);
  if (!saved) return reply.code(404).send('Not found');
  flash(s, saved.message, saved.error ? 'error' : 'ok');
  return back(reply, s, `${BASE}/pages/${pid}?c=region-${rid}`);
}

const ATTR = String.raw`\s+[a-zA-Z_:@][-a-zA-Z0-9_:.]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>\x60]+))?`;
const FORM_OPEN = new RegExp(String.raw`<form method="post" action="[^"]*/region/\d+/([a-z-]+)"[^>]*>`, 'g');
const CONTROL = new RegExp(String.raw`<(input|select|textarea|button)((?:${ATTR})*)(\s*/?)>`, 'g');
const CSRF = /<input type="hidden" name="__csrf" value="[^"]*">/g;

/**
 * The settings forms of a region (one or more <form>s posting to /pages/:pid/region/:rid/<key>) as part of the form
 * `formId`. `type` is the region's type when the page was drawn: settings sent for another type (the Type was changed
 * in the same Save) are not saved.
 */
export function embedSettings(forms: Raw | '', formId: string, type: string): Raw | '' {
  const text = String(forms);
  if (!text) return '';
  let out = '';
  let at = 0;
  for (const m of text.matchAll(FORM_OPEN)) {
    const key = m[1];
    const start = m.index!;
    const end = text.indexOf('</form>', start);
    if (end < 0) break;
    out += text.slice(at, start);
    const body = text.slice(start + m[0].length, end).replace(CSRF, '')
      .replace(CONTROL, (tag, name: string, attrs: string, close: string) => {
        if (/\sform=/.test(attrs)) return tag;
        const named = attrs.replace(/(\sname=")([^"]*)"/, (_x, pre: string, n: string) => `${pre}${key}:${n}"`);
        return named === attrs ? tag : `<${name}${named} form="${formId}"${close}>`;
      });
    out += String(html`<div class="component-form pd-settings" data-settings="${key}"><input type="hidden" name="__settings" value="${key}" form="${formId}">`) + body + '</div>';
    at = end + '</form>'.length;
  }
  out += text.slice(at);
  return raw(`${String(html`<input type="hidden" name="__region_type" value="${type}" form="${formId}">`)}${out}`);
}

/** The bodies of the settings forms in a posted property editor form: key → its fields (names without "<key>:"). */
export function settingsBodies(body: Record<string, unknown>): Map<string, Body> {
  const keys = new Set(([] as unknown[]).concat(body.__settings ?? []).filter((k): k is string => typeof k === 'string' && /^[a-z-]{1,40}$/.test(k)));
  const out = new Map<string, Body>();
  for (const key of keys) {
    const sub: Body = {};
    for (const [k, v] of Object.entries(body)) if (k.startsWith(`${key}:`)) sub[k.slice(key.length + 1)] = v as string | undefined;
    out.set(key, sub);
  }
  return out;
}
