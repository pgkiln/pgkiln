import type { FastifyInstance } from 'fastify';
import { owner } from '../db.ts';
import { html, raw, type Raw } from '../html.ts';
import { aiFilterProblems } from '../runtime/ai-filter.ts';
import { assistantProblems, type AssistantConfig } from '../runtime/assistant.ts';
import type { Session } from '../session.ts';
import { back, BASE, csrf, developer, flash, type Req } from './ui.ts';

// Page designer → an AI assistant region → Settings (service, prompts,
// context queries, tools, limits), and → a report region → "Ask in your own
// words" (natural-language filters with an AI service). Saving replaces only
// the keys these forms know.

type Config = Record<string, any>;
type Body = Record<string, string | undefined>;

const opt = (value: string, label: string, current: unknown) => html`<option value="${value}"${String(current ?? '') === value ? raw(' selected') : ''}>${label}</option>`;

/** The AI services an application may use, plus `current` when it names another one. */
async function serviceOptions(appId: number, current: unknown) {
  const allowed = (await owner.query<{ name: string; provider: string; model: string }>(
    `select s.name, s.provider, s.model from meta.ai_service s join meta.app_ai_service x on x.service_id = s.id and x.app_id = $1 where s.enabled order by s.name`, [appId])).rows;
  const cur = typeof current === 'string' ? current.toUpperCase() : '';
  return {
    allowed,
    options: html`${allowed.map((x) => opt(x.name, `${x.name} (${x.provider === 'anthropic' ? 'Claude' : 'OpenAI'}, ${x.model})`, cur))}${cur && !allowed.some((x) => x.name === cur) ? opt(cur, `${cur} (not available to this application)`, cur) : ''}`,
  };
}

const NO_SERVICE = html`<p class="muted">This application may not use any AI service yet: an administrator adds one under <a href="${BASE}/ai">Workspace utilities → AI services</a> and allows this application to use it.</p>`;

const json = (v: unknown) => (v === undefined ? '' : JSON.stringify(v, null, 2));

export async function assistantSettingsForm(pageId: number, appId: number, r: { id: number; config: Config }, s: Session): Promise<Raw> {
  const cfg = (r.config ?? {}) as AssistantConfig;
  const id = (n: string) => `ra_${r.id}_${n}`;
  const { allowed, options } = await serviceOptions(appId, cfg.service);
  const problems = assistantProblems(cfg);
  return html`<h3 class="u-mt15">AI assistant settings</h3>
    <p class="muted u-mt0">A chat with an AI service. What users type, the context rows and the tools' results go to the service's provider (Claude or OpenAI). Context queries and SQL tools run as the application's database role; SQL tools are rolled back unless they may change data.</p>
    ${allowed.length ? '' : NO_SERVICE}
    ${problems.length ? html`<div class="alert alert-error" role="alert">${problems.join(' ')}</div>` : ''}
    <form method="post" action="${BASE}/pages/${pageId}/region/${r.id}/assistant" class="component-form">${csrf(s)}
      <fieldset class="prop-group"><legend>Assistant</legend><div class="form-grid">
        <div class="field"><label class="label" for="${id('service')}">AI service</label>
          <select id="${id('service')}" name="service" required>${opt('', '- choose -', cfg.service ?? '')}${options}</select></div>
        <div class="field"><label class="label" for="${id('max_rounds')}">Tool rounds per question</label>
          <input id="${id('max_rounds')}" name="max_rounds" type="number" min="1" max="10" value="${cfg.max_rounds ?? ''}" placeholder="5"></div>
        <div class="field"><label class="label" for="${id('max_turns')}">Questions per conversation</label>
          <input id="${id('max_turns')}" name="max_turns" type="number" min="1" max="100" value="${cfg.max_turns ?? ''}" placeholder="20"></div>
        <div class="field" data-wide><label class="label" for="${id('system')}">System prompt</label>
          <textarea id="${id('system')}" name="system" rows="4">${cfg.system ?? ''}</textarea>
          <small class="help">Who the assistant is and what it may answer. <code>&amp;ITEM.</code> is replaced by the item's value as delimited data (never the session id or passwords).</small></div>
        <div class="field" data-wide><label class="label" for="${id('welcome')}">Welcome text</label>
          <textarea id="${id('welcome')}" name="welcome" rows="2">${cfg.welcome ?? ''}</textarea></div>
        <div class="field"><label class="label" for="${id('placeholder')}">Placeholder</label>
          <input id="${id('placeholder')}" name="placeholder" maxlength="200" value="${cfg.placeholder ?? ''}"></div>
        <div class="field"><label class="label" for="${id('error_message')}">Error message</label>
          <input id="${id('error_message')}" name="error_message" maxlength="300" value="${cfg.error_message ?? ''}" placeholder="the service's message"></div>
      </div>
      <div class="field"><label class="check"><input type="checkbox" name="public" value="true"${cfg.public ? raw(' checked') : ''}> Also for users who are not signed in (every question costs tokens)</label></div></fieldset>
      <fieldset class="prop-group"><legend>Context and tools</legend>
        <div class="field"><label class="label" for="${id('context')}">Context queries (JSON)</label>
          <textarea id="${id('context')}" name="context" rows="5" class="code" spellcheck="false">${json(cfg.context)}</textarea>
          <small class="help">Run before each question; their rows go to the model as data. <code>[{"name": "policy", "sql": "select title, body from hr.policy where body @@ plainto_tsquery(:AI_PROMPT)", "max_rows": 5}]</code> (<code>:AI_PROMPT</code> is the question, <code>:APP_USER</code> and items as usual).</small></div>
        <div class="field"><label class="label" for="${id('tools')}">Tools (JSON)</label>
          <textarea id="${id('tools')}" name="tools" rows="10" class="code" spellcheck="false">${json(cfg.tools)}</textarea>
          <small class="help">The model calls them when it needs to. SQL: <code>{"name": "my_leave", "description": "…", "sql": "select … where status = :STATUS", "parameters": {"STATUS": {"type": "string", "enum": ["PENDING", "APPROVED"]}}}</code>; add <code>"writes": true</code> for a tool that changes data and <code>"authz": "SCHEME"</code> to offer it only to some users. REST: <code>{"name": "department", "type": "rest", "source": "DEPARTMENT", "description": "…", "parameters": {"dname": {"type": "string"}}}</code>. Parameter types: string, integer, number, boolean, date; <code>"optional": true</code> allows none.</small></div>
      </fieldset>
      <div class="buttons"><button class="btn btn-hot">Save AI assistant settings</button></div>
    </form>`;
}

