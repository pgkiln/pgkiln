// (sprint 157, CD-4) Declarative process types APEX applications rely on (migration 150). Each one calls what pgkiln
// already has: session state, user preferences, the geocoder, document templates, human tasks.
import type { Process } from '../metadata.ts';
import { geocode, geocoderUrl } from '../geocode.ts';
import { substitute, toState, type PageContext } from './context.ts';
import { renderDocument } from './documents.ts';

const ITEM = /^[A-Z][A-Z0-9_]{0,99}$/;
const NAME = /^[A-Z][A-Z0-9_]{0,59}$/;
const isItem = (x: unknown) => typeof x === 'string' && ITEM.test(x);
const items = (x: unknown) => Array.isArray(x) && x.every(isItem);
const text = (x: unknown) => x === undefined || typeof x === 'string';

export const DECLARATIVE_PROCESS_TYPES = new Set(['close_dialog', 'clear_session_state', 'reset_pagination', 'user_preferences', 'server_geocoding',
  'print_report', 'human_task_create', 'human_task_manage', 'form_init']);
const TASK_ACTIONS = ['approve', 'reject', 'complete', 'claim', 'release', 'delegate', 'cancel'];

/** Problems with a declarative process's config (the builder shows them; running refuses them). */
export function declarativeProblems(type: string, conf: unknown): string[] {
  const c = (conf ?? {}) as Record<string, any>;
  const out: string[] = [];
  switch (type) {
    case 'close_dialog':
      if (c.items !== undefined && !items(c.items)) out.push('"items" is a list of item names, e.g. ["P5_ID"].');
      break;
    case 'clear_session_state':
      if (c.items !== undefined && !items(c.items)) out.push('"items" is a list of item names.');
      if (c.pages !== undefined && !(Array.isArray(c.pages) && c.pages.every((n: unknown) => Number.isInteger(n) && (n as number) > 0))) out.push('"pages" is a list of page numbers.');
      if (c.all !== undefined && typeof c.all !== 'boolean') out.push('"all" is true or false.');
      if (!c.items && !c.pages && !c.all) out.push('Name "items", "pages" or "all": true.');
      break;
    case 'user_preferences':
      if (!['set', 'reset'].includes(c.action ?? 'set')) out.push('"action" is set or reset.');
      if (typeof c.preference !== 'string' || !NAME.test(c.preference.toUpperCase())) out.push('"preference" is a name, e.g. DEFAULT_DEPT.');
      if ((c.action ?? 'set') === 'set' && !isItem(c.item)) out.push('"item" names the item whose value is stored.');
      break;
    case 'server_geocoding':
      if (!isItem(c.address_item)) out.push('"address_item" is the item with the address.');
      if (!isItem(c.coordinates_item)) out.push('"coordinates_item" is the item that gets "lat,lng".');
      if (c.country !== undefined && !(typeof c.country === 'string' && /^[a-z]{2}(,[a-z]{2})*$/i.test(c.country))) out.push('"country" is a country code, e.g. nl.');
      break;
    case 'print_report':
      if (typeof c.document !== 'string' || !NAME.test(c.document.toUpperCase())) out.push('"document" names a document template or report query.');
      break;
    case 'human_task_create':
      if (typeof c.definition !== 'string' || !NAME.test(c.definition.toUpperCase())) out.push('"definition" names a task definition, e.g. LEAVE_APPROVAL.');
      if (!text(c.detail_pk)) out.push('"detail_pk" is text, e.g. "&P7_ID.".');
      if (c.parameters !== undefined && (typeof c.parameters !== 'object' || c.parameters === null || Array.isArray(c.parameters) || Object.values(c.parameters).some((v) => typeof v !== 'string')))
        out.push('"parameters" maps parameter names to values, e.g. {"DAYS": "&P7_DAYS."}.');
      if (c.id_item !== undefined && !isItem(c.id_item)) out.push('"id_item" is an item name.');
      break;
    case 'human_task_manage':
      if (!TASK_ACTIONS.includes(c.action)) out.push(`"action" is one of ${TASK_ACTIONS.join(', ')}.`);
      if (typeof c.task !== 'string' || !c.task) out.push('"task" is the task id, e.g. "&P8_TASK_ID.".');
      if (c.action === 'complete' && (typeof c.outcome !== 'string' || !NAME.test(c.outcome.toUpperCase()))) out.push('"outcome" names the outcome, e.g. APPROVED.');
      if (c.action === 'delegate' && (typeof c.to !== 'string' || !c.to)) out.push('"to" is the user it goes to, e.g. "&P8_TO.".');
      if (!text(c.comment)) out.push('"comment" is text.');
      break;
  }
  return out;
}

