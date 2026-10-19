// Sprint 111 WS-4: AI agents and AI tools (Shared Components → AI Agents),
// Gemini and OpenAI-compatible AI services, and the tool call log — against a
// scripted local mock of the Claude and OpenAI APIs (no real API calls).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';

process.env.PGKILN_SECRET_KEY ??= 'test-only-secret-key-0123456789abcdef';

const { buildApp } = await import('../src/app.ts');
const { closePools, owner } = await import('../src/db.ts');
const { encryptSecret } = await import('../src/secrets.ts');
const { urlChecksum } = await import('../src/security.ts');
const { agentProblems, aiToolProblems, definitionProblems } = await import('../src/runtime/ai-agents.ts');
const { assistantProblems } = await import('../src/runtime/assistant.ts');
const { baseUrlFor, GEMINI_BASE_URL } = await import('../src/ai/service.ts');
const { Browser } = await import('./helpers.ts');
const { startScriptMock } = await import('./ai-script-mock.ts');

let app: FastifyInstance;
let mock: Awaited<ReturnType<typeof startScriptMock>>;
let hrId: number;
let serviceId: number;
let region: number;
let saved: { ai_agents: unknown; ai_tools: unknown };
const SERVICE = 'HR_ASSISTANT';

const claudeCalls = () => mock.seen.filter((r) => r.path === '/claude/v1/messages');
const openAiCalls = () => mock.seen.filter((r) => r.path === '/openai/v1/chat/completions');