/** Problems that need the application: unknown REST data sources and authorization schemes in tools. */
async function appProblems(appId: number, cfg: AssistantConfig) {
  const out: string[] = [];
  const sources = new Set((await owner.query<{ name: string }>('select name from meta.rest_source where app_id = $1', [appId])).rows.map((x) => x.name));
  const schemes = new Set((await owner.query<{ name: string }>('select name from meta.authz_scheme where app_id = $1', [appId])).rows.map((x) => x.name.toUpperCase()));
  for (const t of Array.isArray(cfg.tools) ? cfg.tools : []) {
    if (t?.type === 'rest' && typeof t.source === 'string' && !sources.has(t.source.toUpperCase())) out.push(`Tool "${t.name}": there is no REST data source ${t.source.toUpperCase()}.`);
    if (typeof t?.authz === 'string' && t.authz.trim() && !['MUST_NOT_BE_PUBLIC_USER'].includes(t.authz.replace(/^!/, '').trim().toUpperCase()) && !schemes.has(t.authz.replace(/^!/, '').trim().toUpperCase()))
      out.push(`Tool "${t.name}": there is no authorization scheme ${t.authz}.`);
  }
  return out;
}

/** The posted settings merged into the region's config; problems of the result (it is saved anyway). */
export async function mergeAssistantSettings(appId: number, config: Config, b: Body) {
  const out: Config = { ...config };
  const errors: string[] = [];
  const text = (k: string, max: number) => {
    const v = (b[k] ?? '').replace(/\r\n?/g, '\n').trim().slice(0, max);
    if (v) out[k] = v;
    else delete out[k];
  };
  out.service = (b.service ?? '').trim().toUpperCase();
  if (!out.service) delete out.service;
  text('system', 20_000);
  text('welcome', 2000);
  text('placeholder', 200);
  text('error_message', 300);
  for (const k of ['max_rounds', 'max_turns']) {
    const v = (b[k] ?? '').trim();
    if (v) out[k] = Number(v);
    else delete out[k];
  }
  if (b.public === 'true') out.public = true;
  else delete out.public;
  for (const k of ['context', 'tools']) {
    const v = (b[k] ?? '').trim();
    if (!v) delete out[k];
    else
      try {
        out[k] = JSON.parse(v);
      } catch {
        errors.push(`${k === 'tools' ? 'Tools' : 'Context queries'}: not valid JSON (kept as it was).`);
      }
  }
  errors.push(...assistantProblems(out), ...(await appProblems(appId, out as AssistantConfig)));
  return { config: out, errors };
}

