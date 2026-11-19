import { owner } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import type { Session } from '../session.ts';
import { icon, ICON_MODIFIERS, isIcon, lucideNames } from '../icons.ts';
import { COMPONENTS, ICON_OPTIONS, parseFields, type ComponentSpec, type Field } from './components.ts';
import { BASE, csrf, type Body } from './ui.ts';
import { codeAttrs } from './code-editor.ts';
import { optionName, typeName } from './type-names.ts';
import { withComponentTypes } from './component-regions.ts';
import { scopedTx } from './i18n.ts';

// Shared helpers of the builder pages: lookups for select lists, the generic
// component property form and saving it.

export interface Lookups {
  regions: { id: number; title: string | null; type: string; parent_id: number | null }[];
  pages: { page_no: number; name: string }[];
  authz: string[];
  nav: { id: number; label: string }[];
  buildOptions: { name: string; status: string }[];
  restSources: string[];
  lists: string[];
  listEntries: { id: number; list_name: string; label: string }[];
  automations: string[];
  pageGroups: string[];
}

export async function lookups(appId: number, pageId?: number): Promise<Lookups> {
  const [regions, pages, authz, nav, buildOptions, rest, lists, listEntries, automations, pageGroups] = await Promise.all([
    pageId ? owner.query('select id, title, type, parent_id from meta.region where page_id = $1 order by seq, id', [pageId]) : Promise.resolve({ rows: [] }),
    owner.query('select page_no, name from meta.page where app_id = $1 order by page_no', [appId]),
    owner.query('select name from meta.authz_scheme where app_id = $1 order by name', [appId]),
    owner.query('select id, label from meta.nav_entry where app_id = $1 order by seq, id', [appId]),
    owner.query('select name, status from meta.build_option where app_id = $1 order by name', [appId]),
    owner.query('select name from meta.rest_source where app_id = $1 order by name', [appId]),
    owner.query('select name from meta.list where app_id = $1 order by name', [appId]),
    owner.query('select id, list_name, label from meta.list_entry where app_id = $1 order by list_name, seq, id', [appId]),
    owner.query('select name from meta.automation where app_id = $1 order by name', [appId]),
    owner.query('select name from meta.page_group where app_id = $1 order by name', [appId]),
  ]);
  return { regions: regions.rows, pages: pages.rows, authz: authz.rows.map((r) => r.name), nav: nav.rows, buildOptions: buildOptions.rows, restSources: rest.rows.map((r) => r.name), lists: lists.rows.map((r) => r.name), listEntries: listEntries.rows, automations: automations.rows.map((r) => r.name), pageGroups: pageGroups.rows.map((r) => r.name) };
}

/** Choices of a build option field: each option and its negation, plus a missing current value. */
export function buildOptionChoices(lk: Lookups, v: string | null | undefined): [string, string][] {
  const list: [string, string][] = [['', '- none -'], ...lk.buildOptions.flatMap((o): [string, string][] => [[o.name, `${o.name} (${o.status})`], [`!${o.name}`, `Not ${o.name}`]])];
  if (v && !list.some(([x]) => x === v)) list.push([v, `${v} (missing: excluded!)`]);
  return list;
}

/**
 * (0.30) An icon field: the icons as a grid of radio buttons inside a
 * disclosure that shows the current one (works without script; a filter box
 * narrows the grid as you type, builder.js data-icon-filter).
 */
export function iconPicker(id: string, name: string, label: string, current: string, help: Raw | '' = '') {
  const known = (ICON_OPTIONS as readonly string[]).includes(current);
  // (0.31) any other icon: a Lucide name or a Font APEX one, with modifiers ("car-front lg", "fa-refresh fa-spin")
  const other = current && !known ? current : '';
  return html`<div class="field icon-field"><span class="label" id="${id}_label">${label}</span>
    <details class="icon-picker">
      <summary aria-describedby="${id}_label">${current && isIcon(current) ? html`${icon(current)}<span>${current}</span>` : html`<span class="muted">- none -</span>`}</summary>
      <div class="icon-picker-panel">
        <label class="sr-only" for="${id}_filter">Filter icons</label>
        <input id="${id}_filter" type="search" placeholder="Filter icons… (also searches ${String(lucideNames().size)} more)" data-icon-filter data-icon-search="${BASE}/icons/search" autocomplete="off">
        <fieldset class="icon-grid"><legend class="sr-only">${label}</legend>
          <label class="icon-choice"><input type="radio" name="${name}" value=""${current === '' || !known ? raw(' checked') : ''}><span class="icon-none" aria-hidden="true">∅</span><span class="icon-name">none</span></label>
          ${ICON_OPTIONS.filter(Boolean).map((n) => html`<label class="icon-choice" title="${n}"><input type="radio" name="${name}" value="${n}"${current === n ? raw(' checked') : ''}>${icon(n)}<span class="icon-name">${n}</span></label>`)}
        </fieldset>
        <div class="icon-more" data-icon-more hidden></div>
        <div class="field u-mt075"><label class="label" for="${id}_custom">Or any icon, with modifiers</label>
          <input id="${id}_custom" name="${name}__custom" value="${other}" maxlength="100" placeholder="car-front lg" data-icon-custom>
          <small class="help">One of the ${String(lucideNames().size)} <a href="https://lucide.dev/icons/" rel="noopener" target="_blank">Lucide icons</a> or a Font APEX name (<code>fa-users</code>), then modifiers: ${ICON_MODIFIERS.join(', ')}. Filled in, it wins over the grid.</small></div>
      </div>
    </details>${help}</div>`;
}

