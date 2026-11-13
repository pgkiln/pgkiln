// Sprint 172 (parity leftovers): DA-5 the SQL Worksheet keeps the notices of earlier runs on request, CD-7 the
// Workflow Console draws every instance with the Workflow Diagram (reached, current and failed steps, history as
// tooltips), DA-18 the code editor highlights the body of a plv8 function as JavaScript.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let appId: number;

before(async () => {
  app = await buildApp({ logger: false });
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
});
after(async () => {
  await owner.query(`delete from meta.workflow where app_id = $1 and initiator = 'king' and started_at > now() - interval '10 minutes'`, [appId]).catch(() => undefined);
  await app.close();
  await closePools();
});

const builder = async () => {
  const b = new Browser(app);
  await b.get('/builder/login');
  assert.equal((await b.submit('/builder/login', { username: 'admin', password: 'admin' })).statusCode, 303);
  return b;
};
const notice = (text: string) => `do $$ begin raise notice '${text}'; end $$`;

describe('SQL Worksheet: keep notices (DA-5)', () => {
  test('without it a run shows only its own notices', async () => {
    const b = await builder();
    await b.get('/builder/sql/worksheet');
    await b.submit('/builder/sql/worksheet', { sql: notice('first 172'), mode: 'script' });
    const second = (await b.submit('/builder/sql/worksheet', { sql: notice('second 172'), mode: 'script' })).body;
    assert.match(second, /<span>second 172<\/span>/);
    assert.doesNotMatch(second, /first 172<\/span>/);
    assert.match(second, /<input type="checkbox" name="keep_notices">/);
    assert.doesNotMatch(second, /value="clear_notices"/);
  });

  test('ticked: earlier runs stay under the last run, for the session; Clear and unticking forget them', async () => {
    const b = await builder();
    await b.get('/builder/sql/worksheet');
    await b.submit('/builder/sql/worksheet', { sql: notice('kept one'), mode: 'script', keep_notices: 'on' });
    const second = (await b.submit('/builder/sql/worksheet', { sql: notice('kept two'), mode: 'script', keep_notices: 'on' })).body;
    assert.match(second, /<input type="checkbox" name="keep_notices" checked>/);
    const earlier = /<ul class="ws-notices" data-ws-kept>[\s\S]*?<\/ul>/.exec(second)?.[0] ?? '';
    assert.match(earlier, /<span>kept one<\/span>/);
    assert.doesNotMatch(earlier, /kept two/, 'the last run is above, not among the earlier ones');
    assert.match(second, /<span>kept two<\/span>/);
    // opened again: still there (and the box still ticked)
    const again = (await b.get('/builder/sql/worksheet?tab=notices')).body;
    assert.match(again, /name="keep_notices" checked/);
    assert.match(again, /data-ws-kept>[\s\S]*kept two[\s\S]*kept one/, 'newest first');
    // another developer session has none of it
    const other = (await (await builder()).get('/builder/sql/worksheet?tab=notices')).body;
    assert.doesNotMatch(other, /<span>kept one<\/span>/);
    // Clear: nothing runs, the Notices tab stays open
    const cleared = (await b.submit('/builder/sql/worksheet', { sql: notice('not run'), mode: 'clear_notices', keep_notices: 'on' })).body;
    assert.doesNotMatch(cleared, /<span>(kept one|not run)<\/span>/);
    assert.match(cleared, /data-active="notices"/);
    assert.match(cleared, /name="keep_notices" checked/);
    // unticked: the kept ones are forgotten
    await b.submit('/builder/sql/worksheet', { sql: notice('kept three'), mode: 'script', keep_notices: 'on' });
    const off = (await b.submit('/builder/sql/worksheet', { sql: 'select 1', mode: 'script' })).body;
    assert.doesNotMatch(off, /<span>kept three<\/span>/);
    assert.doesNotMatch((await b.submit('/builder/sql/worksheet', { sql: 'select 1', mode: 'script', keep_notices: 'on' })).body, /<span>kept three<\/span>/);
  });

  test('a notice is escaped and at most 200 are kept', async () => {
    const b = await builder();
    await b.get('/builder/sql/worksheet');
    await b.submit('/builder/sql/worksheet', { sql: notice('<b>bold</b>'), mode: 'script', keep_notices: 'on' });
    const many = `do $$ begin for i in 1..250 loop raise notice 'n%', i; end loop; end $$`;
    await b.submit('/builder/sql/worksheet', { sql: many, mode: 'script', keep_notices: 'on' });
    const body = (await b.submit('/builder/sql/worksheet', { sql: 'select 1', mode: 'script', keep_notices: 'on' })).body;
    const earlier = /<ul class="ws-notices" data-ws-kept>[\s\S]*?<\/ul>/.exec(body)?.[0] ?? '';
    assert.equal((earlier.match(/<li>/g) ?? []).length, 200);
    assert.doesNotMatch(earlier, /<b>bold<\/b>/);
    assert.match(earlier, /<span>n250<\/span>/);
    assert.doesNotMatch(earlier, /<span>n50<\/span>/, 'the oldest give way');
  });
});

/** The console's list item of an instance: the one whose diagram carries its id. */
const itemOf = (body: string, id: string) => body.split('<li class="task').find((x) => new RegExp(`wf-arrow-\\d+-${id}"`).test(x)) ?? '';

