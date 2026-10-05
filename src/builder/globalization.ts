import type { FastifyInstance } from 'fastify';
import { owner } from '../db.ts';
import { html, raw } from '../html.ts';
import { baseLanguage, BUILTIN_LANGUAGES, LANGUAGE_NAMES } from '../i18n.ts';
import { clearLocaleCache, translatableTexts } from '../runtime/locale.ts';
import { appHeader, back, BASE, csrf, developer, flash, input, region, select, send, shell, type Req } from './ui.ts';

// Shared Components → Globalization (APEX: Translate Application, Text
// Messages). Translations live in the application itself: one text in the
// primary language → one text per translated language, exported and
// imported as XLIFF 1.2 (like APEX) or CSV.

const langName = (l: string) => `${LANGUAGE_NAMES[baseLanguage(l)] ?? l} (${l})`;

// ------------------------------------------------------------------ XLIFF and CSV

const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const xmlUnescape = (s: string) =>
  s.replace(/&(lt|gt|quot|apos|amp|#\d+|#x[0-9a-f]+);/gi, (m, e: string) =>
    e === 'lt' ? '<' : e === 'gt' ? '>' : e === 'quot' ? '"' : e === 'apos' ? "'" : e === 'amp' ? '&'
    : e[1].toLowerCase() === 'x' ? String.fromCodePoint(parseInt(e.slice(2), 16)) : String.fromCodePoint(Number(e.slice(1))));

export function toXliff(alias: string, source: string, target: string, rows: { text: string; places: string; target?: string }[]) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2">
  <file original="${xmlEscape(alias)}" source-language="${xmlEscape(source)}" target-language="${xmlEscape(target)}" datatype="plaintext">
    <body>
${rows.map((r, i) => `      <trans-unit id="${i + 1}">
        <source>${xmlEscape(r.text)}</source>
        <target>${xmlEscape(r.target ?? '')}</target>
        <note>${xmlEscape(r.places)}</note>
      </trans-unit>`).join('\n')}
    </body>
  </file>
</xliff>
`;
}

export function fromXliff(doc: string) {
  const lang = /target-language="([^"]*)"/.exec(doc)?.[1];
  const pairs: [string, string][] = [];
  for (const m of doc.matchAll(/<trans-unit\b[^>]*>([\s\S]*?)<\/trans-unit>/g)) {
    const src = /<source[^>]*>([\s\S]*?)<\/source>/.exec(m[1])?.[1];
    const tgt = /<target[^>]*>([\s\S]*?)<\/target>/.exec(m[1])?.[1];
    if (src !== undefined && tgt !== undefined) pairs.push([xmlUnescape(src), xmlUnescape(tgt)]);
  }
  return { lang: lang ? xmlUnescape(lang) : undefined, pairs };
}

const csvCell = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

export const toCsv = (rows: { text: string; places: string; target?: string }[]) =>
  ['source,target,used_in', ...rows.map((r) => [r.text, r.target ?? '', r.places].map(csvCell).join(','))].join('\r\n') + '\r\n';

/** RFC 4180 CSV: rows of cells. */
export function parseCsv(text: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') (cell += '"'), i++;
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') row.push(cell), (cell = '');
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell), rows.push(row), (row = []), (cell = '');
    } else cell += ch;
  }
  if (cell || row.length) row.push(cell), rows.push(row);
  return rows.filter((r) => r.some((c) => c !== ''));
}

// ------------------------------------------------------------------ routes

// ------------------------------------------------------------------ app settings: time zone, currency

/** Settings → Globalization: currency, time zone and automatic time zone. */
export async function timeZoneSettings(a: { time_zone: string | null; time_zone_auto: boolean | null; currency: string | null }) {
  const zones = (await owner.query<{ name: string }>(`select name from pg_timezone_names where name !~ '^(posix|right)/' order by name`)).rows.map((r) => r.name);
  const dbZone = (await owner.one<{ tz: string }>(`select current_setting('TimeZone') as tz`))?.tz ?? '';
  return html`<div class="form-grid">
      ${input('currency', 'Currency', a.currency ?? '', { placeholder: 'e.g. EUR (empty: per language)', help: 'ISO 4217 code for L (symbol) and C (code) in number format masks such as FML999G990D00. A text message FORMAT.CURRENCY overrides it per language.' })}
      ${select('time_zone', 'Time zone', a.time_zone ?? '', [['', `- the database's (${dbZone}) -`], ...zones], 'Queries run in this time zone (SET LOCAL timezone), so timestamp with time zone values show in it.')}
    </div>
    <div class="field"><label class="check"><input type="checkbox" name="time_zone_auto" value="true"${a.time_zone_auto ? raw(' checked') : ''}> Automatic time zone</label>
      <small class="help">Each user sees times in their own time zone: the browser's (sent once per session), or the one they choose on My account. Without JavaScript the app's time zone applies (APEX: Automatic Time Zone).</small></div>`;
}

/** Save the currency and time zone settings; an unknown time zone or currency is an error. */
export async function saveTimeZoneSettings(appId: string, b: Record<string, string | undefined>) {
  const zone = b.time_zone?.trim() || null;
  if (zone && !(await owner.one('select 1 from pg_timezone_names where name = $1', [zone]))) throw new Error(`Unknown time zone "${zone}".`);
  const currency = b.currency?.trim().toUpperCase() || null;
  if (currency && !/^[A-Z]{3}$/.test(currency)) throw new Error('Currency: a three-letter ISO 4217 code such as EUR or USD.');
  await owner.query('update meta.app set time_zone = $2, time_zone_auto = $3, currency = $4 where id = $1', [appId, zone, b.time_zone_auto === 'true', currency]);
}

export async function globalizationRoutes(app: FastifyInstance) {
  const appOr404 = async (id: string) => owner.one('select * from meta.app where id = $1', [id]);

  async function saveTranslations(appId: number, lang: string, pairs: [string, string][]) {
    let saved = 0;
    await owner.tx(async (c) => {
      for (const [source, target] of pairs) {
        if (!source) continue;
        if (target.trim() === '') await c.query('delete from meta.translation where app_id = $1 and language = $2 and source = $3', [appId, lang, source]);
        else {
          await c.query(
            `insert into meta.translation (app_id, language, source, target) values ($1, $2, $3, $4)
             on conflict (app_id, language, source) do update set target = excluded.target`,
            [appId, lang, source, target],
          );
          saved++;
        }
      }
    });
    clearLocaleCache(appId);
    return saved;
  }

  app.get(`${BASE}/apps/:id/globalization`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await appOr404(req.params.id);
    if (!a) return reply.code(404).send('Not found');
    const langs: string[] = a.languages ?? [];
    const lang = langs.includes(req.query.lang ?? '') ? req.query.lang : langs[0];
    const [texts, translated, messages] = await Promise.all([
      translatableTexts(a.id, owner),
      lang ? owner.query('select source, target from meta.translation where app_id = $1 and language = $2', [a.id, lang]) : Promise.resolve({ rows: [] }),
      owner.query('select name, language, text from meta.text_message where app_id = $1 order by upper(name), language', [a.id]),
    ]);
    const map = new Map(translated.rows.map((r: { source: string; target: string }) => [r.source, r.target]));
    const known = new Set(texts.map((t) => t.text));
    // translations of texts the app no longer uses, or added by hand (e.g. derived column headings)
    const extra = translated.rows.filter((r: { source: string }) => !known.has(r.source));
    const done = texts.filter((t) => map.has(t.text)).length;
    const all = [...new Set([a.language, ...langs])];

    const main = html`${appHeader(a, 'shared')}
      <p class="muted u-mt0"><a href="${BASE}/apps/${a.id}/shared">Shared Components</a> / Globalization</p>
      <div class="columns">
        ${region('Languages', html`<ul class="checklist">
            <li>Primary language: <b>${langName(a.language)}</b></li>
            <li>Translated into: ${langs.length ? langs.map((l, i) => html`${i ? ', ' : ''}<b>${langName(l)}</b>`) : html`<span class="muted">none yet</span>`}</li>
            <li>Language derived from: <b>${{ browser: 'the browser', user: 'the user’s preference, then the browser', primary: 'always the primary language' }[a.language_from as string]}</b></li>
            <li>pgapex’s own texts (sign-in, reports, messages) exist in ${BUILTIN_LANGUAGES.slice(0, -1).map(([, n]) => n).join(', ')} and ${BUILTIN_LANGUAGES.at(-1)?.[1]}; override any of them with a text message of the same name.</li>
          </ul>
          <p><a class="btn" href="${BASE}/apps/${a.id}/settings">Change languages in Settings</a></p>`)}
        ${lang ? region('Export and import', html`
          <p class="muted u-mt0">Give translators an XLIFF file (as in APEX) or a CSV file, then import it here. Empty targets are ignored on import.</p>
          <div class="buttons">
            <a class="btn" href="${BASE}/apps/${a.id}/globalization/export?lang=${lang}&format=xliff">${raw('&#8595;')} XLIFF (${lang})</a>
            <a class="btn" href="${BASE}/apps/${a.id}/globalization/export?lang=${lang}&format=csv">${raw('&#8595;')} CSV (${lang})</a>
          </div>
          <form method="post" action="${BASE}/apps/${a.id}/globalization/import" class="u-mt1">${csrf(s)}
            <input type="hidden" name="lang" value="${lang}">
            <div class="field" data-wide><label class="label" for="f_file">File</label><input id="f_file" type="file" accept=".xlf,.xliff,.csv,.xml,text/csv,application/xml" data-fill="f_doc"></div>
            <div class="field" data-wide><label class="label" for="f_doc">…or paste XLIFF / CSV</label><textarea id="f_doc" name="doc" class="code" rows="4" required></textarea></div>
            <div class="buttons"><button class="btn btn-hot">Import into ${lang}</button></div>
          </form>`) : ''}
      </div>
      ${lang
        ? region(`Translate into ${langName(lang)}`, html`
            ${langs.length > 1 ? html`<nav class="chips" aria-label="Language">${langs.map((l) => html`<a class="chip" href="?lang=${l}"${l === lang ? raw(' aria-current="page"') : ''}>${langName(l)}</a> `)}</nav>` : ''}
            <p class="muted u-mt0">${done} of ${texts.length} texts translated. Leave a translation empty to show the ${a.language} text.</p>
            <form method="post" action="${BASE}/apps/${a.id}/globalization/save">${csrf(s)}
              <input type="hidden" name="lang" value="${lang}">
              <div class="table-wrap"><table class="report report-reflow translate-table">
                <thead><tr><th>${langName(a.language)}</th><th>${langName(lang)}</th><th>Used in</th></tr></thead>
                <tbody>${[...texts, ...extra.map((r: { source: string }) => ({ text: r.source, places: 'added by hand' }))].map((t, i) => html`<tr>
                  <td data-label="${a.language}"><input type="hidden" name="s${i}" value="${t.text}"><span class="source-text">${t.text}</span></td>
                  <td data-label="${lang}">${t.text.length > 80 || t.text.includes('\n')
                    ? html`<textarea name="t${i}" rows="3" aria-label="Translation of: ${t.text.slice(0, 60)}" lang="${lang}">${map.get(t.text) ?? ''}</textarea>`
                    : html`<input name="t${i}" value="${map.get(t.text) ?? ''}" aria-label="Translation of: ${t.text}" lang="${lang}">`}</td>
                  <td data-label="Used in" class="muted">${t.places}</td></tr>`)}</tbody>
              </table></div>
              <div class="buttons"><button class="btn btn-hot">Save translations</button></div>
            </form>
            <h3>Add a text</h3>
            <p class="muted">For texts pgapex derives itself, such as column headings made from column names (<code>hiredate</code> → “Hiredate”).</p>
            <form method="post" action="${BASE}/apps/${a.id}/globalization/save" class="form-grid">${csrf(s)}
              <input type="hidden" name="lang" value="${lang}">
              ${input('s0', `Text (${a.language})`, '', { required: true })}
              ${input('t0', `Translation (${lang})`, '', { required: true })}
              <div class="buttons"><button class="btn">Add</button></div>
            </form>`)
        : region('Translate', html`<p>Add a translated language under <a href="${BASE}/apps/${a.id}/settings">Settings → Globalization</a> first (for example <code>nl</code>).</p>`)}
      ${region('Text messages', html`
        <p class="muted u-mt0">Use them in SQL with <code>meta.message('NAME', param0, …)</code> (placeholders <code>%0</code>…<code>%9</code>) and in texts as <code>&amp;APP_TEXT$NAME.</code>, like APEX_LANG.MESSAGE. A message named like a pgapex text (e.g. <code>login.title</code>, <code>report.no_data</code>) replaces it. Missing languages fall back to the primary language.</p>
        <div class="table-wrap"><table class="report report-reflow"><thead><tr><th>Name</th><th>Language</th><th>Text</th><th></th></tr></thead><tbody>
          ${messages.rows.length
            ? messages.rows.map((m) => html`<tr>
                <td data-label="Name"><code>${m.name}</code></td><td data-label="Language">${m.language}</td>
                <td data-label="Text"><form method="post" action="${BASE}/apps/${a.id}/globalization/message" class="search u-m0 u-mwnone">${csrf(s)}
                  <input type="hidden" name="name" value="${m.name}"><input type="hidden" name="language" value="${m.language}">
                  <input name="text" value="${m.text}" aria-label="Text of ${m.name} (${m.language})"><button class="btn">Save</button></form></td>
                <td data-label=""><form method="post" action="${BASE}/apps/${a.id}/globalization/message/delete">${csrf(s)}
                  <input type="hidden" name="name" value="${m.name}"><input type="hidden" name="language" value="${m.language}"><button class="link-button" data-confirm="Delete ${m.name} (${m.language})?">Delete</button></form></td></tr>`)
            : html`<tr><td colspan="4" class="empty">No text messages.</td></tr>`}
        </tbody></table></div>
        <h3>Add a text message</h3>
        <form method="post" action="${BASE}/apps/${a.id}/globalization/message" class="form-grid">${csrf(s)}
          ${input('name', 'Name', '', { required: true, placeholder: 'e.g. GREETING or login.title' })}
          ${select('language', 'Language', a.language, all.map((l): [string, string] => [l, langName(l)]))}
          ${input('text', 'Text', '', { required: true, placeholder: 'Hello %0!' })}
          <div class="buttons"><button class="btn btn-hot">Add message</button></div>
        </form>`)}`;
    return send(reply, s, shell(s, `${a.name} globalization`, [['App Builder', BASE], [a.name, `${BASE}/apps/${a.id}`], ['Shared Components', `${BASE}/apps/${a.id}/shared`], ['Globalization']], main));
  });

  app.post(`${BASE}/apps/:id/globalization/save`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await appOr404(req.params.id);
    const b = req.body ?? {};
    const lang = b.lang ?? '';
    if (!a || !(a.languages ?? []).includes(lang)) return reply.code(400).send('Unknown language');
    const pairs: [string, string][] = [];
    for (let i = 0; b[`s${i}`] !== undefined; i++) pairs.push([b[`s${i}`] ?? '', b[`t${i}`] ?? '']);
    const n = await saveTranslations(a.id, lang, pairs);
    flash(s, `${n} translation(s) saved for ${lang}.`);
    return back(reply, s, `${BASE}/apps/${a.id}/globalization?lang=${encodeURIComponent(lang)}`);
  });

  app.get(`${BASE}/apps/:id/globalization/export`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await appOr404(req.params.id);
    const lang = req.query.lang ?? '';
    if (!a || !(a.languages ?? []).includes(lang)) return reply.code(404).send('Not found');
    const map = new Map((await owner.query('select source, target from meta.translation where app_id = $1 and language = $2', [a.id, lang])).rows.map((r) => [r.source, r.target]));
    const texts = await translatableTexts(a.id, owner);
    const known = new Set(texts.map((t) => t.text));
    const rows = [...texts, ...[...map.keys()].filter((k) => !known.has(k)).map((k) => ({ text: k, places: 'added by hand' }))]
      .map((t) => ({ ...t, target: map.get(t.text) }));
    const name = `${a.alias}_${a.language}_${lang}`;
    if (req.query.format === 'csv')
      return reply.header('content-disposition', `attachment; filename="${name}.csv"`).type('text/csv; charset=utf-8').send('﻿' + toCsv(rows));
    return reply.header('content-disposition', `attachment; filename="${name}.xlf"`).type('application/xml; charset=utf-8').send(toXliff(a.alias, a.language, lang, rows));
  });

  app.post(`${BASE}/apps/:id/globalization/import`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await appOr404(req.params.id);
    const b = req.body ?? {};
    let lang = b.lang ?? '';
    const doc = (b.doc ?? '').replace(/^﻿/, '');
    try {
      let pairs: [string, string][];
      if (/<xliff\b/.test(doc)) {
        const x = fromXliff(doc);
        if (x.lang) lang = x.lang;
        pairs = x.pairs;
      } else {
        const rows = parseCsv(doc);
        if (rows[0]?.[0]?.toLowerCase() === 'source') rows.shift();
        pairs = rows.map((r): [string, string] => [r[0] ?? '', r[1] ?? '']);
      }
      if (!a || !(a.languages ?? []).includes(lang)) throw new Error(`"${lang}" is not a translated language of this application. Add it in Settings first.`);
      const n = await saveTranslations(a.id, lang, pairs.filter(([, t]) => t.trim() !== ''));
      flash(s, `${n} translation(s) imported into ${lang}.`);
    } catch (e) {
      flash(s, `Import failed: ${(e as Error).message}`, 'error');
    }
    return back(reply, s, `${BASE}/apps/${req.params.id}/globalization?lang=${encodeURIComponent(lang)}`);
  });

  app.post(`${BASE}/apps/:id/globalization/message`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const b = req.body ?? {};
    try {
      await owner.query(
        `insert into meta.text_message (app_id, name, language, text) values ($1, $2, $3, $4)
         on conflict (app_id, name, language) do update set text = excluded.text`,
        [req.params.id, b.name?.trim(), b.language?.trim().toLowerCase(), b.text ?? ''],
      );
      clearLocaleCache(Number(req.params.id));
      flash(s, 'Text message saved.');
    } catch (e) {
      flash(s, /text_message_name_check/.test((e as Error).message) ? 'Names start with a letter and contain letters, digits, _ . $ or -.' : (e as Error).message, 'error');
    }
    return back(reply, s, `${BASE}/apps/${req.params.id}/globalization`);
  });

  app.post(`${BASE}/apps/:id/globalization/message/delete`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    await owner.query('delete from meta.text_message where app_id = $1 and name = $2 and language = $3', [req.params.id, req.body?.name, req.body?.language]);
    clearLocaleCache(Number(req.params.id));
    flash(s, 'Text message deleted.');
    return back(reply, s, `${BASE}/apps/${req.params.id}/globalization`);
  });
}