/** Property editor for one component, grouped like APEX's property editor. `submit` '' leaves the button out
 *  ((sprint 197, NX-U5) the Page Designer's toolbar Save submits the form through form=). */
export function componentForm(spec: ComponentSpec, kind: string, row: any, lk: Lookups, action: string, s: Session, submit: string, opts: { id?: string } = {}) {
  const field = (f0: Field) => {
    // (sprint 230) the property's name in the builder's language (pe.<kind>.<field>), when it has one
    const f = { ...f0, label: scopedTx.dyn(`pe.${kind}.${f0.name}`, f0.label) };
    const v = f.valueBy ? f.valueBy(row ?? {}) : row?.[f.name];
    const own = row?.id ? f.helpBy?.(row) : null;
    const help = own
      ? html`<small class="help">${own.text}${own.url ? html` <a href="${own.url}" target="_blank" rel="noopener">Guide ▸</a>` : ''}</small>`
      : f.help ? html`<small class="help">${f.help}</small>` : '';
    const id = `f_${kind}_${f.name}`;
    let control: Raw;
    const opts = (list: [string, string][]) =>
      html`<select id="${id}" name="${f.name}">${list.map(([val, label]) => html`<option value="${val}"${String(v ?? '') === val ? raw(' selected') : ''}>${label}</option>`)}</select>`;
    switch (f.kind) {
      case 'bool':
        return html`<div class="field" data-prop="${f.name}"><span class="label" aria-hidden="true"></span><label class="check"><input type="checkbox" name="${f.name}" value="true"${v ? raw(' checked') : ''}> ${f.label}</label>${help}</div>`;
      case 'options': {
        const chosen: unknown[] = Array.isArray(v) ? v : [];
        return html`<fieldset class="field options-field"${f.wide ? raw(' data-wide') : ''}><legend class="label">${f.label}</legend>
          ${(f.choices ?? []).map((c) => html`<label class="check"><input type="checkbox" name="${f.name}" value="${c.cls}"${chosen.includes(c.cls) ? raw(' checked') : ''}> ${c.label} <code>${c.cls}</code></label>`)}${help}</fieldset>`;
      }
      case 'select':
        // (sprint 202, AX-3) a type list shows the types' names (Interactive Report, Popup LOV, Set Value …), not their codes
        // (sprint 231, AX-14) a region's Type list names each built-in template component (Badge, Metric Card …)
        control = opts((kind === 'region' && f.name === 'type' ? withComponentTypes(f.options!) : f.options!).map((o) => [o, optionName(kind, f.name, o) ?? (o || (f.emptyLabel ? scopedTx.dyn(`pe.${kind}.${f.name}.none`, f.emptyLabel) : '- none -'))]));
        break;
      case 'icon':
        return iconPicker(id, f.name, f.label, String(v ?? ''), help);
      case 'region':
        // (172) a region's parent: another region of the page that is not a sub region itself
        control = opts([['', '- none (page level) -'], ...lk.regions.filter((r) => f.name !== 'parent_id' || (r.id !== row?.id && r.parent_id == null))
          .map((r): [string, string] => [String(r.id), `${r.title ?? '(untitled)'} (${typeName('region', r.type)})`])]);
        break;
      case 'page':
        control = opts([['', '- none -'], ...lk.pages.map((p): [string, string] => [String(p.page_no), `${p.page_no}. ${p.name}`])]);
        break;
      case 'nav':
        control = opts([['', '- top level -'], ...lk.nav.filter((n) => n.id !== row?.id).map((n): [string, string] => [String(n.id), n.label])]);
        break;
      case 'list_name': {
        const list: [string, string][] = lk.lists.map((n): [string, string] => [n, n]);
        if (v && !lk.lists.includes(v)) list.push([v, `${v} (missing!)`]);
        control = opts(list);
        break;
      }
      case 'automation_name': {
        const list: [string, string][] = lk.automations.map((n): [string, string] => [n, n]);
        if (v && !lk.automations.includes(v)) list.push([v, `${v} (missing!)`]);
        control = opts(list);
        break;
      }
      case 'list_parent':
        control = opts([['', '- top level -'], ...lk.listEntries.filter((n) => n.id !== row?.id && (!row?.list_name || n.list_name === row.list_name)).map((n): [string, string] => [String(n.id), `${n.list_name}: ${n.label}`])]);
        break;
      case 'authz': {
        const names = ['MUST_NOT_BE_PUBLIC_USER', ...lk.authz];
        const list: [string, string][] = [['', '- none -'], ...names.flatMap((n): [string, string][] => [[n, n], [`!${n}`, `Not ${n}`]])];
        if (v && !list.some(([x]) => x === v)) list.push([v, `${v} (missing!)`]);
        control = opts(list);
        break;
      }
      case 'build_option':
        control = opts(buildOptionChoices(lk, v));
        break;
      case 'rest_source': {
        const list: [string, string][] = [['', '- none (SQL) -'], ...lk.restSources.map((n): [string, string] => [n, n])];
        if (v && !lk.restSources.includes(v)) list.push([v, `${v} (missing!)`]);
        control = opts(list);
        break;
      }
      case 'secret':
        // write-only: the stored value is never sent to the browser
        control = html`<input id="${id}" name="${f.name}" type="password" value="" autocomplete="new-password" spellcheck="false" placeholder="${row?.[`${f.name}_enc`] ? '•••••••• (stored; type to replace)' : ''}">`;
        break;
      case 'code':
        control = html`<textarea id="${id}" name="${f.name}" class="code" rows="${f.wide ? 7 : 2}" spellcheck="false"${codeAttrs(kind, f, row)}>${v ?? ''}</textarea>`;
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
        control = html`<textarea id="${id}" name="${f.name}" class="code" rows="${f.wide ? 4 : 2}" spellcheck="false"${f.readonly ? raw(' readonly') : ''}${codeAttrs(kind, f, row)}>${text}</textarea>`;
        break;
      }
      default:
        control = html`<input id="${id}" name="${f.name}" type="${f.kind === 'int' ? 'number' : 'text'}" value="${v ?? ''}">`;
    }
    // (sprint 230) a value shown only (Audit Information): an output, nothing posted
    if (f.virtual) return html`<div class="field" data-prop="${f.name}"${f.wide ? raw(' data-wide') : ''}><span class="label" id="${id}_label">${f.label}</span><output id="${id}" class="pe-value" aria-labelledby="${id}_label">${String(v ?? '') || '—'}</output>${help}</div>`;
    return html`<div class="field" data-prop="${f.name}"${f.wide ? raw(' data-wide') : ''}><label class="label" for="${id}">${f.label}</label>${control}${help}</div>`;
  };
  // (sprint 202, AX-2) a field the property editor leaves out (a region's settings: Attributes tab, Utilities → Show as JSON)
  const fields = spec.fields.filter((f) => !f.hidden);
  const groups = [...new Set(fields.map((f) => f.group ?? ''))];
  // (sprint 77, APEX: Show Common / Show All) the other properties are marked, for the property editor's toggle
  const marked = fields.some((f) => f.common);
  const shown = (f: Field) => (marked && !f.common ? html`<div class="pe-more" data-more>${field(f)}</div>` : field(f));
  return html`<form method="post" action="${action}" class="component-form"${opts.id ? html` id="${opts.id}"` : ''}>
    ${csrf(s)}
    ${groups.map((g) => html`<fieldset class="prop-group">${g ? html`<legend>${scopedTx.dyn(`pe.group.${g.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`, g)}</legend>` : ''}<div class="form-grid">${fields.filter((f) => (f.group ?? '') === g).map(shown)}</div></fieldset>`)}
    ${submit ? html`<div class="buttons"><button class="btn btn-hot">${submit}</button></div>` : ''}
  </form>`;
}