describe('Workflow Console draws its instances with the Workflow Diagram (CD-7)', () => {
  test('a started instance: the steps it went through and where it is, with history as tooltips', async () => {
    const king = new Browser(app);
    assert.equal((await king.login('king')).statusCode, 303);
    await king.get('/a/hr/28');
    await king.submit('/a/hr/28', { P28_EMPNO: '7839', __request: 'ONBOARD' });
    const id = (await owner.one(`select max(id)::text as id from meta.workflow where app_id = $1 and initiator = 'king'`, [appId]))?.id;
    assert.ok(id, 'an instance was started');
    const body = (await king.get('/a/hr/14')).body;
    const diagram = itemOf(body, id);
    assert.match(diagram, /wf-console-diagram/);
    assert.match(diagram, /<svg class="wf-diagram"/);
    assert.match(diagram, /class="wf-node [^"]*wf-(active|done|failed)/, 'a step is marked');
    assert.match(diagram, /<title>[^<]+: (step|started|task|split)/, 'a reached step has its history as a tooltip');
  });

  test('a finished instance keeps its diagram, with the steps it went through', async () => {
    const id = (await owner.one(`select max(id)::text as id from meta.workflow where app_id = $1 and initiator = 'king'`, [appId]))?.id;
    assert.ok(id);
    await owner.query(`update meta.workflow set state = 'terminated', ended_at = now() where id = $1`, [id]);
    const king = new Browser(app);
    await king.login('king');
    const body = (await king.get('/a/hr/14')).body;
    const li = itemOf(body, id);
    assert.match(li, /wf-console-diagram/);
    assert.doesNotMatch(li, /wf-active/, 'nothing is current any more');
  });
});

describe('App Gallery: a version badge per app (WS-8)', () => {
  /** The catalogue's version per card (Sample Maps is 1.1 since sprint 178). */
  const CATALOGUE = JSON.parse(readFileSync(new URL('../examples/gallery/gallery.json', import.meta.url), 'utf8'));
  test('every sample, starter and utility card shows its version; an installed sample of another version says which', async () => {
    const b = await builder();
    for (const tab of ['samples', 'starters', 'utilities']) {
      const body = (await b.get(`/builder/gallery?tab=${tab}`)).body;
      const cards = body.split('<article class="gal-card"').slice(1);
      assert.ok(cards.length > 0, tab);
      for (const c of cards) {
        const title = /<h2>([^<]*)/.exec(c)?.[1];
        const v = (CATALOGUE[tab] as { title: string; version: string }[]).find((x) => x.title === title)?.version;
        assert.ok(v, `${tab}: ${title} is in gallery.json`);
        assert.ok(c.includes(`<span class="tag gal-version" title="Version ${v}">v${v}</span>`), `${tab}: ${title}`);
      }
    }
    const hr = (body: string) => body.split('<article class="gal-card"').find((c) => c.includes('<h2>HR Demo</h2>')) ?? '';
    assert.match(hr((await b.get('/builder/gallery')).body), /<span class="tag tag-ok">Installed<\/span>/);
    await owner.query(`update meta.app set version = '0.9 <b>' where alias = 'hr'`);
    try {
      const card = hr((await b.get('/builder/gallery')).body);
      assert.match(card, /<span class="tag tag-ok">Installed: v0\.9 &lt;b&gt;<\/span>/);
    } finally {
      await owner.query(`update meta.app set version = null where alias = 'hr'`);
    }
  });
});

describe('code editor: plv8 bodies as JavaScript (DA-18)', () => {
  const lex = (() => {
    const window: any = {};
    const document = { readyState: 'loading', addEventListener() {}, querySelectorAll: () => [] };
    vm.runInNewContext(readFileSync(new URL('../public/code-editor.js', import.meta.url), 'utf8'), { window, document, location: { pathname: '/' }, URLSearchParams, Map, Set });
    return (lang: string, src: string) => {
      const r = window.pgkilnCodeEditor.lex(lang, src);
      return r.T.map((t: string, i: number) => `${t}:${src.slice(r.S[i], r.E[i])}`) as string[];
    };
  })();

  test('LANGUAGE plv8 before or after the body: JavaScript comments, strings, keywords and calls', () => {
    const before = lex('sql', "create function f(a int) returns int language plv8 as $$ // select from\n const x = plv8.execute('select 1'); return x.length; $$;");
    assert.ok(before.includes('com:// select from'));
    assert.ok(before.includes('kw:const') && before.includes('kw:return'));
    assert.ok(before.includes('fn:execute') && before.includes("str:'select 1'"));
    assert.equal(before.filter((t) => t === 'dol:$$').length, 2);
    const afterBody = lex('plpgsql', 'create function g() returns text as $js$ let s = `a${1}`; /* end */ return s; $js$ language plv8;');
    assert.ok(afterBody.includes('kw:let') && afterBody.includes('str:`a${1}`') && afterBody.includes('com:/* end */'));
    const block = lex('sql', "do $$ plv8.elog(NOTICE, \"it's\"); $$ language 'plv8';");
    assert.ok(block.includes('str:"it\'s"') && block.includes('fn:elog'));
  });

  test('other bodies stay SQL / PL/pgSQL, also next to a plv8 function', () => {
    const t = lex('plpgsql', "create function a() returns int language plv8 as $$ return 1; $$;\ncreate function b() returns int as $$ begin -- note\n return 1; end $$ language plpgsql;\nselect 'language plv8', $$ const $$;");
    assert.ok(t.includes('com:-- note'), 'a PL/pgSQL comment');
    assert.ok(t.includes('kw:begin') && t.includes('kw:end'));
    assert.ok(!t.includes('kw:const'), 'a dollar-quoted text after a string that names plv8 is not JavaScript');
  });

  test('an unclosed body does not hang or run past the text', () => {
    const t = lex('sql', "create function f() returns int language plv8 as $$ return 'x");
    assert.ok(t.length > 0);
  });
});
