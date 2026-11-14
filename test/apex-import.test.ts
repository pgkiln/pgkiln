// (sprint 182, CD-1/CD-4 leftover) The APEX importer: an APEX application export in the SQL format
// (test/fixtures/apex/f100.sql, hand-written in APEX 23.2's format, and f200/, a split export in the
// older wwv_flow_api style) read as text (src/apexparse.ts), translated to a pgkiln/2 document with
// a report (src/apeximport.ts), imported with meta.import_app() by `pgkiln import-apex` and by the
// builder's Import → From Oracle APEX (src/builder/apex-import.ts).
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import type { FastifyInstance } from 'fastify';
import { root } from '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { ApexId, ApexParseError, joinSplitExport, parseApexCalls, unistr } from '../src/apexparse.ts';
import { apexSource, apexSourceFromDir, apexToDoc, conditionOk, MAPPED_PROCESS_TYPES, MAPPED_VALIDATION_TYPES, NotAnApexExport, oracleisms, parseFp, reportText, type ReportEntry } from '../src/apeximport.ts';
import { Browser } from './helpers.ts';

const FIX = join(root, 'test/fixtures/apex');
const F100 = readFileSync(join(FIX, 'f100.sql'), 'utf8');
const ALIASES = ['apex182-cli', 'apex182-split', 'apex182-builder', 'apex182-db', 'apex187-cli', 'apex187-none', 'apex187-builder'];
/** (sprint 187) issues of these applications go with them (an issue keeps its row when its application is deleted) */
const dropIssues = () => owner.query(`delete from meta.team_issue where app_id in (select id from meta.app where alias = any($1))`, [ALIASES]);
const tmp = mkdtempSync(join(tmpdir(), 'pgkiln-apex-'));
let app: FastifyInstance;

before(async () => {
  await dropIssues();
  await owner.query('delete from meta.app where alias = any($1)', [ALIASES]);
  app = await buildApp({ logger: false });
});
after(async () => {
  await dropIssues();
  await owner.query('delete from meta.app where alias = any($1)', [ALIASES]);
  rmSync(tmp, { recursive: true, force: true });
  await app.close();
  await closePools();
});