async function user(name: string) {
  const b = new Browser(app);
  assert.equal((await b.login(name)).statusCode, 303);
  await b.get('/a/hr/46');
  return b;
}
const ask = (b: InstanceType<typeof Browser>, message: string) => b.submit(`/a/hr/46/assistant/${region}/send`, { message, params: '' });
const hrefs = (body: string) => [...body.matchAll(/<div class="assistant-links"[^>]*>(.*?)<\/div>/gs)].flatMap((m) => [...m[1].matchAll(/href="([^"]+)"[^>]*>([^<]*)</g)].map((x) => ({ href: x[1].replace(/&amp;/g, '&'), label: x[2] })));

async function builder() {
  const b = new Browser(app);
  await b.get('/builder/login');
  assert.equal((await b.post('/builder/login', { __csrf: b.lastCsrf, username: 'admin', password: 'admin' })).statusCode, 303);
  return b;
}

before(async () => {
  mock = await startScriptMock();
  app = await buildApp({ logger: false });
  hrId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  saved = (await owner.one('select ai_agents, ai_tools from meta.app where id = $1', [hrId]))!;
  await owner.query(`delete from meta.ai_service where name = $1 or name like 'T_S111_%'`, [SERVICE]);
  serviceId = (await owner.one(`insert into meta.ai_service (name, provider, model, base_url, api_key_enc, effort, max_tokens) values ($1, 'anthropic', 'claude-opus-5-5', $2, $3, 'medium', 4000) returning id`,
    [SERVICE, `${mock.base}/claude`, encryptSecret('sk-ant-s111-secret')])).id;
  await owner.query(`insert into meta.app_ai_service (app_id, service_id) values ($1, $2)`, [hrId, serviceId]);
  region = (await owner.one(`select r.id from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and p.page_no = 46 and r.type = 'ai_assistant'`, [hrId])).id;
  await owner.query(`delete from meta.ai_tool_call where app_id = $1`, [hrId]);
});

after(async () => {
  await owner.query('update meta.app set ai_agents = $2, ai_tools = $3 where id = $1', [hrId, JSON.stringify(saved.ai_agents), JSON.stringify(saved.ai_tools)]);
  await owner.query(`update meta.region set config = config - 'agent' || '{"agent": "HR_AGENT"}' where id = $1`, [region]);
  await owner.query(`delete from meta.ai_service where name = $1 or name like 'T_S111_%'`, [SERVICE]);
  await owner.query(`delete from meta.ai_conversation where region_id = $1`, [region]);
  await mock.close();
  await app.close();
  await closePools();
});

describe('AI agents: definitions', () => {
  test('tools and agents are checked', () => {
    assert.deepEqual(aiToolProblems({ name: 'q', type: 'sql', description: 'd', sql: 'select 1' }), []);
    assert.ok(aiToolProblems({ name: 'q', type: 'sql', description: 'd', sql: 'delete from t' }).length, 'a query');
    assert.ok(aiToolProblems({ name: 'q', type: 'function', description: 'd', function: 'give_raise' }).length, 'schema-qualified');
    assert.ok(aiToolProblems({ name: 'q', type: 'function', description: 'd', function: 'hr.x(); drop table y' }).length);
    assert.ok(aiToolProblems({ name: 'q', type: 'navigate', description: 'd', pages: [] }).length, 'pages');
    assert.ok(aiToolProblems({ name: 'q', type: 'navigate', description: 'd', pages: [3], parameters: {} }).length, 'no parameters');
    assert.ok(aiToolProblems({ name: 'q', type: 'javascript', description: 'd', action: 'a b' }).length);
    assert.ok(aiToolProblems({ name: 'q', type: 'sql', description: 'd', sql: 'select 1', parameters: { APP_USER: { type: 'string' } } }).length, 'no APP_ parameters');
    assert.ok(aiToolProblems({ name: 'q', type: 'shell', description: 'd' }).length);
    assert.deepEqual(agentProblems({ name: 'A', service: 'S', tools: ['q'], effort: 'high', max_steps: 3 }, new Set(['q'])), []);
    assert.ok(agentProblems({ name: 'a', service: 'S' }, new Set()).length, 'upper case');
    assert.ok(agentProblems({ name: 'A', service: 'S', tools: ['nope'] }, new Set()).length, 'known tools');
    assert.ok(agentProblems({ name: 'A', service: 'S', effort: 'max' }, new Set()).length, 'low, medium or high');
    assert.ok(agentProblems({ name: 'A', service: 'S', max_steps: 50 }, new Set()).length);
    assert.ok(definitionProblems([{ name: 'A', service: 'S' }, { name: 'A', service: 'S' }], []).some((p) => /twice/.test(p)));
    assert.deepEqual(definitionProblems(saved.ai_agents, saved.ai_tools), [], 'the HR example is valid');
    assert.deepEqual(assistantProblems({ agent: 'HR_AGENT' }), []);
    assert.ok(assistantProblems({ agent: 'HR_AGENT', tools: [] }).length, 'the agent sets the tools');
  });

  test('providers: Gemini\'s default endpoint, others as configured', () => {
    assert.equal(baseUrlFor({ provider: 'gemini', base_url: null }), GEMINI_BASE_URL);
    assert.equal(baseUrlFor({ provider: 'gemini', base_url: 'http://x/v1' }), 'http://x/v1');
    assert.equal(baseUrlFor({ provider: 'openai', base_url: null }), undefined);
  });

  test('an OpenAI-compatible service needs a base URL (database and builder)', async () => {
    await assert.rejects(owner.query(`insert into meta.ai_service (name, provider, model) values ('T_S111_NOURL', 'openai_compatible', 'llama3')`), /ai_service_compatible_url/);
    const b = await builder();
    await b.get('/builder/ai');
    await b.submit('/builder/ai', { name: 'T_S111_NOURL', provider: 'openai_compatible', model: 'llama3', max_tokens: '1000', timeout_s: '60', enabled: 'true' });
    assert.equal((await owner.query(`select 1 from meta.ai_service where name = 'T_S111_NOURL'`)).rowCount, 0);
    await b.submit('/builder/ai', { name: 'T_S111_OLLAMA', provider: 'openai_compatible', model: 'llama3.1:8b', base_url: 'http://localhost:11434/v1', max_tokens: '1000', timeout_s: '60', enabled: 'true' });
    assert.equal((await owner.one(`select provider from meta.ai_service where name = 'T_S111_OLLAMA'`)).provider, 'openai_compatible');
    assert.match((await b.get('/builder/ai')).body, /OpenAI-compatible/);
  });

  test('export carries agents and tools; an older export imports with empty lists', async () => {
    const doc = (await owner.one(`select meta.export_app('hr') as d`)).d;
    assert.equal(doc.app.ai_agents[0].name, 'HR_AGENT');
    assert.ok(doc.app.ai_tools.some((t: any) => t.name === 'open_employee'));
    assert.doesNotMatch(JSON.stringify(doc), /sk-ant-s111-secret/);
    delete doc.app.ai_agents;
    delete doc.app.ai_tools;
    await owner.query(`delete from meta.app where alias = 't-s111-import'`);
    const id = (await owner.one(`select meta.import_app($1::jsonb, 't-s111-import') as id`, [JSON.stringify(doc)])).id;
    try {
      assert.deepEqual(await owner.one('select ai_agents, ai_tools from meta.app where id = $1', [id]), { ai_agents: [], ai_tools: [] });
    } finally {
      await owner.query('delete from meta.app where id = $1', [id]);
    }
  });
});

describe('AI agent on HR Demo (page 46)', () => {
  test('"Who in Sales earns most?": an SQL tool as the user\'s role, then a link to the record with a valid checksum', async () => {
    mock.script = [
      { tools: [{ name: 'top_earners', input: { DNAME: 'SALES' } }] },
      { tools: [{ name: 'open_employee', input: { page: 3, label: 'Open BLAKE\'s record', items: [{ name: 'P3_EMPNO', value: '7698' }] } }] },
      { text: 'BLAKE earns most in Sales: 2850.' },
      { tools: [{ name: 'top_earners', input: { DNAME: null } }] },
      { tools: [{ name: 'open_employee', input: { page: 3, label: 'Open KING\'s record', items: [{ name: 'P3_EMPNO', value: '7839' }] } }] },
      { text: 'KING earns most: 5000.' },
    ];
    const before = claudeCalls().length;
    const b = await user('king');
    assert.match((await b.get('/a/hr/46')).body, /who in Sales earns most/);
    assert.equal((await ask(b, 'Who in Sales earns most?')).statusCode, 303);
    const calls = claudeCalls().slice(before);
    assert.equal(calls.length, 3);
    const first = calls[0].body;
    assert.deepEqual(first.tools.map((t: any) => t.name), ['top_earners', 'open_employee', 'give_raise', 'note'], 'a manager is offered every tool');
    assert.deepEqual(first.output_config, { effort: 'low' }, 'the agent\'s reasoning effort');
    assert.equal(first.max_tokens, 2000, 'the agent\'s output limit');
    assert.match(first.system, /You are the HR agent/);
    const nav = first.tools.find((t: any) => t.name === 'open_employee');
    assert.deepEqual(nav.input_schema.properties.page.enum, [3]);
    assert.ok(nav.input_schema.properties.items.items.properties.name.enum.includes('P3_EMPNO'));
    const rows = JSON.parse(calls[1].body.messages[2].content[0].content).rows;
    assert.equal(rows[0].ename, 'BLAKE', 'highest salary first');
    assert.ok(rows.every((r: any) => r.dname === 'SALES'));
    let page = (await b.get('/a/hr/46')).body;
    assert.match(page, /BLAKE earns most in Sales/);
    const [blake] = hrefs(page);
    assert.equal(blake.label, 'Open BLAKE&#39;s record');
    assert.equal(blake.href, `/a/hr/3?P3_EMPNO=7698&cs=${urlChecksum(hrId, 3, 'king', { P3_EMPNO: '7698' })}`);
    const form = await b.get(blake.href);
    assert.equal(form.statusCode, 200);
    assert.match(form.body, /value="BLAKE"/, 'the employee form opens with the record');

    await ask(b, 'And who earns most overall?');
    page = (await b.get('/a/hr/46')).body;
    const king = hrefs(page).find((l) => /KING/.test(l.label))!;
    assert.equal((await b.get(king.href)).statusCode, 200);
    assert.match((await b.get(king.href)).body, /value="KING"/);

    // every tool call is logged with its arguments
    const log = (await owner.query('select agent, tool, type, arguments, status, username from meta.ai_tool_call where app_id = $1 order by id', [hrId])).rows;
    assert.deepEqual(log.slice(0, 2).map((r) => [r.agent, r.tool, r.type, r.status, r.username]), [['HR_AGENT', 'top_earners', 'sql', 'ok', 'king'], ['HR_AGENT', 'open_employee', 'navigate', 'ok', 'king']]);
    assert.deepEqual(log[0].arguments, { DNAME: 'SALES' });
    const usage = await (await builder()).get(`/builder/apps/${hrId}/ai`);
    assert.match(usage.body, /Tool calls/);
    assert.match(usage.body, /open_employee/);
    assert.match(usage.body, /P3_EMPNO/);
  });

  test('a user who may not open the employee form is not offered the link or the raise', async () => {
    mock.script = [{ tools: [{ name: 'open_employee', input: { page: 3, label: 'Open', items: [{ name: 'P3_EMPNO', value: '7788' }] } }] }, { text: 'I can\'t open that.' }];
    const before = claudeCalls().length;
    const b = await user('scott');
    await ask(b, 'Open my record');
    const [first, second] = claudeCalls().slice(before);
    assert.deepEqual(first.body.tools.map((t: any) => t.name), ['top_earners', 'note']);
    const result = second.body.messages.at(-1).content[0];
    assert.equal(result.is_error, true);
    assert.match(result.content, /no such tool/);
    assert.deepEqual(hrefs((await b.get('/a/hr/46')).body), []);
  });

  test('a function tool changes data as the application\'s role; a javascript tool runs once in the browser', async () => {
    const sal = (await owner.one('select sal from hr.emp where empno = 7369')).sal;
    mock.script = [
      { tools: [{ name: 'give_raise', input: { P_EMPNO: 7369, P_PCT: 10 } }, { name: 'note', input: { TEXT: 'Raised <b>SMITH</b>' } }] },
      { text: 'Done.' },
    ];
    try {
      const b = await user('king');
      await ask(b, 'Give SMITH a 10% raise');
      assert.equal(Number((await owner.one('select sal from hr.emp where empno = 7369')).sal), Math.round(Number(sal) * 1.1 * 100) / 100);
      const page = (await b.get('/a/hr/46')).body;
      assert.match(page, /<span hidden class="assistant-action" data-ai-action="hr_agent_note" data-ai-args="\{&quot;TEXT&quot;:&quot;Raised &lt;b&gt;SMITH&lt;\/b&gt;&quot;\}"><\/span>/);
      assert.doesNotMatch((await b.get('/a/hr/46')).body, /data-ai-action/, 'only right after the answer');
    } finally {
      await owner.query('update hr.emp set sal = $1 where empno = 7369', [sal]);
    }
  });

  test('Gemini (OpenAI-compatible endpoint): the agent\'s reasoning effort as reasoning_effort, the key only in the header', async () => {
    const g = await owner.one(`insert into meta.ai_service (name, provider, model, base_url, api_key_enc) values ('T_S111_GEMINI', 'gemini', 'gemini-3-pro', $1, $2) returning id`,
      [`${mock.base}/openai/v1`, encryptSecret('gemini-s111-key')]);
    await owner.query(`insert into meta.app_ai_service (app_id, service_id) values ($1, $2)`, [hrId, g.id]);
    const agents = JSON.parse(JSON.stringify(saved.ai_agents));
    agents[0].service = 'T_S111_GEMINI';
    agents[0].effort = 'high';
    await owner.query('update meta.app set ai_agents = $2 where id = $1', [hrId, JSON.stringify(agents)]);
    try {
      mock.script = [{ tools: [{ name: 'top_earners', input: { DNAME: 'RESEARCH' } }] }, { text: 'SCOTT and FORD.' }];
      const before = openAiCalls().length;
      const b = await user('jones');
      await ask(b, 'Who in Research earns most?');
      const calls = openAiCalls().slice(before);
      assert.equal(calls.length, 2);
      assert.equal(calls[0].body.model, 'gemini-3-pro');
      assert.equal(calls[0].body.reasoning_effort, 'high');
      assert.equal(calls[0].body.max_completion_tokens, 2000);
      assert.equal(calls[0].headers.authorization, 'Bearer gemini-s111-key');
      assert.match(calls[1].body.messages.at(-1).content, /"rows":\[/);
      { const pg = (await b.get('/a/hr/46')).body; assert.match(pg, /SCOTT and FORD/, pg.slice(pg.indexOf('<main'))); }
      // an OpenAI-compatible endpoint without a key (Ollama)
      await owner.query(`update meta.ai_service set provider = 'openai_compatible', api_key_enc = null where id = $1`, [g.id]);
      const before2 = openAiCalls().length;
      mock.script = [{ text: 'Hi.' }];
      await ask(b, 'Hello');
      assert.equal(openAiCalls()[before2].headers.authorization, 'Bearer none');
    } finally {
      await owner.query('update meta.app set ai_agents = $2 where id = $1', [hrId, JSON.stringify(saved.ai_agents)]);
      await owner.query(`delete from meta.ai_service where id = $1`, [g.id]);
      await owner.query(`delete from meta.ai_conversation where region_id = $1`, [region]);
    }
  });
});

describe('AI agents in the builder', () => {
  test('Shared Components → AI Agents: list, add, check, rename and delete tools and agents', async () => {
    const b = await builder();
    assert.match((await b.get(`/builder/apps/${hrId}/shared`)).body, /ai-agents/);
    const list = await b.get(`/builder/apps/${hrId}/ai-agents`);
    assert.equal(list.statusCode, 200);
    assert.match(list.body, /HR_AGENT/);
    assert.match(list.body, /open_employee/);
    assert.equal((await b.get(`/builder/apps/${hrId}/ai-agents/agent?name=HR_AGENT`)).statusCode, 200);
    assert.equal((await b.get(`/builder/apps/${hrId}/ai-agents/tool?name=top_earners`)).statusCode, 200);
    try {
      await b.get(`/builder/apps/${hrId}/ai-agents/tool`);
      const bad = await b.submit(`/builder/apps/${hrId}/ai-agents/tool`, { original: '', name: 't_s111', type: 'sql', description: 'x', sql: 'delete from hr.emp' });
      assert.equal(bad.statusCode, 422);
      assert.match(bad.body, /one query/);
      const nav = await b.submit(`/builder/apps/${hrId}/ai-agents/tool`, { original: '', name: 't_s111', type: 'navigate', description: 'x', pages: '3, 9999' });
      assert.match(nav.body, /There is no page 9999/);
      assert.equal((await b.submit(`/builder/apps/${hrId}/ai-agents/tool`, { original: '', name: 't_s111', type: 'sql', description: 'Departments', sql: 'select dname from hr.dept', max_rows: '5' })).statusCode, 303);
      await b.get(`/builder/apps/${hrId}/ai-agents/agent`);
      assert.equal((await b.submit(`/builder/apps/${hrId}/ai-agents/agent`, { original: '', name: 't_s111_agent', service: SERVICE, effort: 'medium', tools: ['t_s111'], max_steps: '3' })).statusCode, 303);
      let row = await owner.one('select ai_agents, ai_tools from meta.app where id = $1', [hrId]);
      assert.deepEqual(row.ai_agents.find((g: any) => g.name === 'T_S111_AGENT'), { name: 'T_S111_AGENT', service: SERVICE, effort: 'medium', tools: ['t_s111'], max_steps: 3 });
      // a renamed tool keeps its agents; a tool in use can't be deleted
      await b.get(`/builder/apps/${hrId}/ai-agents/tool?name=t_s111`);
      assert.equal((await b.submit(`/builder/apps/${hrId}/ai-agents/tool`, { original: 't_s111', name: 't_s111b', type: 'sql', description: 'Departments', sql: 'select dname from hr.dept' })).statusCode, 303);
      row = await owner.one('select ai_agents from meta.app where id = $1', [hrId]);
      assert.deepEqual(row.ai_agents.find((g: any) => g.name === 'T_S111_AGENT').tools, ['t_s111b']);
      await b.submit(`/builder/apps/${hrId}/ai-agents/tool/delete`, { name: 't_s111b' });
      assert.ok((await owner.one('select ai_tools from meta.app where id = $1', [hrId])).ai_tools.some((t: any) => t.name === 't_s111b'), 'still used');
      // a region names the agent; renaming the agent follows
      const pageId = (await owner.one('select page_id from meta.region where id = $1', [region])).page_id;
      await b.get(`/builder/pages/${pageId}?c=region-${region}`);
      assert.equal((await b.submit(`/builder/pages/${pageId}/region/${region}/assistant`, { agent: 'T_S111_AGENT', service: SERVICE, system: 'ignored', welcome: 'Hi' })).statusCode, 303);
      const cfg = (await owner.one('select config from meta.region where id = $1', [region])).config;
      assert.equal(cfg.agent, 'T_S111_AGENT');
      assert.equal(cfg.service, undefined);
      assert.equal(cfg.system, undefined);
      await b.get(`/builder/apps/${hrId}/ai-agents/agent?name=T_S111_AGENT`);
      await b.submit(`/builder/apps/${hrId}/ai-agents/agent`, { original: 'T_S111_AGENT', name: 'T_S111_AGENT2', service: SERVICE, tools: ['t_s111b'] });
      assert.equal((await owner.one('select config from meta.region where id = $1', [region])).config.agent, 'T_S111_AGENT2');
      await b.submit(`/builder/apps/${hrId}/ai-agents/agent/delete`, { name: 'T_S111_AGENT2' });
      await b.submit(`/builder/apps/${hrId}/ai-agents/tool/delete`, { name: 't_s111b' });
      row = await owner.one('select ai_agents, ai_tools from meta.app where id = $1', [hrId]);
      assert.ok(!row.ai_agents.some((g: any) => g.name.startsWith('T_S111')) && !row.ai_tools.some((t: any) => t.name.startsWith('t_s111')));
    } finally {
      await owner.query('update meta.app set ai_agents = $2, ai_tools = $3 where id = $1', [hrId, JSON.stringify(saved.ai_agents), JSON.stringify(saved.ai_tools)]);
      await owner.query(`update meta.region set config = $2 where id = $1`, [region, JSON.stringify({ agent: 'HR_AGENT', welcome: 'Hello! Ask me who earns what, e.g. who in Sales earns most. I can open an employee\'s record for you.', placeholder: 'e.g. Who in Sales earns most?', max_turns: 20, error_message: 'The HR agent could not answer just now. Please try again later.' })]);
    }
  });
});
