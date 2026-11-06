import type { FastifyInstance } from 'fastify';
import { owner } from '../db.ts';
import { html, raw } from '../html.ts';
import { baseLanguage, BUILTIN_LANGUAGES, LANGUAGE_NAMES } from '../i18n.ts';
import { clearLocaleCache, translatableTexts } from '../runtime/locale.ts';
import { appHeader, back, BASE, csrf, developer, flash, input, region, select, send, shell, type Req } from './ui.ts';
import { scopedTx as tx } from './i18n.ts';

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
      ${input('currency', tx('glob.currency'), a.currency ?? '', { placeholder: tx('glob.e_g_eur_empty_per'), help: tx('glob.iso_4217_code_for_l') })}
      ${select('time_zone', tx('glob.time_zone'), a.time_zone ?? '', [['', `- the database's (${dbZone}) -`], ...zones], tx('glob.queries_run_in_this_time'))}
    </div>
    <div class="field"><label class="check"><input type="checkbox" name="time_zone_auto" value="true"${a.time_zone_auto ? raw(' checked') : ''}> ${tx('glob.automatic_time_zone')}</label>
      <small class="help">${tx('glob.each_user_sees_times_in')}</small></div>`;
}

/** Save the currency and time zone settings; an unknown time zone or currency is an error. */
export async function saveTimeZoneSettings(appId: string, b: Record<string, string | undefined>) {
  const zone = b.time_zone?.trim() || null;
  if (zone && !(await owner.one('select 1 from pg_timezone_names where name = $1', [zone]))) throw new Error(tx('glob.unknown_zone', { zone }));
  const currency = b.currency?.trim().toUpperCase() || null;
  if (currency && !/^[A-Z]{3}$/.test(currency)) throw new Error(tx('glob.currency_a_three_letter_iso'));
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

    const main = html`${appHeader(a, 'shared', s)}
      <p class="muted u-mt0"><a href="${BASE}/apps/${a.id}/shared">${tx('glob.shared_components')}</a> / Globalization</p>
      <div class="columns">
        ${region(tx('glob.languages'), html`<ul class="checklist">
            <li>${tx.rich('glob.primary', { lang: html`<b>${langName(a.language)}</b>` })}</li>
            <li>${tx.rich('glob.translated_into', { langs: langs.length ? html`${langs.map((l, i) => html`${i ? ', ' : ''}<b>${langName(l)}</b>`)}` : html`<span class="muted">${tx('glob.none_yet')}</span>` })}</li>
            <li>${tx.rich('glob.derived', { from: html`<b>${tx.dyn(`glob.from.${a.language_from}`, String(a.language_from))}</b>` })}</li>
            <li>${tx('glob.builtin', { list: BUILTIN_LANGUAGES.slice(0, -1).map(([, n]) => n).join(', '), last: BUILTIN_LANGUAGES.at(-1)?.[1] ?? '' })}</li>
          </ul>
          <p><a class="btn" href="${BASE}/apps/${a.id}/settings">${tx('glob.change_languages_in_settings')}</a></p>`)}
        ${lang ? region(tx('glob.export_and_import'), html`
          <p class="muted u-mt0">${tx('glob.give_translators_an_xliff_file')}</p>
          <div class="buttons">
            <a class="btn" href="${BASE}/apps/${a.id}/globalization/export?lang=${lang}&format=xliff">${raw('&#8595;')} XLIFF (${lang})</a>
            <a class="btn" href="${BASE}/apps/${a.id}/globalization/export?lang=${lang}&format=csv">${raw('&#8595;')} CSV (${lang})</a>
          </div>
          <form method="post" action="${BASE}/apps/${a.id}/globalization/import" class="u-mt1">${csrf(s)}
            <input type="hidden" name="lang" value="${lang}">
            <div class="field" data-wide><label class="label" for="f_file">${tx('glob.file')}</label><input id="f_file" type="file" accept=".xlf,.xliff,.csv,.xml,text/csv,application/xml" data-fill="f_doc"></div>
            <div class="field" data-wide><label class="label" for="f_doc">${tx('glob.or_paste_xliff_csv')}</label><textarea id="f_doc" name="doc" class="code" rows="4" required></textarea></div>
            <div class="buttons"><button class="btn btn-hot">Import into ${lang}</button></div>
          </form>`) : ''}
      </div>
      ${lang
        ? region(tx('glob.translate_into', { lang: langName(lang) }), html`
            ${langs.length > 1 ? html`<nav class="chips" aria-label="${tx('glob.language')}">${langs.map((l) => html`<a class="chip" href="?lang=${l}"${l === lang ? raw(' aria-current="page"') : ''}>${langName(l)}</a> `)}</nav>` : ''}
            <p class="muted u-mt0">${done} of ${texts.length} texts translated. Leave a translation empty to show the ${a.language} text.</p>
            <form method="post" action="${BASE}/apps/${a.id}/globalization/save">${csrf(s)}
              <input type="hidden" name="lang" value="${lang}">
              <div class="table-wrap"><table class="report report-reflow translate-table">
                <thead><tr><th>${langName(a.language)}</th><th>${langName(lang)}</th><th>${tx('glob.used_in')}</th></tr></thead>
                <tbody>${[...texts, ...extra.map((r: { source: string }) => ({ text: r.source, places: 'added by hand' }))].map((t, i) => html`<tr>
                  <td data-label="${a.language}"><input type="hidden" name="s${i}" value="${t.text}"><span class="source-text">${t.text}</span></td>
                  <td data-label="${lang}">${t.text.length > 80 || t.text.includes('\n')
                    ? html`<textarea name="t${i}" rows="3" aria-label="${tx('glob.aria_translation', { text: t.text.slice(0, 60) })}" lang="${lang}">${map.get(t.text) ?? ''}</textarea>`
                    : html`<input name="t${i}" value="${map.get(t.text) ?? ''}" aria-label="${tx('glob.aria_translation', { text: t.text })}" lang="${lang}">`}</td>
                  <td data-label="${tx('glob.used_in')}" class="muted">${t.places}</td></tr>`)}</tbody>
              </table></div>
              <div class="buttons"><button class="btn btn-hot">${tx('glob.save_translations')}</button></div>
            </form>
            <h3>${tx('glob.add_a_text')}</h3>
            <p class="muted">${tx.code('glob.for_texts_pgkiln_derives_itself')}</p>
            <form method="post" action="${BASE}/apps/${a.id}/globalization/save" class="form-grid">${csrf(s)}
              <input type="hidden" name="lang" value="${lang}">
              ${input('s0', tx('glob.text_lang', { lang: a.language }), '', { required: true })}
              ${input('t0', tx('glob.translation_lang', { lang }), '', { required: true })}
              <div class="buttons"><button class="btn">${tx('glob.add')}</button></div>
            </form>`)
        : region(tx('glob.translate'), html`<p>${tx.rich('glob.add_lang_first', { link: html`<a href="${BASE}/apps/${a.id}/settings">${tx('glob.settings_globalization')}</a>`, example: html`<code>nl</code>` })}</p>`)}
      ${region(tx('glob.text_messages'), html`
        <p class="muted u-mt0">${tx.code('glob.use_them_in_sql_with')}</p>
        <div class="table-wrap"><table class="report report-reflow"><thead><tr><th>${tx('glob.name')}</th><th>${tx('glob.language')}</th><th>${tx('glob.text')}</th><th></th></tr></thead><tbody>
          ${messages.rows.length
            ? messages.rows.map((m) => html`<tr>
                <td data-label="${tx('glob.name')}"><code>${m.name}</code></td><td data-label="${tx('glob.language')}">${m.language}</td>
                <td data-label="${tx('glob.text')}"><form method="post" action="${BASE}/apps/${a.id}/globalization/message" class="search u-m0 u-mwnone">${csrf(s)}
                  <input type="hidden" name="name" value="${m.name}"><input type="hidden" name="language" value="${m.language}">
                  <input name="text" value="${m.text}" aria-label="${tx('glob.aria_text_of', { name: m.name, lang: m.language })}"><button class="btn">${tx('glob.save')}</button></form></td>
                <td data-label=""><form method="post" action="${BASE}/apps/${a.id}/globalization/message/delete">${csrf(s)}
                  <input type="hidden" name="name" value="${m.name}"><input type="hidden" name="language" value="${m.language}"><button class="link-button" data-confirm="${tx('glob.delete_confirm', { name: m.name, lang: m.language })}">${tx('glob.delete')}</button></form></td></tr>`)
            : html`<tr><td colspan="4" class="empty">${tx('glob.no_text_messages')}</td></tr>`}
        </tbody></table></div>
        <h3>${tx('glob.add_a_text_message')}</h3>
        <form method="post" action="${BASE}/apps/${a.id}/globalization/message" class="form-grid">${csrf(s)}
          ${input('name', tx('glob.name'), '', { required: true, placeholder: tx('glob.e_g_greeting_or_login') })}
          ${select('language', tx('glob.language'), a.language, all.map((l): [string, string] => [l, langName(l)]))}
          ${input('text', tx('glob.text'), '', { required: true, placeholder: tx('glob.hello_0') })}
          <div class="buttons"><button class="btn btn-hot">${tx('glob.add_message')}</button></div>
        </form>`)}`;
    return send(reply, s, shell(s, `${a.name} globalization`, [[tx('glob.app_builder'), BASE], [a.name, `${BASE}/apps/${a.id}`], [tx('glob.shared_components'), `${BASE}/apps/${a.id}/shared`], [tx('glob.globalization')]], main));
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
      flash(s, tx('glob.import_failed', { error: (e as Error).message }), 'error');
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
      flash(s, tx('glob.text_message_saved'));
    } catch (e) {
      flash(s, /text_message_name_check/.test((e as Error).message) ? tx('glob.names_start_with_a_letter') : (e as Error).message, 'error');
    }
    return back(reply, s, `${BASE}/apps/${req.params.id}/globalization`);
  });

  app.post(`${BASE}/apps/:id/globalization/message/delete`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    await owner.query('delete from meta.text_message where app_id = $1 and name = $2 and language = $3', [req.params.id, req.body?.name, req.body?.language]);
    clearLocaleCache(Number(req.params.id));
    flash(s, tx('glob.text_message_deleted'));
    return back(reply, s, `${BASE}/apps/${req.params.id}/globalization`);
  });
}
