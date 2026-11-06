import type { FastifyInstance } from 'fastify';
import { owner } from '../db.ts';
import { html } from '../html.ts';
import { icon } from '../icons.ts';
import { readMultipart } from '../runtime/files.ts';
import { includable, STATIC_MAX, STATIC_TYPES, staticType } from '../runtime/static-files.ts';
import type { Session } from '../session.ts';
import { WORKSPACE_FILES } from '../metadata.ts';
import { appOr404 } from './forms.ts';
import { appHeader, back, BASE, csrf, developer, flash, input, region, send, shell, type Body, type Req } from './ui.ts';
import { scopedTx as tx } from './i18n.ts';

// Shared Components → Static application files (APEX: Static Application
// Files): upload, write and remove an application's JavaScript, CSS, images
// and fonts, and choose the scripts and stylesheets every page loads
// (meta.app.static_includes; a page adds its own in the page designer).
// The runtime serves them at /a/<alias>/static/<name> (src/runtime/static-files.ts).

/** Files a list may name (every page, or one page). */
const MAX_INCLUDES = 20;

/**
 * "a.js, b.css" → the valid, includable, distinct names, in order. (141) "#WORKSPACE_FILES#theme.css"
 * is a static workspace file; "#APP_FILES#a.js" is the same as "a.js".
 */
export function parseIncludes(text: string | undefined) {
  const names = (text ?? '').split(/[\s,]+/).map((n) => n.trim().replace(/^#APP_FILES#/, '')).filter((n) => {
    const file = n.startsWith(WORKSPACE_FILES) ? n.slice(WORKSPACE_FILES.length) : n;
    return file && staticType(file) && includable(file);
  });
  return [...new Set(names)].slice(0, MAX_INCLUDES);
}

/** Text files a developer can edit here. */
const editable = (name: string) => /^text\/|^application\/json$/.test(staticType(name) ?? '');

const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);

interface FileRow {
  name: string;
  mime: string;
  bytes: number;
  changed: string;
}