/** Run a declarative process; its success message (or a default) is the answer. */
export async function runDeclarative(ctx: PageContext, p: Process, assignable: Set<string>): Promise<string | null> {
  const conf = (p.config ?? {}) as Record<string, any>;
  const problems = declarativeProblems(p.type, conf);
  if (problems.length) throw new Error(`Process "${p.name}": ${problems.join(' ')}`);
  const c = ctx.client!;
  const value = (s: unknown) => (typeof s === 'string' ? substitute(s, ctx, (x) => x) : null);
  const state = ctx.session.state;
  const assign = (name: string, v: string | null) => {
    if (!assignable.has(name)) throw new Error(`Process "${p.name}": ${name} is not an item of this page or an application item.`);
    state[name] = v;
  };
  switch (p.type) {
    case 'form_init':
      return null;
    case 'close_dialog':
      ctx.closeDialog = Object.fromEntries(((conf.items ?? []) as string[]).map((n) => [n, state[n] ?? '']));
      return p.success_message;
    case 'reset_pagination':
      ctx.resetPagination = true;
      return p.success_message;
    case 'clear_session_state': {
      const names = new Set<string>(conf.items ?? []);
      const prefixes = ((conf.pages ?? []) as number[]).map((n) => `P${n}_`);
      for (const k of Object.keys(state)) {
        if (k.startsWith('__')) continue;
        if (names.has(k) || prefixes.some((x) => k.startsWith(x)) || (conf.all === true && (/^P\d+_/.test(k) || ctx.app.app_items.includes(k)))) state[k] = null;
      }
      return p.success_message;
    }
    case 'user_preferences': {
      // the public user has no preferences (as meta.get_preference): nothing to store
      if (ctx.user === 'nobody') return null;
      const name = String(conf.preference).toUpperCase();
      if ((conf.action ?? 'set') === 'reset') await c.query('select meta.remove_preference($1)', [name]);
      else await c.query('select meta.set_preference($1, $2)', [name, state[conf.item] ?? null]);
      return p.success_message;
    }
    case 'server_geocoding': {
      const address = (state[conf.address_item] ?? '').trim();
      if (!address) return null;
      if (!geocoderUrl()) throw new Error(ctx.locale.t('process.no_geocoder'));
      const [first] = await geocode(address, { language: ctx.locale.lang, country: conf.country ?? null });
      if (!first) throw new Error(ctx.locale.t('process.address_not_found', { address }));
      assign(conf.coordinates_item, `${first.lat.toFixed(6)},${first.lon.toFixed(6)}`);
      return p.success_message;
    }
    case 'print_report': {
      const doc = await renderDocument(ctx, String(conf.document), true);
      // the first file of a request wins (as for download processes)
      ctx.download ??= 'download' in doc ? doc.download : { content: doc.file, name: doc.name, type: doc.type, inline: false };
      return null;
    }
    case 'human_task_create': {
      const params = Object.fromEntries(Object.entries((conf.parameters ?? {}) as Record<string, string>).map(([k, v]) => [k.toUpperCase(), value(v)]));
      const id = (await c.query('select meta.create_task($1, $2, $3::jsonb)::text as id', [String(conf.definition).toUpperCase(), value(conf.detail_pk) || null, JSON.stringify(params)])).rows[0].id as string;
      if (conf.id_item) assign(conf.id_item, toState(id));
      return p.success_message ?? ctx.locale.t('process.task_created', { id });
    }
    case 'human_task_manage': {
      const id = (value(conf.task) ?? '').trim();
      if (!/^\d{1,18}$/.test(id)) throw new Error(ctx.locale.t('process.no_task'));
      const comment = value(conf.comment) || null;
      switch (conf.action) {
        case 'approve': await c.query('select meta.complete_task($1::bigint, $2, $3)', [id, 'APPROVED', comment]); break;
        case 'reject': await c.query('select meta.complete_task($1::bigint, $2, $3)', [id, 'REJECTED', comment]); break;
        case 'complete': await c.query('select meta.complete_task($1::bigint, $2, $3)', [id, String(conf.outcome).toUpperCase(), comment]); break;
        case 'claim': await c.query('select meta.claim_task($1::bigint)', [id]); break;
        case 'release': await c.query('select meta.release_task($1::bigint)', [id]); break;
        case 'delegate': await c.query('select meta.delegate_task($1::bigint, $2)', [id, value(conf.to)]); break;
        case 'cancel': await c.query('select meta.cancel_task($1::bigint, $2)', [id, comment]); break;
      }
      return p.success_message;
    }
  }
  return null;
}
