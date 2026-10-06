// Plug-ins with their own code (migration 069; APEX: region, item, dynamic
// action and process plug-ins). A plug-in brings custom attributes, static
// application files (068) and, by type:
//
// - region: a template component that renders it (allow-listed HTML, like
//   any template component), inside an element app.js hands to the plug-in's
//   JavaScript;
// - item: a text field the plug-in's JavaScript may enhance (its value is
//   posted and stored like any text item, so the page works without it);
// - dynamic action: a function of the plug-in's JavaScript;
// - process: a PL/pgSQL function schema.fn(attributes jsonb) returning its
//   message, run as the application's role like any page process.
//
// JavaScript only ever comes from the plug-in's static files (same origin,
// so the CSP stays script-src 'self'); it registers with
// pgapex.plugins.register(name, fn). The page tells it the plug-in's name
// and attribute values in data-plugin / data-plugin-attrs.
import { html, type Raw } from '../html.ts';
import type { Region } from '../metadata.ts';
import type { PageContext } from './context.ts';
import { attributesProblem, componentProblem, fillAttribute, type TcAttribute, type TemplateComponent } from './template-components.ts';
import { staticType } from './static-files.ts';

export const PLUGIN_FORMAT_2 = 'pgapex-plugin/2';
export const PLUGIN_TYPES = ['region', 'item', 'dynamic_action', 'process'] as const;
export type PluginType = (typeof PLUGIN_TYPES)[number];

export interface Plugin {
  name: string;
  type: PluginType;
  label: string;
  version?: string | null;
  help?: string | null;
  attributes: TcAttribute[];
  files: string[];
  template_component: string | null;
  sql_function: string | null;
  install_sql?: string | null;
}

/** How a region, item, process or dynamic action uses a plug-in (its config). */
export interface PluginUse {
  plugin?: string;
  attributes?: Record<string, string>;
}

const NAME = /^[a-z][a-z0-9_]{0,59}$/;
const FUNCTION = /^[a-z_][a-z0-9_]{0,62}\.[a-z_][a-z0-9_]{0,62}$/;

/** The application's plug-in of this type with this name. */
export function pluginOf(ctx: PageContext, name: unknown, type: PluginType) {
  return (ctx.app.plugins ?? []).find((p) => p.name === name && p.type === type);
}

/** Each declared attribute's value where the plug-in is used (or its default), with &ITEM. filled in. */
export function pluginAttributes(ctx: PageContext | null, p: Plugin, use: PluginUse | null | undefined) {
  const out: Record<string, string> = {};
  for (const a of p.attributes ?? []) {
    let v = String(use?.attributes?.[a.name] ?? a.default ?? '');
    v = fillAttribute(v, ctx, () => undefined);
    if (a.type === 'checkbox') v = /^(y|yes|true|1|on)$/i.test(v) ? 'Y' : 'N';
    out[a.name] = v;
  }
  return out;
}

/** data-plugin and data-plugin-attrs for the element the plug-in's JavaScript receives. */
export const pluginData = (name: string, attrs: Record<string, string>) => html` data-plugin="${name}" data-plugin-attrs="${JSON.stringify(attrs)}"`;

/** The plug-ins the current page uses (their files are loaded with the page). */
export function pluginsOnPage(ctx: PageContext) {
  const used = new Set<string>();
  const add = (name: unknown, type: PluginType) => {
    const p = pluginOf(ctx, name, type);
    if (p) used.add(p.name);
  };
  for (const r of ctx.page.regions) if (r.type === 'plugin') add(r.config?.plugin, 'region');
  for (const i of ctx.page.items) if (i.type === 'plugin') add(i.config?.plugin, 'item');
  for (const d of ctx.page.dynamic_actions) if (d.action === 'plugin') add(d.code?.trim(), 'dynamic_action');
  return (ctx.app.plugins ?? []).filter((p) => used.has(p.name));
}