async function page(s: Session, a: any, query: Record<string, string | undefined>) {
  const files = (await owner.query<FileRow>(`select name, mime, octet_length(content) as bytes, to_char(updated_at, 'YYYY-MM-DD HH24:MI') as changed from meta.static_file where app_id = $1 order by name`, [a.id])).rows;
  const editName = query.edit && files.some((f) => f.name === query.edit) && editable(query.edit) ? query.edit : null;
  const creating = query.new === '1';
  const content = editName
    ? (await owner.one<{ content: Buffer }>('select content from meta.static_file where app_id = $1 and name = $2', [a.id, editName]))!.content.toString('utf8')
    : '';
  const usedBy = (await owner.query<{ name: string; pages: number[] }>(
    `select u.name, array_agg(p.page_no order by p.page_no) as pages from meta.page p, unnest(p.static_includes) u(name) where p.app_id = $1 group by u.name`, [a.id])).rows;
  const pagesOf = (n: string) => usedBy.find((u) => u.name === n)?.pages ?? [];
  const base = `${BASE}/apps/${a.id}/static-files`;
  const everyPage = new Set<string>(a.static_includes ?? []);

  const editor = editName || creating
    ? region(editName ? tx('sf.edit_title', { name: editName }) : tx('sf.new_file'), html`<form method="post" action="${base}/save">${csrf(s)}
        ${editName ? html`<input type="hidden" name="original" value="${editName}">` : ''}
        <div class="form-grid">${input('name', tx('sf.file_name'), editName ?? '', { required: true, placeholder: 'app.js', help: tx('sf.file_name_help') })}</div>
        <div class="field" data-wide><label class="label" for="f_content">${tx('sf.content')}</label>
          <textarea id="f_content" name="content" class="code" rows="18" spellcheck="false">${content}</textarea>
          <small class="help">${tx.code('sf.content_help')}</small></div>
        <div class="buttons"><a class="btn" href="${base}">${tx('common.cancel')}</a><button class="btn btn-hot">${icon('check')} ${tx('common.save')}</button></div>
      </form>`)
    : '';

  return html`${appHeader(a, 'shared', s)}
    ${editor}
    ${region(tx('sf.title'), html`<p class="muted u-mt0">${tx.rich('sf.intro', { path: html`<code>/a/${a.alias}/static/<i>name</i></code>`, max: size(STATIC_MAX) })}</p>
      ${files.length
        ? html`<div class="table-wrap"><table class="report"><caption class="sr-only">${tx('sf.title')}</caption>
            <thead><tr><th scope="col">${tx('sf.name')}</th><th scope="col">${tx('sf.type')}</th><th scope="col" class="num">${tx('sf.size')}</th><th scope="col">${tx('sf.loaded_by')}</th><th scope="col">${tx('sf.changed')}</th><th scope="col"><span class="sr-only">${tx('sf.actions')}</span></th></tr></thead>
            <tbody>${files.map((f) => html`<tr>
              <td><a href="/a/${a.alias}/static/${encodeURIComponent(f.name)}" target="_blank" rel="noopener">${f.name}</a></td>
              <td>${f.mime}</td><td class="num">${size(Number(f.bytes))}</td>
              <td>${includable(f.name) ? [everyPage.has(f.name) ? tx('sf.every_page') : '', pagesOf(f.name).length ? tx('sf.pages', { pages: pagesOf(f.name).join(', ') }) : ''].filter(Boolean).join('; ') || html`<span class="muted">-</span>` : ''}</td>
              <td>${f.changed}</td>
              <td class="nowrap">${editable(f.name) ? html`<a class="btn btn-small" href="${base}?edit=${encodeURIComponent(f.name)}">${tx('sf.edit')}</a> ` : ''}
                <form method="post" action="${base}/delete" class="inline">${csrf(s)}<input type="hidden" name="name" value="${f.name}">
                  <button class="btn btn-small btn-danger" data-confirm="${tx('sf.delete_confirm', { name: f.name })}" aria-label="${tx('sf.delete_name', { name: f.name })}">${icon('trash')}</button></form></td>
            </tr>`)}</tbody></table></div>`
        : html`<p class="muted">${tx('sf.no_files')}</p>`}
      <div class="buttons u-mt1"><a class="btn" href="${base}?new=1">${icon('plus')} ${tx('sf.new_file')}</a></div>
      <form method="post" action="${base}/upload" enctype="multipart/form-data" class="search u-mwnone u-mt1">${csrf(s)}
        <input type="file" name="file" multiple aria-label="${tx('sf.files_to_upload')}" accept="${Object.keys(STATIC_TYPES).map((x) => `.${x}`).join(',')}">
        <button class="btn">${icon('upload')} ${tx('sf.upload')}</button>
        <small class="help">${tx('sf.replaced')}</small>
      </form>`)}
    ${region(tx('sf.every_page_loads'), html`<form method="post" action="${base}/includes">${csrf(s)}
        <div class="form-grid">${input('includes', tx('sf.includes'), (a.static_includes ?? []).join(', '), { placeholder: tx('sf.includes_ph'), help: tx('sf.includes_help', { max: MAX_INCLUDES }) })}</div>
        <div class="buttons"><button class="btn btn-hot">${tx('common.save')}</button></div>
      </form>`)}`;
}

