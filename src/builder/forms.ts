import { owner } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import type { Session } from '../session.ts';
import { COMPONENTS, ICON_OPTIONS, parseFields, type ComponentSpec, type Field } from './components.ts';
import { csrf, type Body } from './ui.ts';

// Shared helpers of the builder pages: lookups for select lists, the generic
// component property form and saving it.

export interface Lookups {
  regions: { id: number; title: string | null; type: string }[];
  pages: { page_no: number; name: string }[];
  authz: string[];
  nav: { id: number; label: string }[];
}

export async function lookups(appId: number, pageId?: number): Promise<Lookups> {
  const [regions, pages, authz, nav] = await Promise.all([
    pageId ? owner.query('select id, title, type from meta.region where page_id = $1 order by seq, id', [pageId]) : Promise.resolve({ rows: [] }),
    owner.query('select page_no, name from meta.page where app_id = $1 order by page_no', [appId]),
    owner.query('select name from meta.authz_scheme where app_id = $1 order by name', [appId]),
    owner.query('select id, label from meta.nav_entry where app_id = $1 order by seq, id', [appId]),
  ]);
  return { regions: regions.rows, pages: pages.rows, authz: authz.rows.map((r) => r.name), nav: nav.rows };
}

/** Property editor for one component, grouped like APEX's property editor. */
export function componentForm(spec: ComponentSpec, kind: string, row: any, lk: Lookups, action: string, s: Session, submit: string) {
  const field = (f: Field) => {
    const v = row?.[f.name];
    const help = f.help ? html`<small class="help">${f.help}</small>` : '';
    const id = `f_${kind}_${f.name}`;
    let control: Raw;
    const opts = (list: [string, string][]) =>
      html`<select id="${id}" name="${f.name}">${list.map(([val, label]) => html`<option value="${val}"${String(v ?? '') === val ? raw(' selected') : ''}>${label}</option>`)}</select>`;
    switch (f.kind) {
      case 'bool':
        return html`<div class="field"><span class="label" aria-hidden="true"></span><label class="check"><input type="checkbox" name="${f.name}" value="true"${v ? raw(' checked') : ''}> ${f.label}</label>${help}</div>`;
      case 'select':
        control = opts(f.options!.map((o) => [o, o || '- none -']));
        break;
      case 'icon':
        control = opts(ICON_OPTIONS.map((o) => [o, o || '- none -']));
        break;
      case 'region':
        control = opts([['', '- none (page level) -'], ...lk.regions.map((r): [string, string] => [String(r.id), `${r.title ?? '(untitled)'} (${r.type})`])]);
        break;
      case 'page':
        control = opts([['', '- none -'], ...lk.pages.map((p): [string, string] => [String(p.page_no), `${p.page_no}. ${p.name}`])]);
        break;
      case 'nav':
        control = opts([['', '- top level -'], ...lk.nav.filter((n) => n.id !== row?.id).map((n): [string, string] => [String(n.id), n.label])]);
        break;
      case 'authz': {
        const names = ['MUST_NOT_BE_PUBLIC_USER', ...lk.authz];
        const list: [string, string][] = [['', '- none -'], ...names.flatMap((n): [string, string][] => [[n, n], [`!${n}`, `Not ${n}`]])];
        if (v && !list.some(([x]) => x === v)) list.push([v, `${v} (missing!)`]);
        control = opts(list);
        break;
      }
      case 'code':
        control = html`<textarea id="${id}" name="${f.name}" class="code" rows="${f.wide ? 7 : 2}" spellcheck="false">${v ?? ''}</textarea>`;
        break;
      case 'textarea':
        control = html`<textarea id="${id}" name="${f.name}" rows="3">${v ?? ''}</textarea>`;
        break;
      case 'list':
        control = html`<input id="${id}" name="${f.name}" value="${Array.isArray(v) ? v.join(', ') : (v ?? '')}">`;
        break;
      case 'color':
        control = html`<input id="${id}" name="${f.name}" type="color" value="${v ?? '#000000'}">`;
        break;
      case 'json': {
        const text = v && typeof v === 'object' && Object.keys(v).length ? JSON.stringify(v, null, 2) : '';
        control = html`<textarea id="${id}" name="${f.name}" class="code" rows="${f.wide ? 4 : 2}" spellcheck="false">${text}</textarea>`;
        break;
      }
      default:
        control = html`<input id="${id}" name="${f.name}" type="${f.kind === 'int' ? 'number' : 'text'}" value="${v ?? ''}">`;
    }
    return html`<div class="field"${f.wide ? raw(' data-wide') : ''}><label class="label" for="${id}">${f.label}</label>${control}${help}</div>`;
  };
  const groups = [...new Set(spec.fields.map((f) => f.group ?? ''))];
  return html`<form method="post" action="${action}" class="component-form">
    ${csrf(s)}
    ${groups.map((g) => html`<fieldset class="prop-group">${g ? html`<legend>${g}</legend>` : ''}<div class="form-grid">${spec.fields.filter((f) => (f.group ?? '') === g).map(field)}</div></fieldset>`)}
    <div class="buttons"><button class="btn btn-hot">${submit}</button></div>
  </form>`;
}

export async function saveComponent(kind: string, parentCol: 'page_id' | 'app_id', parentId: string, cid: string | undefined, body: Body) {
  const spec = COMPONENTS[kind];
  const values = parseFields(spec, body);
  const problem = spec.validate?.(values);
  if (problem) throw new Error(problem);
  if (cid) {
    const cols = Object.keys(values);
    const res = await owner.query(
      `update ${spec.table} set ${cols.map((c, i) => `${c} = $${i + 3}`).join(', ')} where id = $1 and ${parentCol} = $2`,
      [cid, parentId, ...Object.values(values)],
    );
    if (res.rowCount !== 1) throw new Error('Component not found');
    return Number(cid);
  }
  // On create, empty values are left out so column defaults apply.
  const set = Object.entries(values).filter(([, v]) => v !== null);
  const r = await owner.one(
    `insert into ${spec.table} (${parentCol}${set.map(([c]) => `, ${c}`).join('')}) values ($1${set.map((_, i) => `, $${i + 2}`).join('')}) returning id`,
    [parentId, ...set.map(([, v]) => v)],
  );
  return r.id as number;
}

export const appOr404 = async (id: string) => owner.one('select * from meta.app where id = $1', [id]);