/** A region plug-in: its template component inside the element its JavaScript gets. */
export async function renderPluginRegion(ctx: PageContext, r: Region, renderTemplate: (ctx: PageContext, r: Region) => Promise<Raw>): Promise<Raw> {
  const use = (r.config ?? {}) as PluginUse;
  const p = pluginOf(ctx, use.plugin, 'region');
  if (!p) return html`<div class="alert alert-error" role="alert">${ctx.locale.t('plugin.missing', { name: String(use.plugin ?? '') })}</div>`;
  const attrs = pluginAttributes(ctx, p, use);
  const body = p.template_component
    ? await renderTemplate(ctx, { ...r, config: { ...r.config, component: p.template_component, attributes: { ...(r.config?.attributes ?? {}), ...attrs } } })
    : '';
  return html`<div class="plugin-region"${pluginData(p.name, attrs)}>${body}</div>`;
}

/** A process plug-in: its function with the attribute values; the text it returns is the message. */
export async function runPluginProcess(ctx: PageContext, config: PluginUse | null | undefined, name: string) {
  const p = pluginOf(ctx, config?.plugin, 'process');
  if (!p || !p.sql_function || !FUNCTION.test(p.sql_function)) throw new Error(`Process "${name}": there is no process plug-in "${String(config?.plugin ?? '')}".`);
  const res = await ctx.client!.query<{ m: string | null }>(`select ${p.sql_function}($1::jsonb)::text as m`, [JSON.stringify(pluginAttributes(ctx, p, config))]);
  return res.rows[0]?.m ?? null;
}

// ---------------------------------------------------------------- plug-in files

export interface PluginFile {
  name: string;
  mime: string;
  content: string;
}

export interface PluginDocument {
  plugin: Plugin;
  files: PluginFile[];
  component: TemplateComponent | null;
}

/** A plug-in file (format pgapex-plugin/2) → what to install, or the reason it can't be. */
export function parsePluginDocument(doc: unknown): PluginDocument | string {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return 'A plug-in file is a JSON object.';
  const d = doc as Record<string, any>;
  if (d.format !== PLUGIN_FORMAT_2) return `Unsupported plug-in format ${JSON.stringify(d.format ?? null)} (expected ${PLUGIN_FORMAT_2}).`;
  if (!(PLUGIN_TYPES as readonly string[]).includes(d.type)) return `The type is one of ${PLUGIN_TYPES.join(', ')}.`;
  if (typeof d.name !== 'string' || !NAME.test(d.name)) return 'Name: lower case letters, digits and _ (e.g. star_slider).';
  if (typeof d.label !== 'string' || !d.label.trim() || d.label.length > 100) return 'Label: required, up to 100 characters.';
  for (const k of ['version', 'help', 'install_sql', 'sql_function'])
    if (d[k] !== undefined && d[k] !== null && typeof d[k] !== 'string') return `"${k}" is text.`;
  if (d.version && !/^[0-9A-Za-z.+-]{1,30}$/.test(d.version)) return 'Version: letters, digits, ., + and - (e.g. 1.0.2).';
  const ap = attributesProblem(d.attributes ?? []);
  if (ap) return ap;
  if (d.type === 'process' && !FUNCTION.test(d.sql_function ?? '')) return 'A process plug-in names its function as schema.function (lower case), e.g. plugins.notify_team.';
  if (d.type !== 'process' && d.sql_function) return 'Only process plug-ins have a function.';
  if (d.files !== undefined && !Array.isArray(d.files)) return '"files" is a list of {"name", "content"} (content in base64).';
  const files: PluginFile[] = [];
  for (const f of d.files ?? []) {
    const type = f && typeof f.name === 'string' ? staticType(f.name) : null;
    if (!type) return `File ${JSON.stringify(f?.name ?? null)}: not an allowed name or type for a static file.`;
    if (typeof f.content !== 'string' || !/^[A-Za-z0-9+/=\s]*$/.test(f.content)) return `File ${f.name}: "content" is base64.`;
    if (files.some((x) => x.name === f.name)) return `File ${f.name}: listed twice.`;
    files.push({ name: f.name, mime: type, content: f.content.replace(/\s+/g, '') });
  }
  if (files.length > 20) return 'At most 20 files.';
  let component: TemplateComponent | null = null;
  if (d.template_component !== undefined && d.template_component !== null) {
    if (d.type !== 'region') return 'Only region plug-ins have a template component.';
    const t = d.template_component;
    if (!t || typeof t !== 'object') return '"template_component" is an object (static_id, name, template, …).';
    component = {
      static_id: t.static_id, name: t.name, description: t.description ?? null, version: t.version ?? null,
      template: t.template, wrapper: t.wrapper ?? null, css_classes: t.css_classes ?? [], attributes: t.attributes ?? d.attributes ?? [],
    };
    const problem = componentProblem(component);
    if (problem) return `Template component: ${problem}`;
  }
  return {
    plugin: {
      name: d.name, type: d.type, label: d.label.trim(), version: d.version ?? null, help: d.help ?? null, attributes: d.attributes ?? [],
      files: files.map((f) => f.name), template_component: component?.static_id ?? null, sql_function: d.sql_function ?? null, install_sql: d.install_sql ?? null,
    },
    files,
    component,
  };
}