export async function staticFileBuilderRoutes(app: FastifyInstance) {
  const title = (a: any) => [[tx('rail.app_builder'), BASE], [a.name, `${BASE}/apps/${a.id}`], [tx('app.tab.shared'), `${BASE}/apps/${a.id}/shared`], [tx('sf.title')]] as [string, string?][];
  const find = async (id: string) => (/^\d+$/.test(id) ? appOr404(id) : undefined);

  app.get(`${BASE}/apps/:id/static-files`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await find(req.params.id);
    if (!a) return reply.code(404).send('Not found');
    return send(reply, s, shell(s, tx('sf.title'), title(a), await page(s, a, req.query ?? {})));
  });

  app.post(`${BASE}/apps/:id/static-files/upload`, async (req: Req, reply) => {
    let uploads: { filename: string; data: Buffer; truncated: boolean }[] = [];
    if (req.isMultipart()) {
      const parsed = await readMultipart(req, STATIC_MAX / 1024 / 1024);
      req.body = parsed.body as Body;
      uploads = parsed.lists.get('file') ?? [];
    }
    const s = await developer(req, reply);
    if (!s) return;
    const a = await find(req.params.id);
    if (!a) return reply.code(404).send('Not found');
    const target = `${BASE}/apps/${a.id}/static-files`;
    if (!uploads.length) {
      flash(s, tx('sf.choose_files'), 'error');
      return back(reply, s, target);
    }
    const saved: string[] = [];
    for (const u of uploads) {
      const name = u.filename.split(/[\\/]/).pop()!.trim();
      const type = staticType(name);
      if (u.truncated) flash(s, tx('sf.too_large_name', { name, max: size(STATIC_MAX) }), 'error');
      else if (!type) flash(s, tx('sf.bad_type', { name, types: Object.keys(STATIC_TYPES).join(', ') }), 'error');
      else {
        await owner.query(
          `insert into meta.static_file (app_id, name, mime, content) values ($1, $2, $3, $4)
           on conflict (app_id, name) do update set mime = excluded.mime, content = excluded.content, updated_at = now()`,
          [a.id, name, type, u.data]);
        saved.push(name);
      }
    }
    if (saved.length) flash(s, tx('sf.uploaded', { names: saved.join(', ') }));
    return back(reply, s, target);
  });

  app.post(`${BASE}/apps/:id/static-files/save`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await find(req.params.id);
    if (!a) return reply.code(404).send('Not found');
    const b = req.body ?? {};
    const name = String(b.name ?? '').trim();
    const original = b.original ? String(b.original) : null;
    const type = staticType(name);
    const content = Buffer.from(String(b.content ?? '').replace(/\r\n/g, '\n'), 'utf8');
    const base = `${BASE}/apps/${a.id}/static-files`;
    if (!type || !editable(name)) {
      flash(s, tx('sf.bad_text_name'), 'error');
      return back(reply, s, original ? `${base}?edit=${encodeURIComponent(original)}` : `${base}?new=1`);
    }
    if (content.length > STATIC_MAX) {
      flash(s, tx('sf.too_large', { max: size(STATIC_MAX) }), 'error');
      return back(reply, s, base);
    }
    try {
      if (original && original !== name) {
        await owner.query('update meta.static_file set name = $3, mime = $4, content = $5, updated_at = now() where app_id = $1 and name = $2', [a.id, original, name, type, content]);
        // the lists that load it follow the new name
        await owner.query('update meta.app set static_includes = array_replace(static_includes, $2, $3) where id = $1', [a.id, original, name]);
        await owner.query('update meta.page set static_includes = array_replace(static_includes, $2, $3) where app_id = $1', [a.id, original, name]);
      } else
        await owner.query(
          `insert into meta.static_file (app_id, name, mime, content) values ($1, $2, $3, $4)
           on conflict (app_id, name) do update set mime = excluded.mime, content = excluded.content, updated_at = now()`,
          [a.id, name, type, content]);
      flash(s, tx('sf.saved_name', { name }));
      return back(reply, s, `${base}?edit=${encodeURIComponent(name)}`);
    } catch (e) {
      flash(s, (e as Error).message, 'error');
      return back(reply, s, base);
    }
  });

  app.post(`${BASE}/apps/:id/static-files/delete`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await find(req.params.id);
    if (!a) return reply.code(404).send('Not found');
    const name = String(req.body?.name ?? '');
    const r = await owner.query('delete from meta.static_file where app_id = $1 and name = $2', [a.id, name]);
    flash(s, r.rowCount ? tx('sf.deleted', { name }) : tx('sf.no_such_file'), r.rowCount ? 'ok' : 'error');
    return back(reply, s, `${BASE}/apps/${a.id}/static-files`);
  });

  app.post(`${BASE}/apps/:id/static-files/includes`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const a = await find(req.params.id);
    if (!a) return reply.code(404).send('Not found');
    const names = parseIncludes(req.body?.includes);
    await owner.query('update meta.app set static_includes = $2, updated_at = now() where id = $1', [a.id, names]);
    const missing = (await owner.query<{ n: string }>(
      `select n from unnest($2::text[]) n
        where not exists (select 1 from meta.static_file f where f.app_id = $1 and f.name = n)
          and not exists (select 1 from meta.workspace_file w where w.workspace_id = meta.app_workspace($1) and $3 || w.name = n)`, [a.id, names, WORKSPACE_FILES])).rows.map((r) => r.n);
    flash(s, missing.length ? tx('sf.saved_missing', { names: missing.join(', ') }) : tx('sf.saved'));
    return back(reply, s, `${BASE}/apps/${a.id}/static-files`);
  });
}