const cli = (...args: string[]) => {
  const r = spawnSync(process.execPath, [join(root, 'bin/pgkiln.js'), ...args], { cwd: tmp, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

describe('reading the export as text', () => {
  test('named arguments, quotes, q-quotes, unistr, joined lines, nvl and ids', () => {
    const calls = parseApexCalls(`
prompt APPLICATION 1 - Bob's app (an apostrophe in a prompt line)
set define off
begin
-- a comment with 'quotes'
/* and a block
   comment */
wwv_flow_imp_page.create_page_item(
 p_id=>wwv_flow_imp.id(13700000000000207)
,p_name=>'P1_X'
,p_prompt=>'It''s'
,p_a=>q'[a 'b' ]c]'
,p_b=>Q'{x}'
,p_c=>q'!y!'
,p_d=>'caf'||unistr('\\00e9')||chr(33)
,p_e=>wwv_flow_string.join(wwv_flow_t_varchar2(
'line 1',
'line 2'))
,p_f=>nvl(wwv_flow_application_install.get_schema,'SALES')
,p_g=>'!'||wwv_flow_imp.id(42)
,p_h=>true
,p_i=>-5
,p_j=>wwv_flow_api.id(7)+wwv_flow_api.g_id_offset
,p_k=>null
);
end;
/`);
    assert.equal(calls.length, 1);
    const c = calls[0];
    assert.equal(c.pkg, 'wwv_flow_imp_page');
    assert.equal(c.method, 'create_page_item');
    assert.ok(c.args.p_id instanceof ApexId);
    assert.equal(String(c.args.p_id), '13700000000000207', 'ids keep every digit');
    assert.equal(c.args.p_prompt, "It's");
    assert.equal(c.args.p_a, "a 'b' ]c");
    assert.equal(c.args.p_b, 'x');
    assert.equal(c.args.p_c, 'y');
    assert.equal(c.args.p_d, 'café!');
    assert.equal(c.args.p_e, 'line 1\nline 2');
    assert.equal(c.args.p_f, 'SALES');
    assert.equal(c.args.p_g, '!42');
    assert.equal(c.args.p_h, true);
    assert.equal(c.args.p_i, -5);
    assert.equal(String(c.args.p_j), '7');
    assert.equal(c.args.p_k, null);
    assert.equal(unistr('a\\\\b\\0041'), 'a\\bA');
  });

  test('a broken file fails with its line; nothing else is read', () => {
    assert.throws(() => parseApexCalls("begin\nwwv_flow_imp_page.create_page(\n p_id=>1\n,p_name=>'Home\n);\nend;"), (e: unknown) => e instanceof ApexParseError && e.line === 4);
    assert.throws(() => parseApexCalls("begin wwv_flow_imp_page.create_page(p_name=>q'[never closed); end;"), ApexParseError);
    assert.throws(() => parseApexCalls(`begin wwv_flow_imp_page.create_page(p_name=>${'('.repeat(100000)}1${')'.repeat(100000)}); end;`), /nested too deeply/);
    // not a call to an APEX package: ignored
    assert.deepEqual(parseApexCalls("begin dbms_output.put_line('x'); execute immediate 'drop table t'; end;"), []);
  });

  test('a split export in install.sql\'s order, a zip of it, and a file that is not an export', async () => {
    const files = new Map([
      ['f1/application/pages/page_00001.sql', "begin wwv_flow_imp_page.create_page(p_id=>1, p_name=>'P'); end;"],
      ['f1/install.sql', '@@application/create_application.sql\n@@application/pages/page_00001.sql\n'],
      ['f1/application/create_application.sql', "begin wwv_flow_imp.create_flow(p_name=>'A'); end;"],
    ]);
    const joined = joinSplitExport(files);
    assert.ok(joined.indexOf('create_flow') < joined.indexOf('create_page'));
    const zip = Buffer.from(zipSync(Object.fromEntries([...files].map(([p, s]) => [p, Buffer.from(s)]))));
    assert.equal(apexToDoc(await apexSource(zip)).doc.app.name, 'A');
    const dir = await apexSourceFromDir(join(FIX, 'f200'));
    assert.match(dir, /import_begin[\s\S]*create_flow[\s\S]*create_page/);
    assert.throws(() => apexToDoc('select 1 from dual;'), NotAnApexExport);
    await assert.rejects(() => apexSource(Buffer.from('PK\u0003\u0004 not really a zip')), NotAnApexExport);
  });

  test('helpers: f?p links, conditions as the database checks them, Oracle-only SQL', () => {
    assert.deepEqual(parseFp('f?p=&APP_ID.:3:&APP_SESSION.::&DEBUG.:RP,3:P3_ID,P3_X:\\#ID#\\,&P2_X.'), { page: '3', request: '', clear: 'RP,3', items: { P3_ID: '#ID#', P3_X: '&P2_X.' } });
    assert.equal(parseFp('f?p=&APP_ID.:2:&SESSION.&success_msg=#SUCCESS_MSG#')!.page, '2');
    assert.equal(parseFp('https://example.com'), null);
    assert.equal(parseFp('f?p=OTHERAPP:1'), null, 'another application');
    assert.ok(conditionOk('request_in', null, 'SAVE,CREATE'));
    assert.ok(!conditionOk('request_in', null, 'save it'));
    assert.ok(!conditionOk('item_null', 'p3 x', null));
    assert.deepEqual(oracleisms("select nvl(a, 0) from dual where rownum < 2 and sysdate > x(+)"), ['nvl', 'sysdate', 'dual', 'rownum', '(+) outer join']);
    assert.deepEqual(oracleisms('select coalesce(a, 0) from sales.orders'), []);
  });
});

describe('the mapping of f100.sql', () => {
  const { doc, report } = apexToDoc(F100);
  const entry = (kind: string, name: string) => report.entries.find((e) => e.kind === kind && e.name === name) as ReportEntry;
  const page = (n: number) => doc.pages.find((p: any) => p.page_no === n);
  const p3 = page(3);

  test('the application, its pages, the login and global pages', () => {
    assert.equal(doc.format, 'pgkiln/2');
    assert.equal(doc.app.name, "Order's Desk");
    assert.equal(doc.app.alias, 'orders-desk');
    assert.equal(doc.app.home_page, 1);
    assert.equal(doc.app.date_format, 'DD-MON-YYYY');
    assert.equal(doc.app.version, 'Release 1.0');
    assert.deepEqual(doc.pages.map((p: any) => p.page_no), [1, 2, 3]);
    assert.equal(p3.mode, 'modal');
    assert.equal(p3.authz, 'CONTRIBUTORS');
    assert.equal(page(2).help, 'All orders, newest first.');
    assert.equal(entry('page', 'Global Page').status, 'not_mapped');
    assert.equal(entry('page', 'Login Page').status, 'not_mapped');
    assert.equal(report.application.schema, 'sales');
  });

  test('every validation type of chapter 11, and what is not mapped says its APEX type', () => {
    const expected: Record<string, string> = {
      'Customer not null': 'not_null', 'Total is numeric': 'numeric', 'Total not null or zero': 'not_null_or_zero', 'Total not zero': 'not_zero',
      'Code has no spaces': 'no_spaces', 'Code alphanumeric': 'alphanumeric', 'Ordered on is a date': 'valid_date', 'Ordered on is a timestamp': 'valid_timestamp',
      'Status = OPEN': 'equals', 'Status != X': 'not_equals', 'Status in list': 'in_list', 'Status not in list': 'not_in_list',
      'Code only letters': 'chars_only', 'E-mail has an @': 'chars_any', 'Note without brackets': 'chars_none', 'E-mail looks like an address': 'regex',
      'Customer exists': 'exists', 'Code not taken': 'not_exists', 'Total positive': 'sql', 'Total below limit': 'sql',
      'Shipped orders keep their total': 'function_body', 'Credit check': 'function_error',
    };
    for (const [name, type] of Object.entries(expected)) {
      const v = p3.validations.find((x: any) => x.name === name);
      assert.ok(v, name);
      assert.equal(v.type, type, name);
      assert.notEqual(entry('validation', name).status, 'not_mapped', name);
    }
    // the fixture uses every validation type the importer maps (but the aliases)
    const used = new Set(report.entries.filter((e) => e.kind === 'validation').map((e) => e.apexType));
    assert.deepEqual(MAPPED_VALIDATION_TYPES.filter((t) => !used.has(t) && !['ITEM_IS_NOT_NULL', 'SQL_EXPRESSION', 'PLSQL_EXPRESSION'].includes(t)), []);
    const v = (name: string) => p3.validations.find((x: any) => x.name === name);
    assert.equal(v('Customer not null').item_name, 'P3_CUSTOMER_ID');
    assert.equal(v('Customer not null').message, 'Customer must have some value.', '#LABEL# is the item\'s label');
    assert.equal(v('Customer not null').display_location, 'inline_and_notification');
    assert.equal(v('Total is numeric').display_location, 'inline');
    assert.equal(v('Ordered on is a date').display_location, 'notification');
    assert.equal(v('Status in list').expression, 'OPEN:SHIPPED:CANCELLED');
    assert.equal(v('E-mail looks like an address').expression, '^[^@]+@[^@]+\\.[A-Za-z]{2,}$', 'a q-quote keeps its backslashes');
    assert.equal(v('Status = OPEN').condition_type, 'request_in');
    assert.equal(v('Status = OPEN').condition_value, 'CREATE');
    assert.equal(v('Code not taken').expression, 'select 1\n  from orders\n where code = :P3_CODE\n   and id <> coalesce(:P3_ID, -1)'); // (sprint 187) nvl rewritten
    assert.equal(v('Total positive').item_name, 'P3_TOTAL', 'an associated item shows the message next to it');
    assert.equal(v('Credit check').when_button, 'CREATE');
    assert.equal(v('Shipped orders keep their total').always_execute, true);
    assert.match(v('Shipped orders keep their total').expression, /^begin\n {2}if :P3_STATUS = 'SHIPPED'/);
    for (const name of ['Total below limit', 'Shipped orders keep their total', 'Credit check']) {
      assert.ok(entry('validation', name).port, `${name} needs porting`);
      assert.match(entry('validation', name).notes.join(), /port it to PL\/pgSQL/);
    }
    // (sprint 187) its nvl is rewritten, so nothing is left to port; the report says what was rewritten
    assert.equal(entry('validation', 'Code not taken').port, false, 'nvl rewritten');
    assert.match(entry('validation', 'Code not taken').notes.join(), /Oracle SQL rewritten: nvl → coalesce/);
    assert.ok(!entry('validation', 'Customer exists').port);
    for (const [name, type] of [['Legacy PL/SQL error', 'PLSQL_ERROR'], ['Stars plug-in', 'PLUGIN_COM_EXAMPLE_STARS_VALID']]) {
      assert.equal(entry('validation', name).status, 'not_mapped');
      assert.equal(entry('validation', name).apexType, type);
      assert.ok(!p3.validations.some((x: any) => x.name === name));
    }
  });

  test('process types: mapped, with notes, not mapped', () => {
    const pr = (name: string) => p3.processes.find((x: any) => x.name === name);
    const form = p3.regions.find((r: any) => r.type === 'form');
    assert.equal(pr('Initialize form Order').type, 'form_init');
    assert.equal(pr('Initialize form Order').point, 'load');
    assert.equal(pr('Process form Order').type, 'form_dml');
    assert.equal(pr('Process form Order').region_id, form.id);
    assert.equal(pr('Process form Order').success_message, 'Order &P3_ID. saved.');
    assert.equal(pr('Log the change').type, 'sql');
    assert.match(pr('Log the change').code, /^begin\n {2}insert into order_log/);
    assert.equal(pr('Log the change').condition_type, 'request_not_in');
    assert.equal(pr('Log the change').condition_value, 'DELETE');
    assert.ok(entry('process', 'Log the change').port);
    assert.deepEqual(pr('Mail the customer').config, { from: 'orders@example.com', to: '&P3_EMAIL.', subject: 'Order &P3_ID.', body: 'Dear customer,\n\nyour order &P3_ID. is &P3_STATUS..' });
    assert.equal(pr('Mail the customer').when_button, 'SAVE');
    assert.deepEqual(pr('Clear the note').config, { items: ['P3_NOTE', 'P3_CODE'] });
    assert.deepEqual(pr('Clear the page').config, { pages: [3] });
    assert.equal(pr('Recalculate').type, 'sql');
    assert.equal(pr('Recalculate').code, "call sales_pkg.recalculate(p_order_id => :P3_ID, p_mode => 'FULL')");
    assert.ok(entry('process', 'Recalculate').port);
    assert.deepEqual(pr('Close Dialog').config, { items: ['P3_ID'] });
    assert.equal(pr('Close Dialog').condition_value, 'CREATE,SAVE,DELETE');
    for (const [name, type] of [['Legacy web service', 'NATIVE_WEB_SERVICE'], ['Audit plug-in', 'PLUGIN_COM_EXAMPLE_AUDIT'], ['Remember the status', 'NATIVE_USER_PREFERENCES']]) {
      assert.equal(entry('process', name).status, 'not_mapped', name);
      assert.equal(entry('process', name).apexType, type);
      assert.ok(!pr(name));
    }
    const split = apexToDoc(joinSplitExport(new Map([['a.sql', readFileSync(join(FIX, 'f200/application/set_environment.sql'), 'utf8')], ['b.sql', readFileSync(join(FIX, 'f200/application/create_application.sql'), 'utf8')], ['c.sql', readFileSync(join(FIX, 'f200/application/pages/page_00010.sql'), 'utf8')]])));
    const types = new Set([...report.entries, ...split.report.entries].filter((e) => e.kind === 'process' && e.status !== 'not_mapped').map((e) => e.apexType));
    assert.deepEqual(MAPPED_PROCESS_TYPES.filter((t) => !types.has(t)), [], 'the fixtures use every process type the importer maps');
    const chained = split.doc.pages[0].processes.find((x: any) => x.name === 'Fetch the rates');
    assert.equal(chained.type, 'invoke_api');
    assert.equal(chained.parent_process, 'Nightly chain');
    assert.deepEqual(chained.config.params, { currency: 'EUR' });
  });

  test('regions, items, buttons, lists of values, authorization schemes, navigation, dynamic actions', () => {
    const r = (n: number, title: string) => page(n).regions.find((x: any) => x.title === title);
    assert.equal(r(1, 'Welcome').source, '<p>Welcome to the <strong>order desk</strong>, &APP_USER.</p>\n<p>Café &amp; more.</p>');
    assert.equal(r(1, 'Sales by Month').type, 'static');
    assert.match(r(1, 'Sales by Month').source, /was not imported/);
    assert.match(r(1, 'News').source, /<pre>htp\.p\(&#39;&lt;b&gt;|<pre>htp\.p\('&lt;b&gt;/, 'the PL/SQL is kept, escaped');
    assert.equal(r(2, 'Orders').type, 'report');
    assert.equal(r(2, 'Top customers').type, 'classic_report');
    assert.equal(r(2, 'Top customers').source, 'select * from sales.customers\n where rownum <= 5');
    assert.equal(r(2, 'Top customers').condition_type, 'user_signed_in');
    const form = r(3, 'Order');
    assert.deepEqual([form.type, form.table_name, form.pk_column, form.pk_item], ['form', 'sales.orders', 'id', 'P3_ID']);
    const it = (name: string) => p3.items.find((x: any) => x.name === name);
    assert.deepEqual([it('P3_ID').type, it('P3_ID').source_column, it('P3_ID').region_id], ['hidden', 'id', form.id]);
    assert.deepEqual([it('P3_CUSTOMER_ID').type, it('P3_CUSTOMER_ID').lov, it('P3_CUSTOMER_ID').required], ['popup_lov', 'LOV:CUSTOMERS_NAME', true]);
    assert.equal(it('P3_STATUS').lov, 'STATIC:Open;OPEN,Shipped;SHIPPED,Cancelled;CANCELLED');
    assert.equal(it('P3_STATUS').default_value, 'OPEN');
    assert.equal(it('P3_EMAIL').type, 'email');
    assert.equal(it('P3_ORDERED_ON').type, 'date');
    assert.equal(it('P3_NOTE').condition_type, 'item_not_null');
    assert.equal(it('P3_NOTE').condition_expr, 'P3_ID');
    assert.equal(it('P3_CODE').condition_type, 'function_body');
    assert.equal(it('P3_RATING').type, 'text');
    assert.equal(it('P3_RATING').label, 'Rating', 'markup taken out of labels');
    assert.equal(page(2).items[0].lov, 'LOV:STATUS');
    // a PL/SQL default became a computation when the item is empty
    const c = p3.computations.find((x: any) => x.item_name === 'P3_ORDERED_ON');
    assert.deepEqual([c.type, c.expression, c.condition_type, c.condition_expr], ['sql_expression', 'sysdate', 'item_null', 'P3_ORDERED_ON']);
    assert.equal(entry('computation', 'P3_TOTAL').status, 'not_mapped');
    const b = (n: number, name: string) => page(n).buttons.find((x: any) => x.name === name);
    assert.deepEqual([b(2, 'CREATE').action, b(2, 'CREATE').target_page, b(2, 'CREATE').authz, b(2, 'CREATE').hot], ['redirect', 3, 'CONTRIBUTORS', true]);
    assert.deepEqual([b(3, 'SAVE').condition_type, b(3, 'SAVE').condition, b(3, 'SAVE').label], ['item_not_null', 'P3_ID', 'Apply Changes']);
    assert.equal(b(3, 'CANCEL').action, 'da');
    assert.equal(b(3, 'CANCEL').slot, 'close');
    assert.equal(entry('button', 'DELETE').status, 'not_mapped', 'a javascript: link');
    assert.deepEqual(p3.branches.map((x: any) => [x.name, x.target_page, x.condition_type, x.condition_value]), [['Go to orders', 2, 'request_in', 'SAVE,CREATE']]);
    assert.equal(entry('branch', 'Elsewhere').status, 'not_mapped');
    assert.deepEqual(doc.lovs.map((l: any) => [l.name, l.query]), [
      ['STATUS', 'STATIC:Open;OPEN,Shipped;SHIPPED'],
      ['CUSTOMERS_NAME', 'select name as d, id as r from sales.customers order by name'],
      ['PRODUCTS', "select name || ' (' || coalesce(code, '-') || ')' d, id r from products order by 1"],
    ]);
    assert.deepEqual(doc.authz_schemes.map((a: any) => [a.name, a.type]), [['ADMINISTRATION_RIGHTS', 'sql'], ['CONTRIBUTORS', 'role']]);
    assert.match(doc.authz_schemes[0].value, /^exists \(select 1\n {2}from sales\.staff/);
    assert.equal(entry('authorization', 'Is Manager').status, 'not_mapped', 'a function body fails closed until it is ported');
    assert.deepEqual(doc.nav.map((n: any) => [n.label, n.target_page, n.parent_id]), [['Home', 1, null], ['Orders', 2, null], ['Oracle', null, 2]]);
    const da = (name: string) => page(3).dynamic_actions.filter((x: any) => x.name.startsWith(name));
    assert.deepEqual(da('Show the note').map((x: any) => [x.event, x.trigger_element, x.action, x.condition_type, x.condition_value, x.affected_items]), [
      ['change', 'P3_STATUS', 'show', 'equals', 'SHIPPED', 'P3_NOTE'],
      ['change', 'P3_STATUS', 'hide', 'not_equals', 'SHIPPED', 'P3_NOTE'],
    ]);
    assert.deepEqual(da('Fill the total').map((x: any) => [x.action, x.code, x.items_to_submit]), [['set_value', 'select credit_limit from customers where id = :P3_CUSTOMER_ID', 'P3_CUSTOMER_ID']]);
    assert.deepEqual(da('Cancel Dialog').map((x: any) => [x.event, x.trigger_element, x.action]), [['click', 'CANCEL', 'cancel_dialog']]);
    const refresh = page(2).dynamic_actions.find((x: any) => x.name === 'Refresh after dialog');
    assert.deepEqual([refresh.event, refresh.action, refresh.affected_region_id], ['dialog_closed', 'refresh_region', r(2, 'Orders').id]);
    assert.equal(entry('dynamic_action', 'Highlight rows').status, 'not_mapped');
    assert.deepEqual(report.skipped, { create_jet_chart: 1, create_worksheet_column: 1 });
  });

  test('the report as text: not mapped first, with the APEX types and what to port', () => {
    const text = reportText(report);
    assert.match(text, /^APEX application 100 "Order's Desk" \(APEX 23\.2\.0\) → orders-desk\n/);
    assert.ok(text.indexOf('NOT MAPPED') < text.indexOf('MAPPED WITH NOTES'));
    assert.match(text, /validation "Legacy PL\/SQL error" \(PLSQL_ERROR\)/);
    assert.match(text, /process "Log the change" \(NATIVE_PLSQL\) → sql {2}\[needs porting\]/);
    assert.doesNotMatch(text, /\nMAPPED\n/, 'without --all no list of what simply mapped');
    assert.match(reportText(report, { all: true }), /\nMAPPED\n/);
    assert.equal(report.counts.mapped + report.counts.notes + report.counts.not_mapped, report.entries.length);
  });

  test('options: alias, schema, database role; an unknown alias of an APEX app is made from its name', () => {
    const o = apexToDoc(F100, { alias: 'my-copy', schema: 'shop', dbRole: 'app_shop' });
    assert.equal(o.doc.app.alias, 'my-copy');
    assert.equal(o.doc.app.db_role, 'app_shop');
    assert.equal(o.doc.pages.find((p: any) => p.page_no === 3).regions.find((r: any) => r.type === 'form').table_name, 'shop.orders');
    assert.equal(apexToDoc(F100, { schema: '' }).doc.lovs[1].query, 'select name as d, id as r from customers order by name');
  });
});

describe('importing', () => {
  test('the document imports with meta.import_app() and exports again', async () => {
    const { doc } = apexToDoc(F100, { alias: 'apex182-db', dbRole: 'hr_app' }); // (sprint 186) meta.app needs a role
    const id = (await owner.one<{ id: number }>('select meta.import_app($1::jsonb, $2) as id', [JSON.stringify(doc), 'apex182-db']))!.id;
    const back = (await owner.one<{ d: any }>('select meta.export_app($1) as d', ['apex182-db']))!.d;
    assert.equal(back.app.name, "Order's Desk");
    const p3 = back.pages.find((p: any) => p.page_no === 3);
    assert.equal(p3.validations.length, doc.pages[2].validations.length);
    assert.equal(p3.processes.length, doc.pages[2].processes.length);
    assert.equal(p3.dynamic_actions.length, doc.pages[2].dynamic_actions.length);
    // ids were remapped: items sit in the imported form region
    const form = (await owner.one<{ id: number }>(`select r.id from meta.region r join meta.page p on p.id = r.page_id where p.app_id = $1 and p.page_no = 3 and r.type = 'form'`, [id]))!.id;
    assert.equal((await owner.one<{ n: number }>(`select count(*)::int as n from meta.item i join meta.page p on p.id = i.page_id where p.app_id = $1 and i.region_id = $2`, [id, form]))!.n, 9);
    assert.equal((await owner.one<{ n: number }>(`select count(*)::int as n from meta.nav_entry where app_id = $1 and parent_id is not null`, [id]))!.n, 1);
  });

  test('pgkiln import-apex: --dry-run, the import, --out, a taken alias, not an export', () => {
    const dry = cli('import-apex', join(FIX, 'f100.sql'), '--dry-run');
    assert.equal(dry.code, 0, dry.err);
    assert.match(dry.out, /NOT MAPPED[\s\S]*Dry run: nothing was imported/);
    const json = cli('import-apex', join(FIX, 'f100.sql'), '--dry-run', '--json');
    assert.equal(JSON.parse(json.out).application.alias, 'orders-desk');
    const ok = cli('import-apex', join(FIX, 'f100.sql'), '--alias', 'apex182-cli');
    assert.equal(ok.code, 0, ok.err);
    assert.match(ok.out, /Imported apex182-cli \(application \d+\)/);
    const again = cli('import-apex', join(FIX, 'f100.sql'), '--alias', 'apex182-cli');
    assert.equal(again.code, 2);
    assert.match(again.err, /exists: choose another --alias/);
    const split = cli('import-apex', join(FIX, 'f200'), '--alias', 'apex182-split');
    assert.equal(split.code, 0, split.err);
    const out = cli('import-apex', join(FIX, 'f100.sql'), '--out', join(tmp, 'files'));
    assert.equal(out.code, 0, out.err);
    assert.ok(readFileSync(join(tmp, 'files/pgkiln.json'), 'utf8').includes('"style": "text"'));
    const bad = cli('import-apex', join(root, 'package.json'), '--dry-run');
    assert.equal(bad.code, 3);
    assert.match(bad.err, /no APEX application in the file/);
    assert.equal(cli('import-apex', join(FIX, 'f100.sql'), '--alias', 'Not An Alias').code, 2);
  });

  test('the builder: upload, report, import into the workspace', async () => {
    const b = new Browser(app);
    await b.get('/builder/login');
    assert.equal((await b.submit('/builder/login', { username: 'admin', password: 'admin' })).statusCode, 303);
    const imp = await b.get('/builder/import');
    assert.match(imp.body, /href="\/builder\/import\/apex"/);
    await b.get('/builder/import/apex');
    const up = await b.upload('/builder/import/apex', {}, { file: { name: 'f100.sql', type: 'application/sql', data: Buffer.from(F100) } });
    assert.equal(up.statusCode, 303, up.body.slice(0, 300));
    const url = up.headers.location as string;
    const rep = await b.get(url);
    assert.equal(rep.statusCode, 200);
    assert.match(rep.body, /PLSQL_ERROR/);
    assert.match(rep.body, /Needs porting/);
    assert.match(rep.body, /name="alias"[^>]*value="orders-desk"/);
    // another schema: the report again, the file kept
    const pre = await b.submit(url, { action: 'preview', alias: 'apex182-builder', schema: 'shop' });
    assert.equal(pre.statusCode, 200);
    assert.match(pre.body, /name="schema"[^>]*value="shop"/);
    const bad = await b.submit(url, { action: 'import', alias: 'Bad Alias', schema: 'sales' });
    assert.equal(bad.statusCode, 422);
    const done = await b.submit(url, { action: 'import', alias: 'apex182-builder', schema: 'sales' });
    assert.equal(done.statusCode, 303, done.body.slice(0, 300));
    const a = await owner.one<{ id: number; ws: number | null }>(`select a.id, w.workspace_id as ws from meta.app a left join meta.workspace_app w on w.app_id = a.id where a.alias = 'apex182-builder'`);
    assert.ok(a);
    assert.ok(a.ws, 'placed in the developer\'s workspace');
    // (sprint 186) no --db-role: app_<alias>, here without rights (there is no schema sales)
    assert.equal((await owner.one<{ r: string }>('select db_role as r from meta.app where id = $1', [a.id]))!.r, 'app_apex182_builder');
    assert.equal(done.headers.location, `/builder/apps/${a.id}`);
    // the temporary file is gone: the report page sends the developer back to the upload
    assert.equal((await b.get(url)).statusCode, 303);
  });
});

describe('sprint 187: common Oracle SQL rewritten (NX-F1)', async () => {
  const { codeMask, translateOracle } = await import('../src/oracle-sql.ts');
  const t = (sql: string) => translateOracle(sql).sql;

  test('nvl, nvl2 and decode, nested, with a null that equals null as in Oracle', () => {
    assert.equal(t('select nvl(a, 0) from t'), 'select coalesce(a, 0) from t');
    assert.equal(t("select nvl2(b, 'y', 'n') from t"), "select (case when b is not null then 'y' else 'n' end) from t");
    assert.equal(t("select decode(s, 'A', 'Active', 'I', 'Inactive', 'Other') from t"),
      "select (case when s is not distinct from 'A' then 'Active' when s is not distinct from 'I' then 'Inactive' else 'Other' end) from t");
    assert.equal(t("select decode(s, 'A', 1) from t"), "select (case when s is not distinct from 'A' then 1 end) from t");
    assert.equal(t("select nvl(nvl(a, b), decode(c, null, 'none', c)) from t"),
      "select coalesce(coalesce(a, b), (case when c is not distinct from null then 'none' else c end)) from t");
    // a comma inside a call or a literal is not an argument separator
    assert.equal(t("select nvl(f(a, b), 'x, y') from t"), "select coalesce(f(a, b), 'x, y') from t");
    // the wrong number of arguments: left as it is
    assert.equal(t('select nvl(a) from t'), 'select nvl(a) from t');
  });

  test('sysdate, systimestamp, dual, sequences, v() and minus', () => {
    assert.equal(t('select sysdate, systimestamp from dual'), 'select localtimestamp(0), current_timestamp');
    assert.equal(t('select 1 from sys.dual where x = 1'), 'select 1 where x = 1');
    assert.equal(t('insert into t (id) values (emp_seq.nextval)'), "insert into t (id) values (nextval('emp_seq'))");
    assert.equal(t('select hr.emp_seq.currval'), "select currval('hr.emp_seq')");
    assert.equal(t("select * from emp where deptno = v('P1_DEPTNO') and x = nv('p1_n')"), 'select * from emp where deptno = :P1_DEPTNO and x = :P1_N');
    assert.equal(t('select a from t minus select a from u'), 'select a from t except select a from u');
    assert.equal(t('select a - b as minus from t'), 'select a - b as minus from t', 'a column called minus stays');
    assert.equal(t('select my_sysdate, x.sysdate, dual_id from t'), 'select my_sysdate, x.sysdate, dual_id from t');
  });

  test('literals, q-quotes, quoted names and comments are never changed', () => {
    const sql = `select 'nvl(x, y) from dual sysdate' a, q'[decode(a, b) it''s]' b, "NVL(x)" c -- nvl(c, d) sysdate\n /* v('P1_X') */ from t`;
    assert.equal(t(sql), sql);
    assert.equal(codeMask("a 'b' c").length, 7);
    assert.deepEqual(translateOracle(sql).done, []);
  });

  test('the import rewrites them and says so; what is left is still named', () => {
    const { doc, report } = apexToDoc(readFileSync(new URL('./fixtures/apex/f100.sql', import.meta.url), 'utf8'));
    const notes = report.entries.flatMap((e) => e.notes);
    assert.ok(notes.some((n) => /^Oracle SQL rewritten: .*nvl → coalesce/.test(n)), notes.join('\n'));
    assert.doesNotMatch(JSON.stringify(doc), /\bnvl\(/i);
  });
});

describe('sprint 187: Team Development issues for the hand work (NX-F1)', async () => {
  const { handWork } = await import('../src/apex-issues.ts');
  const issues = async (alias: string) => (await owner.query(
    `select i.title, i.body, i.page_no, i.status, i.app_id, (select string_agg(l.name, ',') from meta.team_issue_label il join meta.team_label l on l.id = il.label_id where il.issue_id = i.id) as labels
       from meta.team_issue i join meta.app a on a.id = i.app_id where a.alias = $1 order by i.id`, [alias])).rows;

  test('pgkiln import-apex makes one per component that needs hand work, linked to its page; --no-issues makes none', async () => {
    const { report } = apexToDoc(F100);
    const work = handWork(report);
    assert.ok(work.length > 3, 'the fixture has hand work');
    const r = cli('import-apex', join(FIX, 'f100.sql'), '--alias', 'apex187-cli');
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, new RegExp(`${work.length} Team Development issue\\(s\\) list what needs hand work`));
    const made = await issues('apex187-cli');
    assert.equal(made.length, work.length);
    for (const i of made) {
      assert.equal(i.status, 'open');
      assert.equal(i.labels, 'APEX import');
      assert.match(i.title, /^(Not mapped|Port): /);
      assert.match(i.body, /^From the APEX import of apex187-cli\.\n\n- APEX type: /);
    }
    const plsqlError = made.find((i) => /PLSQL_ERROR|PL\/SQL/.test(i.body));
    assert.ok(plsqlError, 'a PL/SQL component to port');
    assert.ok(made.some((i) => i.page_no !== null), 'linked to pages');
    const none = cli('import-apex', join(FIX, 'f100.sql'), '--alias', 'apex187-none', '--no-issues');
    assert.equal(none.code, 0, none.err);
    assert.equal((await issues('apex187-none')).length, 0);
  });

  test('the builder: on by default, off when unticked; the issues show in Team Development', async () => {
    const b = new Browser(app);
    await b.get('/builder/login');
    await b.submit('/builder/login', { username: 'admin', password: 'admin' });
    await b.get('/builder/import/apex');
    const up = await b.upload('/builder/import/apex', {}, { file: { name: 'f100.sql', type: 'application/sql', data: Buffer.from(F100) } });
    const url = up.headers.location as string;
    const rep = await b.get(url);
    assert.match(rep.body, /<input type="checkbox" name="issues" value="1" checked> Make a Team Development issue for each component that needs hand work \(\d+\)/);
    const done = await b.submit(url, { action: 'import', alias: 'apex187-builder', schema: 'sales', issues: '1' });
    assert.equal(done.statusCode, 303, done.body.slice(0, 300));
    const made = await issues('apex187-builder');
    assert.ok(made.length > 3);
    const team = (await b.get('/builder/team')).body;
    assert.match(team, /APEX import/);
  });
});

// (sprint 190) A real APEX 26.2.1 export: the sample application "Demonstration - HR" (46 pages), the owner's
// export with the developer's e-mail, workspace and workspace id replaced. The counts are floors: mapping more
// raises them, a parser or mapping regression lowers them.
describe('sprint 190 a real APEX 26.2 export (app 77536)', () => {
  const F77536 = readFileSync(join(FIX, 'f77536.sql'), 'utf8');
  test('parses (wwv_flow_t_plugin_attributes(…).to_clob) and maps every page but the global page', () => {
    const { doc, report } = apexToDoc(F77536);
    assert.equal(doc.app.name, 'Demonstration - HR');
    assert.equal(doc.pages.length, 45, '46 pages, without page 0');
    assert.ok(report.counts.mapped >= 283, `mapped ${report.counts.mapped}`);
    assert.ok(report.counts.mapped + report.counts.notes >= 424, `mapped with or without notes ${report.counts.mapped + report.counts.notes}`);
    assert.ok(report.counts.not_mapped <= 39, `not mapped ${report.counts.not_mapped}`);
  });
  test('a method after a call is the call\'s value', () => {
    const [c] = parseApexCalls(`begin\nwwv_flow_imp_shared.create_plugin_setting(\n p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2('a', 'b')).to_clob\n,p_x=>1\n);\nend;\n/\n`);
    assert.deepEqual(c.args.p_attributes, [['a', 'b']]);
    assert.equal(c.args.p_x, 1);
  });
});