export async function saveComponent(kind: string, parentCol: 'page_id' | 'app_id', parentId: string, cid: string | undefined, body: Body) {
  const spec = COMPONENTS[kind];
  const values = parseFields(spec, body);
  const problem = spec.validate?.(values);
  if (problem) throw new Error(problem);
  await spec.beforeSave?.(values, cid, parentId);
  // (sprint 230) keys of the config the form edits as fields: merged after the row is saved
  const patch = values.__config as Record<string, unknown> | undefined;
  delete values.__config;
  const id = await saveRow(spec, parentCol, parentId, cid, values);
  if (patch && Object.keys(patch).length) {
    const drop = Object.keys(patch).filter((k) => patch[k] === null || patch[k] === undefined);
    const keep = Object.fromEntries(Object.entries(patch).filter(([k]) => !drop.includes(k)));
    await owner.query(`update ${spec.table} set config = (coalesce(config, '{}'::jsonb) - $2::text[]) || $3::jsonb where id = $1`, [id, drop, JSON.stringify(keep)]);
  }
  return id;
}

async function saveRow(spec: ComponentSpec, parentCol: 'page_id' | 'app_id', parentId: string, cid: string | undefined, values: Record<string, unknown>) {
  // region fields only take regions of the same page
  if (parentCol === 'page_id')
    for (const f of spec.fields)
      if (f.kind === 'region' && values[f.name] != null && !(await owner.one('select 1 as ok from meta.region where id = $1 and page_id = $2', [values[f.name], parentId])))
        throw new Error(`${f.label}: that region is not on this page.`);
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