/** A plug-in as a plug-in file, with its files and template component. */
export function pluginFileDocument(p: Plugin, files: { name: string; content: Buffer }[], component: TemplateComponent | null) {
  return {
    format: PLUGIN_FORMAT_2, type: p.type, name: p.name, label: p.label, version: p.version ?? null, help: p.help ?? null,
    attributes: p.attributes ?? [],
    files: files.map((f) => ({ name: f.name, content: f.content.toString('base64') })),
    // the template component, without what it takes from the plug-in or has empty
    ...(component ? { template_component: {
      static_id: component.static_id, name: component.name, template: component.template,
      ...(component.description ? { description: component.description } : {}),
      ...(component.wrapper ? { wrapper: component.wrapper } : {}),
      ...(component.css_classes?.length ? { css_classes: component.css_classes } : {}),
      ...(JSON.stringify(component.attributes ?? []) !== JSON.stringify(p.attributes ?? []) ? { attributes: component.attributes ?? [] } : {}),
    } } : {}),
    ...(p.sql_function ? { sql_function: p.sql_function } : {}),
    ...(p.install_sql ? { install_sql: p.install_sql } : {}),
  };
}


/**
 * A plug-in file from a source directory (pgapex plugin build): plugin.json
 * (the file without its contents), the files it lists, template.html and
 * wrapper.html for a region's template component, install.sql.
 */
export function pluginFromSources(read: (name: string) => Buffer | undefined) {
  const manifest = read('plugin.json');
  if (!manifest) throw new Error('plugin.json not found');
  let m: Record<string, any>;
  try {
    m = JSON.parse(manifest.toString('utf8'));
  } catch (e) {
    throw new Error(`plugin.json: ${(e as Error).message}`);
  }
  const text = (name: string) => read(name)?.toString('utf8');
  const doc: Record<string, any> = { format: PLUGIN_FORMAT_2, ...m };
  doc.files = (m.files ?? []).map((name: unknown) => {
    const content = typeof name === 'string' && !name.includes('/') ? read(name) : undefined;
    if (!content) throw new Error(`file ${String(name)} (listed in plugin.json) not found`);
    return { name, content: content.toString('base64') };
  });
  const template = text('template.html');
  if (template !== undefined) doc.template_component = { ...(m.template_component ?? {}), template: template.replace(/\n$/, ''), wrapper: text('wrapper.html')?.replace(/\n$/, '') ?? null };
  const install = text('install.sql');
  if (install !== undefined) doc.install_sql = install;
  const parsed = parsePluginDocument(doc);
  if (typeof parsed === 'string') throw new Error(parsed);
  return doc;
}