/** The "Ask in your own words" settings under a report region. */
export async function aiFilterSettingsForm(pageId: number, appId: number, r: { id: number; config: Config }, s: Session): Promise<Raw> {
  const cfg = (r.config?.ai_filter ?? {}) as Config;
  const id = (n: string) => `raf_${r.id}_${n}`;
  const { allowed, options } = await serviceOptions(appId, cfg.service);
  return html`<h3 class="u-mt15">Ask in your own words (AI)</h3>
    <p class="muted u-mt0">Users type a question; an AI service turns it into the report's filters, search and sort (only columns the report shows, only its operators). The question and the column names go to the service's provider.</p>
    ${allowed.length || cfg.service ? '' : NO_SERVICE}
    <form method="post" action="${BASE}/pages/${pageId}/region/${r.id}/ai-filter" class="component-form">${csrf(s)}
      <div class="form-grid">
        <div class="field"><label class="label" for="${id('service')}">AI service</label>
          <select id="${id('service')}" name="service">${opt('', '- off -', cfg.service ?? '')}${options}</select></div>
        <div class="field" data-wide><label class="label" for="${id('placeholder')}">Placeholder</label>
          <input id="${id('placeholder')}" name="placeholder" maxlength="200" value="${cfg.placeholder ?? ''}"></div>
      </div>
      <div class="field"><label class="check"><input type="checkbox" name="public" value="true"${cfg.public ? raw(' checked') : ''}> Also for users who are not signed in</label></div>
      <div class="buttons"><button class="btn">Save</button></div>
    </form>`;
}

export async function assistantBuilderRoutes(app: FastifyInstance) {
  const regionOf = async (pid: string, rid: string, type: string) =>
    /^\d{1,9}$/.test(pid) && /^\d{1,9}$/.test(rid)
      ? owner.one<{ id: number; config: Config; app_id: number }>(
          `select r.id, r.config, p.app_id from meta.region r join meta.page p on p.id = r.page_id where r.id = $1 and r.page_id = $2 and r.type = $3`, [rid, pid, type])
      : undefined;

  app.post(`${BASE}/pages/:pid/region/:rid/assistant`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const { pid, rid } = req.params as { pid: string; rid: string };
    const r = await regionOf(pid, rid, 'ai_assistant');
    if (!r) return reply.code(404).send('Not found');
    const { config, errors } = await mergeAssistantSettings(r.app_id, r.config ?? {}, (req.body ?? {}) as Body);
    await owner.query('update meta.region set config = $2 where id = $1', [r.id, JSON.stringify(config)]);
    if (errors.length) flash(s, `Saved, but: ${errors.join(' ')}`, 'error');
    else flash(s, 'Settings saved.');
    return back(reply, s, `${BASE}/pages/${pid}?c=region-${rid}`);
  });

  app.post(`${BASE}/pages/:pid/region/:rid/ai-filter`, async (req: Req, reply) => {
    const s = await developer(req, reply);
    if (!s) return;
    const { pid, rid } = req.params as { pid: string; rid: string };
    const r = await regionOf(pid, rid, 'report');
    if (!r) return reply.code(404).send('Not found');
    const b = (req.body ?? {}) as Body;
    const config: Config = { ...(r.config ?? {}) };
    const service = (b.service ?? '').trim().toUpperCase();
    if (!service) delete config.ai_filter;
    else {
      const placeholder = (b.placeholder ?? '').trim().slice(0, 200);
      config.ai_filter = { service, ...(placeholder ? { placeholder } : {}), ...(b.public === 'true' ? { public: true } : {}) };
    }
    const errors = aiFilterProblems(config.ai_filter);
    if (errors.length) flash(s, errors.join(' '), 'error');
    else {
      await owner.query('update meta.region set config = $2 where id = $1', [r.id, JSON.stringify(config)]);
      flash(s, 'Settings saved.');
    }
    return back(reply, s, `${BASE}/pages/${pid}?c=region-${rid}`);
  });
}
