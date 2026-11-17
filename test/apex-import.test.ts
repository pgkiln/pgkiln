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
import { apexSource, apexSourceFromDir, apexToDoc, attributeAt, conditionOk, MAPPED_PROCESS_TYPES, MAPPED_VALIDATION_TYPES, NotAnApexExport, oracleisms, parseFp, reportText, type ReportEntry } from '../src/apeximport.ts';
import { Browser } from './helpers.ts';
import { apexCheck, checkText, qualifyTables, soleTableColumn, sqlObjects } from '../src/apex-check.ts';
import { codeMask, plsqlAsSql, translateOracle } from '../src/oracle-sql.ts';
import { handWork } from '../src/apex-issues.ts';

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
    assert.equal(v('Code not taken').expression, 'select 1\n  from sales.orders\n where code = :P3_CODE\n   and id <> coalesce(:P3_ID, -1)'); // (sprint 187) nvl rewritten
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
    // (sprint 209) a PL/SQL block of SQL statements became those statements, rewritten from Oracle's SQL
    assert.match(pr('Log the change').code, /^insert into sales\.order_log \(order_id, action, by_user, at\)\n {2}values \(:P3_ID, :REQUEST, :APP_USER, localtimestamp\(0\)\)$/);
    assert.equal(pr('Log the change').condition_type, 'request_not_in');
    assert.equal(pr('Log the change').condition_value, 'DELETE');
    assert.ok(!entry('process', 'Log the change').port);
    assert.ok(entry('process', 'Log the change').notes.includes('the PL/SQL block became its SQL statements'));
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
    // (sprint 190) charts are mapped from their series; this one has none
    assert.match(r(1, 'Sales by Month').source, /no series with a source, label and value/);
    // (sprint 211) a PL/SQL region of htp.p calls is a dynamic region: its SELECT returns the HTML
    assert.equal(r(1, 'News').type, 'dynamic');
    assert.equal(r(1, 'News').source, "select ('<b>' || sales_pkg.news || '</b>') || chr(10)");
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
      ['PRODUCTS', "select name || ' (' || coalesce(code, '-') || ')' d, id r from sales.products order by 1"],
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
    assert.deepEqual(da('Fill the total').map((x: any) => [x.action, x.code, x.items_to_submit]), [['set_value', 'select credit_limit from sales.customers where id = :P3_CUSTOMER_ID', 'P3_CUSTOMER_ID']]);
    assert.deepEqual(da('Cancel Dialog').map((x: any) => [x.event, x.trigger_element, x.action]), [['click', 'CANCEL', 'cancel_dialog']]);
    const refresh = page(2).dynamic_actions.find((x: any) => x.name === 'Refresh after dialog');
    assert.deepEqual([refresh.event, refresh.action, refresh.affected_region_id], ['dialog_closed', 'refresh_region', r(2, 'Orders').id]);
    assert.equal(entry('dynamic_action', 'Highlight rows').status, 'not_mapped');
    // (sprint 190) create_jet_chart is read now
    assert.deepEqual(report.skipped, {}, '(sprint 209) interactive report columns are read');
  });

  test('the report as text: not mapped first, with the APEX types and what to port', () => {
    const text = reportText(report);
    assert.match(text, /^APEX application 100 "Order's Desk" \(APEX 23\.2\.0\) → orders-desk\n/);
    assert.ok(text.indexOf('NOT MAPPED') < text.indexOf('MAPPED WITH NOTES'));
    assert.match(text, /validation "Legacy PL\/SQL error" \(PLSQL_ERROR\)/);
    assert.match(text, /process "Recalculate" \(NATIVE_INVOKE_API\) → sql {2}\[needs porting\]/);
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

describe('sprint 187: common Oracle SQL rewritten (NX-F1)', () => {
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

describe('sprint 187: Team Development issues for the hand work (NX-F1)', () => {
  const issues = async (alias: string) => (await owner.query(
    `select i.title, i.body, i.page_no, i.status, i.app_id, (select string_agg(l.name, ',') from meta.team_issue_label il join meta.team_label l on l.id = il.label_id where il.issue_id = i.id) as labels
       from meta.team_issue i join meta.app a on a.id = i.app_id where a.alias = $1 order by i.id`, [alias])).rows;

  test('pgkiln import-apex makes one per component that needs hand work, linked to its page; --no-issues makes none', async () => {
    const { report } = apexToDoc(F100);
    // (sprint 192) the import checks the database first: a component whose tables are missing is hand work too
    await apexCheck(owner, report);
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
      assert.match(i.title, /^(Not mapped|Port|Missing objects): /);
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
    assert.equal(doc.pages.length, 44, '46 pages, without page 0 and (sprint 209) the login page of APEX_AUTHENTICATION.LOGIN');
    assert.ok(report.counts.mapped >= 300, `mapped ${report.counts.mapped}`);
    assert.ok(report.counts.mapped + report.counts.notes >= 452, `mapped with or without notes ${report.counts.mapped + report.counts.notes}`);
    assert.ok(report.counts.not_mapped <= 10, `not mapped ${report.counts.not_mapped}`); // (sprint 209) the login page is one
  });

  test('charts, cards, calendar, faceted search, lists and classic reports of APEX 26.2 become pgkiln regions', () => {
    const { doc } = apexToDoc(F77536) as { doc: any };
    const regions = doc.pages.flatMap((p: any) => p.regions.map((r: any) => ({ ...r, page_no: p.page_no })));
    const byType = (t: string) => regions.filter((r: any) => r.type === t);
    // charts: kind from create_jet_chart, the SELECT from the series (label, aggregate, table)
    const modes = regions.find((r: any) => r.title === 'Order Modes');
    assert.equal(modes.type, 'chart');
    assert.equal(modes.config.kind, 'pie');
    assert.match(modes.source, /^select order_mode, count\(\*\) as "Series 1"\n  from \S*oehr_orders\n group by order_mode\n order by 1$/);
    assert.equal(byType('chart').length, 8);
    // cards: the card's columns under the names the cards region reads (a list of values' display column is the column)
    const cards = regions.find((r: any) => r.type === 'cards' && r.page_no === 5);
    assert.match(cards.source, /customer_id as title, order_date as body, order_mode as badge, q\.\*/);
    // calendar: p_attributes start_date_column / display_column
    const cal = byType('calendar')[0];
    assert.match(cal.source, /order_date as start_date, order_date as title, q\.\*/);
    // faceted search: its facet items, and the report it filters (a classic report, now interactive)
    const facets = regions.find((r: any) => r.type === 'facets' && r.page_no === 3);
    const target = regions.find((r: any) => r.id === facets.config.report);
    assert.equal(target?.title, 'Customers');
    assert.equal(target.type, 'report');
    assert.ok(facets.config.facets.some((f: any) => f.column === 'account_mgr_id' && f.exclude === true));
    const credit = facets.config.facets.find((f: any) => f.column === 'credit_limit');
    assert.equal(credit.type, 'range');
    assert.deepEqual(credit.ranges[0], { to: 300, label: '<300' });
    assert.deepEqual(credit.ranges[1], { from: 300, to: 1000, label: '300 - 1,000' });
    assert.ok(!doc.pages.find((p: any) => p.page_no === 3).items.some((i: any) => i.name === 'P3_ACCOUNT_MGR_ID'), 'a facet is not a page item');
    // lists: the lists list regions show, their entries by position in the file; the navigation menu has its own 8
    assert.equal(byType('list').length, 8);
    assert.equal(doc.lists.length, 8);
    assert.equal(doc.list_entries.length, 24);
    assert.ok(byType('list').every((r: any) => doc.lists.some((l: any) => l.name === r.config.list)));
    assert.deepEqual(doc.nav.map((x: any) => x.label).sort(), ['Administration', 'Customers', 'Dashboard', 'Employees', 'Home', 'Order Search', 'Orders', 'Orders Calendar']);
    // create_report_region: classic reports; an interactive grid's key from its columns (no p_region_id in 26.2)
    assert.ok(byType('classic_report').length >= 6);
    assert.ok(byType('grid').every((g: any) => g.pk_column), 'every grid has its key column');
    // authorization: NATIVE_IS_IN_GROUP from p_attributes
    assert.deepEqual(doc.authz_schemes.find((x: any) => x.name === 'ADMINISTRATION_RIGHTS'), { name: 'ADMINISTRATION_RIGHTS', type: 'role', value: 'administrator', error_message: 'Insufficient privileges, user is not an Administrator' });
    // processes: p_attributes by their 26.2 names; APEX's own login API is pgkiln's sign-in
    // (sprint 209) the login page (an Invoke API process of APEX_AUTHENTICATION.LOGIN) is not imported: pgkiln signs users in
    assert.ok(!doc.pages.some((p: any) => p.page_no === 9999));
  });
  test('attributeAt reads p_attribute_NN, else the 26.2 name', () => {
    assert.equal(attributeAt({ p_attribute_01: 'EMAIL' }, 'NATIVE_TEXT_FIELD', 1), 'EMAIL');
    assert.equal(attributeAt({ p_attributes: [['subtype', 'URL']] }, 'NATIVE_TEXT_FIELD', 1), 'URL');
    assert.equal(attributeAt({ p_attributes: [['package', 'P', 'package_method', 'M']] }, 'NATIVE_INVOKE_API', 4), 'M');
    assert.equal(attributeAt({ p_attributes: [['x', 'y']] }, 'NATIVE_TEXT_FIELD', 1), null);
  });
  test('a method after a call is the call\'s value', () => {
    const [c] = parseApexCalls(`begin\nwwv_flow_imp_shared.create_plugin_setting(\n p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2('a', 'b')).to_clob\n,p_x=>1\n);\nend;\n/\n`);
    assert.deepEqual(c.args.p_attributes, [['a', 'b']]);
    assert.equal(c.args.p_x, 1);
  });
});

// (sprint 192, NX-F5) From Oracle to pgkiln: the database objects an APEX application uses, checked against the target
// schema's catalogue (`pgkiln import-apex --check`, the builder's report), and the PL/SQL that ora2pg already converted.
// test/fixtures/apex/oehr-postgres.sql is ora2pg's output for oehr-oracle.sql (scripts/oracle-e2e.sh makes it again).
describe('sprint 192: from Oracle to pgkiln (NX-F5)', () => {
  const F77536 = readFileSync(join(FIX, 'f77536.sql'), 'utf8');
  const SCHEMAS = ['apex192_oehr', 'apex192_sales', 'sales_pkg'];
  before(async () => {
    await owner.query(`drop schema if exists ${SCHEMAS.join(', ')} cascade`);
    await owner.query('create schema apex192_oehr');
    const ddl = readFileSync(join(FIX, 'oehr-postgres.sql'), 'utf8');
    await owner.tx(async (c) => {
      await c.query(`set local search_path = apex192_oehr`);
      await c.query(ddl);
    });
  });
  after(async () => {
    await owner.query(`drop schema if exists ${SCHEMAS.join(', ')} cascade`);
  });

  test('the objects a SQL or PL/SQL text names: FROM lists, joins, DML, sequences, package calls', () => {
    assert.deepEqual(sqlObjects(`select a.x, extract(year from a.d) y, trim(both ' ' from b.n) from emp a, dept b join "LOC" l on l.id = b.id
       left join hr.jobs j using (job_id) where exists (select 1 from dual) and seq_x.nextval > pkg.f(1)`),
    { tables: ['emp', 'dept', 'loc', 'hr.jobs'], sequences: ['seq_x'], routines: ['pkg.f'] });
    assert.deepEqual(sqlObjects(`with t as (select * from s) select * from t`).tables, ['s'], 'a WITH name is not a table');
    assert.deepEqual(sqlObjects(`begin insert into audit_log (x) values (1); update emp set x = 1; delete from dept;
       select count(*) into v from jobs for update; app_pkg.after_save(:P3_ID); hr.app_pkg.notify; apex_util.set_session_state('X', 1); end;`),
    { tables: ['audit_log', 'emp', 'dept', 'jobs'], sequences: [], routines: ['app_pkg.after_save', 'app_pkg.notify'] });
    assert.deepEqual(sqlObjects(`select 'from x' a /* from y */ -- from z\n from t`).tables, ['t'], 'literals and comments are not code');
    assert.deepEqual(qualifyTables('select * from emp e join "DEPT" d on d.id = e.d, hr.jobs where x in (select 1 from dual)', 'oehr'),
      { sql: 'select * from oehr.emp e join oehr.dept d on d.id = e.d, hr.jobs where x in (select 1 from dual)', n: 2 });
    // (sprint 217) APEX's views pgkiln has are in schema apex, whatever the parsing schema; the others stay; a
    // comparison "is not distinct from null" (decode → case) is not a FROM list
    assert.deepEqual(qualifyTables('select * from apex_activity_log l, emp e, apex_collections c where l.x is not distinct from null', 'oehr'),
      { sql: 'select * from apex.apex_activity_log l, oehr.emp e, apex_collections c where l.x is not distinct from null', n: 2 });
    assert.deepEqual(qualifyTables('select role_name from APEX_APPL_ACL_ROLES', ''), { sql: 'select role_name from apex.apex_appl_acl_roles', n: 1 }, 'without a schema too');
    assert.equal(soleTableColumn('select * from emp', 'ename', (t) => `s.${t}`), 's.emp.ename');
    assert.equal(soleTableColumn('select ename || job as label from emp', 'label', (t) => t), null, 'an alias is not a column');
    assert.equal(soleTableColumn('select * from emp join dept using (d)', 'x', (t) => t), null, 'two tables: not checked');
  });

  test('(sprint 217) median, listagg, sysdate ± days and two APEX functions are rewritten; what could change the meaning is not', () => {
    const t = (sql: string) => translateOracle(sql).sql;
    assert.equal(t('select median(elap) m from t'), 'select percentile_cont(0.5) within group (order by elap) m from t');
    assert.equal(t('select median(sal) over (partition by d) from emp'), 'select median(sal) over (partition by d) from emp', 'a window function stays');
    assert.equal(t("select listagg( role_name, ', ') WITHIN GROUP (ORDER BY role_name) r from x"), "select string_agg((role_name)::text, ', ' order by role_name) r from x");
    assert.equal(t('select listagg(x) within group (order by x) from t'), "select string_agg((x)::text, '' order by x) from t");
    for (const keep of ['select listagg(x, \',\' on overflow truncate) within group (order by x) from t', 'select listagg(x) within group (order by x) over () from t'])
      assert.equal(t(keep), keep);
    assert.equal(t('where t >= sysdate - ( 1/24/60/60 * :P1_SECONDS )'), "where t >= localtimestamp(0) - (( 1.0/24.0/60.0/60.0 * :P1_SECONDS )) * interval '1 day'");
    assert.equal(t('where a > sysdate - 1 and b < sysdate + 1/24'), "where a > localtimestamp(0) - (1.0) * interval '1 day' and b < localtimestamp(0) + (1.0/24.0) * interval '1 day'");
    // a date minus a date is a number of days in Oracle: the operand may be a date, so it stays
    for (const keep of ['sysdate - hire_date', 'sysdate - (select max(d) from t)', 'sysdate - 2 * x'])
      assert.equal(t(`select ${keep} from t`), `select ${keep.replace('sysdate', 'localtimestamp(0)')} from t`, keep);
    assert.equal(t("select apex_lang.message('X') a, apex_app_setting.get_value(p_name => 'S') b"), "select meta.message('X') a, meta.get_app_setting(p_name => 'S') b");
    assert.equal(t('where instr(:P1_ROLES, role_id, 1) > 0 and instr(a, \'x\') = 0'), "where strpos((:P1_ROLES)::text, (role_id)::text) > 0 and strpos((a)::text, ('x')::text) = 0");
    assert.equal(t('select instr(a, b, 2), instr(a, b, 1, 2) from t'), 'select instr(a, b, 2), instr(a, b, 1, 2) from t', 'another start or occurrence stays');
    assert.equal(t("select 'median(x) sysdate - 1' a"), "select 'median(x) sysdate - 1' a", 'literals are not code');
  });

  test('(sprint 217) f77536\'s administration pages read APEX\'s views from schema apex', () => {
    const { doc } = apexToDoc(F77536) as { doc: any };
    const sql = JSON.stringify(doc);
    for (const v of ['apex_activity_log', 'apex_appl_acl_users', 'apex_appl_acl_roles', 'apex_application_pages', 'apex_team_feedback', 'apex_automation_log'])
      assert.ok(sql.includes(`apex.${v}`), v);
    assert.doesNotMatch(sql.replace(/-- [^\\]*/g, ''), /[^.\w]apex_activity_log/i, 'none left unqualified (but in a comment)');
    assert.match(sql, /apex_collections/, 'collections: pgkiln has none');
  });

  test('the importer records what each component uses; quoted upper-case names become lower case; unqualified tables get the schema', () => {
    const { doc, report } = apexToDoc(F77536) as { doc: any; report: any };
    const uses = (k: 'tables' | 'columns') => new Set(report.entries.flatMap((e: any) => e.uses?.[k] ?? []));
    for (const t of ['countries', 'customers', 'departments', 'employees', 'jobs', 'locations', 'orders', 'order_items', 'products', 'product_information', 'regions', 'warehouses'])
      assert.ok(uses('tables').has(`wksp_demo.oehr_${t}`), t);
    for (const c of ['oehr_customers.cust_last_name', 'oehr_orders.order_total', 'oehr_order_items.unit_price', 'oehr_jobs.job_title', 'oehr_products.product_status'])
      assert.ok(uses('columns').has(`wksp_demo.${c}`), c);
    // APEX 26.2 leaves out p_source_type of a form's column items: the form knows its columns and key
    const p4 = doc.pages.find((p: any) => p.page_no === 4);
    assert.equal(p4.items.find((i: any) => i.name === 'P4_CUST_LAST_NAME').source_column, 'cust_last_name');
    assert.equal(p4.regions.find((r: any) => r.type === 'form').pk_column, 'customer_id');
    const sql = JSON.stringify(doc.pages.flatMap((p: any) => p.regions.map((r: any) => r.source)));
    assert.doesNotMatch(sql, /\\"OEHR_|\\"ORDER_TOTAL\\"/, '"OEHR_ORDERS" is oehr_orders');
    assert.doesNotMatch(sql, /from oehr_/, 'every table has the schema');
  });

  test('pgkiln import-apex --check: without the OEHR tables, every one is missing (exit 1); with them only APEX views are left', () => {
    const none = cli('import-apex', join(FIX, 'f77536.sql'), '--check', '--schema', 'apex192_none', '--json');
    assert.equal(none.code, 1, none.err);
    const j = JSON.parse(none.out);
    const missing = (t: string) => j.check.missing.filter((m: any) => m.type === t).map((m: any) => m.name);
    assert.equal(j.check.schema, 'apex192_none');
    assert.deepEqual(missing('table').filter((n: string) => /oehr_/.test(n)).length, 12);
    assert.ok(missing('table').includes('apex192_none.oehr_employees'));
    assert.ok(missing('apex_view').includes('apex_workspace_apex_users'));
    assert.deepEqual(missing('column'), [], 'columns of a missing table are not listed again');
    const entry = j.entries.find((e: any) => e.kind === 'region' && e.name === 'Employees' && e.page === 8);
    assert.deepEqual(entry.missing, ['table apex192_none.oehr_employees']);
    assert.ok(entry.notes.some((n: string) => /^missing in PostgreSQL: table or view apex192_none\.oehr_employees/.test(n)));

    const ok = cli('import-apex', join(FIX, 'f77536.sql'), '--check', '--schema', 'apex192_oehr');
    assert.equal(ok.code, 1, 'APEX views are still missing');
    assert.match(ok.out, /Database objects \(schema apex192_oehr\): the application uses \d+ table\(s\) or view\(s\), \d+ column\(s\)/);
    assert.doesNotMatch(ok.out, /^ {2}table +apex192_oehr\.oehr_/m);
    assert.doesNotMatch(ok.out, /^ {2}column /m, 'every column the importer knows is there');
    assert.match(ok.out, /^ {2}apex view +apex_workspace_apex_users/m);
    assert.match(ok.out, /Check only: nothing was imported/);
    assert.equal((cli('import-apex', join(FIX, 'f77536.sql'), '--check', '--dry-run')).code, 2, '--check imports nothing anyway');
  });

  test('a column the database lacks; sequences; PL/SQL that ora2pg converted (package as schema, or pkg_proc)', async () => {
    await owner.query('alter table apex192_oehr.oehr_orders rename column order_total to total');
    try {
      const { report } = apexToDoc(F77536, { schema: 'apex192_oehr' });
      const c = await apexCheck(owner, report);
      assert.deepEqual(c.missing.filter((m) => m.type === 'column').map((m) => m.name), ['apex192_oehr.oehr_orders.order_total']);
    } finally {
      await owner.query('alter table apex192_oehr.oehr_orders rename column total to order_total');
    }
    // f100: sales_pkg.below_limit (a PL/SQL expression), sales_pkg.check_order (PL/SQL), sales_pkg.recalculate (Invoke API)
    await owner.query(`create schema apex192_sales; create schema sales_pkg;
      create function sales_pkg.below_limit(p_total numeric) returns boolean language sql as 'select p_total < 1000';
      create procedure apex192_sales.sales_pkg_recalculate(p_id int) language sql as 'select 1';
      create sequence apex192_sales.orders_seq`);
    const seq = (name: string) => F100.replace("'select code from orders where id = :P3_ID'", `'select ${name}.nextval from dual'`);
    const other = await apexCheck(owner, apexToDoc(seq('codes_seq'), { schema: 'apex192_sales' }).report);
    assert.ok(other.missing.some((m) => m.type === 'sequence' && m.name === 'apex192_sales.codes_seq'));
    const { report } = apexToDoc(seq('orders_seq'), { schema: 'apex192_sales' });
    const c = await apexCheck(owner, report);
    assert.equal(c.used.sequences, 1);
    assert.ok(!c.missing.some((m) => m.type === 'sequence'));
    assert.deepEqual(c.found.map((f) => [f.name, f.as]), [
      ['sales_pkg.below_limit', 'sales_pkg.below_limit(p_total numeric)'],
      ['sales_pkg.recalculate', 'apex192_sales.sales_pkg_recalculate(IN p_id integer)'],
    ]);
    assert.ok(c.missing.some((m) => m.type === 'routine' && m.name === 'sales_pkg.credit_error'));
    const invoke = report.entries.find((e) => e.kind === 'process' && e.name === 'Recalculate')!;
    assert.ok(invoke.hints?.[0].startsWith('sales_pkg.recalculate exists in PostgreSQL as apex192_sales.sales_pkg_recalculate(IN p_id integer) (as ora2pg converts it)'), invoke.notes.join('\n'));
    assert.match(checkText(c), /PL\/SQL routines that exist in PostgreSQL:\n {2}sales_pkg\.below_limit → sales_pkg\.below_limit\(p_total numeric\)/);
  });

  test('the builder shows the check before Import, with the workspace\'s developer login', async () => {
    const b = new Browser(app);
    await b.get('/builder/login');
    await b.submit('/builder/login', { username: 'admin', password: 'admin' });
    await b.get('/builder/import/apex');
    const up = await b.upload('/builder/import/apex', {}, { file: { name: 'f77536.sql', type: 'application/sql', data: Buffer.from(F77536) } });
    const url = up.headers.location as string;
    assert.ok(url, `${up.statusCode} ${up.body.slice(0, 500)}`);
    const none = await b.submit(url, { action: 'preview', alias: 'apex192-builder', schema: 'apex192_none' });
    assert.match(none.body, /<h2[^>]*>Database objects<\/h2>/);
    assert.match(none.body, /data-apex-missing="(\d+)"/);
    assert.match(none.body, /<code>apex192_none\.oehr_orders<\/code>/);
    const ok = await b.submit(url, { action: 'preview', alias: 'apex192-builder', schema: 'apex192_oehr' });
    assert.doesNotMatch(ok.body, /<code>apex192_oehr\.oehr_orders<\/code>/);
    assert.match(ok.body, /<code>apex_workspace_apex_users<\/code>/);
  });
});

describe('sprint 209 NX-F5: shared components, report and grid columns, PL/SQL that is SQL', () => {
  // a hand-written export in APEX 23.2's format: the parts sprint 209 reads
  const SHOP = `
begin
wwv_flow_imp.import_begin(p_version_yyyy_mm_dd=>'2023.10.31',p_release=>'23.2.0',p_default_application_id=>209,p_default_owner=>'APEX209');
end;
/
begin
wwv_imp_workspace.create_flow(p_id=>wwv_flow.g_flow_id,p_owner=>'APEX209',p_name=>'Shop 209',p_alias=>'SHOP209',p_flow_language=>'en');
wwv_flow_imp_shared.create_build_option(p_id=>wwv_flow_imp.id(901),p_build_option_name=>'Feature: Extras',p_build_option_status=>'INCLUDE',p_build_option_comment=>'Extra features');
wwv_flow_imp_shared.create_build_option(p_id=>wwv_flow_imp.id(902),p_build_option_name=>'Commented Out',p_build_option_status=>'EXCLUDE');
wwv_flow_imp_shared.create_flow_item(p_id=>wwv_flow_imp.id(911),p_name=>'AI_CURRENCY',p_protection_level=>'I',p_item_comment=>'The shop''s currency');
wwv_flow_imp_shared.create_flow_item(p_id=>wwv_flow_imp.id(912),p_name=>'AI_GREETING',p_scope=>'GLOBAL');
wwv_flow_imp_shared.create_flow_process(p_id=>wwv_flow_imp.id(921),p_process_sequence=>1,p_process_point=>'ON_NEW_INSTANCE',p_process_type=>'NATIVE_PLSQL',p_process_name=>'Set currency',p_process_sql_clob=>':AI_CURRENCY := ''EUR'';',p_process_clob_language=>'PLSQL');
wwv_flow_imp_shared.create_flow_process(p_id=>wwv_flow_imp.id(922),p_process_sequence=>2,p_process_point=>'BEFORE_HEADER',p_process_type=>'NATIVE_PLSQL',p_process_name=>'Greeting',p_process_sql_clob=>'begin :AI_GREETING := ''Hello from '' || nvl(:AI_CURRENCY, ''the shop''); end;',p_process_clob_language=>'PLSQL',p_required_patch=>wwv_flow_imp.id(901));
wwv_flow_imp_shared.create_flow_process(p_id=>wwv_flow_imp.id(923),p_process_sequence=>3,p_process_point=>'ON_DEMAND',p_process_type=>'NATIVE_PLSQL',p_process_name=>'Real PL/SQL',p_process_sql_clob=>'declare l number; begin l := 1; htp.p(l); end;',p_process_when_type=>'NEVER');
wwv_flow_imp_shared.create_flow_computation(p_id=>wwv_flow_imp.id(931),p_computation_sequence=>10,p_computation_item=>'AI_CURRENCY',p_computation_point=>'AFTER_LOGIN',p_computation_type=>'QUERY',p_computation=>'select ''EUR'' from dual');
wwv_flow_imp_shared.create_flow_computation(p_id=>wwv_flow_imp.id(932),p_computation_sequence=>20,p_computation_item=>'AI_GREETING',p_computation_point=>'NEVER',p_computation_type=>'STATIC_ASSIGNMENT',p_computation=>'x');
wwv_flow_imp_shared.create_app_setting(p_id=>wwv_flow_imp.id(941),p_name=>'SHIP_MODE',p_value=>'FAST',p_is_required=>'Y',p_valid_values=>'FAST, SLOW',p_on_upgrade_keep_value=>false,p_comments=>'How we ship');
wwv_flow_imp_shared.create_list_of_values(p_id=>wwv_flow_imp.id(951),p_lov_name=>'CATEGORIES',p_lov_query=>'select name d, code r from category order by 1',p_source_type=>'LEGACY_SQL');
wwv_flow_imp_page.create_page(p_id=>1,p_name=>'Products',p_step_title=>'Products',p_page_is_public_y_n=>'Y');
wwv_flow_imp_page.create_page_plug(p_id=>wwv_flow_imp.id(1001),p_plug_name=>'Products',p_plug_display_sequence=>10,p_query_type=>'TABLE',p_query_table=>'PRODUCT',p_plug_source_type=>'NATIVE_IR');
wwv_flow_imp_page.create_worksheet(p_id=>wwv_flow_imp.id(1002),p_show_detail_link=>'C',p_detail_link=>'f?p=&APP_ID.:2:&SESSION.::&DEBUG.:RP:P2_ID:\\#ID#\\',p_no_data_found_message=>'No products.');
wwv_flow_imp_page.create_worksheet_column(p_id=>wwv_flow_imp.id(1003),p_db_column_name=>'ID',p_display_order=>1,p_column_label=>'Id',p_display_text_as=>'HIDDEN_ESCAPE_SC');
wwv_flow_imp_page.create_worksheet_column(p_id=>wwv_flow_imp.id(1004),p_db_column_name=>'NAME',p_display_order=>2,p_column_label=>'Product');
wwv_flow_imp_page.create_worksheet_column(p_id=>wwv_flow_imp.id(1005),p_db_column_name=>'PRICE',p_display_order=>3,p_column_label=>'Price',p_format_mask=>'999G990D00');
wwv_flow_imp_page.create_worksheet_column(p_id=>wwv_flow_imp.id(1006),p_db_column_name=>'CATEGORY',p_display_order=>4,p_column_label=>'Category',p_display_text_as=>'LOV_ESCAPE_SC',p_rpt_named_lov=>wwv_flow_imp.id(951));
wwv_flow_imp_page.create_worksheet_column(p_id=>wwv_flow_imp.id(1007),p_db_column_name=>'SECRET',p_display_order=>5,p_column_label=>'Secret note',p_format_mask=>'SINCE');
wwv_flow_imp_page.create_worksheet_rpt(p_id=>wwv_flow_imp.id(1008),p_application_user=>'APXWS_DEFAULT',p_is_default=>'Y',p_report_columns=>'ID:NAME:PRICE:CATEGORY',p_sort_column_1=>'NAME',p_sort_direction_1=>'DESC');
wwv_flow_imp_page.create_page_plug(p_id=>wwv_flow_imp.id(1010),p_plug_name=>'Greeting',p_plug_display_sequence=>20,p_plug_source=>'<p>&AI_GREETING.</p>',p_plug_source_type=>'NATIVE_STATIC',p_required_patch=>wwv_flow_imp.id(-902));
wwv_flow_imp_page.create_page_plug(p_id=>wwv_flow_imp.id(1011),p_plug_name=>'Old notes',p_plug_display_sequence=>30,p_plug_source=>'<p>commented out</p>',p_plug_source_type=>'NATIVE_STATIC',p_required_patch=>wwv_flow_imp.id(902));
wwv_flow_imp_page.create_page_item(p_id=>wwv_flow_imp.id(1020),p_name=>'P1_X',p_item_sequence=>10,p_display_as=>'NATIVE_HIDDEN');
wwv_flow_imp_page.create_page_process(p_id=>wwv_flow_imp.id(1021),p_process_sequence=>10,p_process_point=>'BEFORE_HEADER',p_process_type=>'NATIVE_PLSQL',p_process_name=>'Broken lookup',p_process_sql_clob=>'select missing_column into :P1_X from product where id = 1;');
wwv_flow_imp_page.create_page(p_id=>2,p_name=>'Product',p_page_mode=>'MODAL',p_page_is_public_y_n=>'Y');
wwv_flow_imp_page.create_page_item(p_id=>wwv_flow_imp.id(2001),p_name=>'P2_ID',p_item_sequence=>10,p_display_as=>'NATIVE_HIDDEN');
wwv_flow_imp_page.create_page(p_id=>3,p_name=>'Price list',p_page_is_public_y_n=>'Y');
wwv_flow_imp_page.create_page_plug(p_id=>wwv_flow_imp.id(3001),p_plug_name=>'Price list',p_plug_display_sequence=>10,p_query_type=>'TABLE',p_query_table=>'PRODUCT',p_plug_source_type=>'NATIVE_IG');
wwv_flow_imp_page.create_region_column(p_id=>wwv_flow_imp.id(3002),p_name=>'ID',p_source_type=>'DB_COLUMN',p_source_expression=>'ID',p_item_type=>'NATIVE_HIDDEN',p_display_sequence=>10,p_is_primary_key=>true,p_is_required=>true);
wwv_flow_imp_page.create_region_column(p_id=>wwv_flow_imp.id(3003),p_name=>'NAME',p_source_type=>'DB_COLUMN',p_source_expression=>'NAME',p_item_type=>'NATIVE_TEXT_FIELD',p_heading=>'Product',p_display_sequence=>20,p_is_required=>true);
wwv_flow_imp_page.create_region_column(p_id=>wwv_flow_imp.id(3004),p_name=>'PRICE',p_source_type=>'DB_COLUMN',p_source_expression=>'PRICE',p_item_type=>'NATIVE_NUMBER_FIELD',p_heading=>'Price',p_format_mask=>'999G990D00',p_default_type=>'STATIC',p_default_expression=>'0',p_display_sequence=>30);
wwv_flow_imp_page.create_region_column(p_id=>wwv_flow_imp.id(3005),p_name=>'CATEGORY',p_source_type=>'DB_COLUMN',p_source_expression=>'CATEGORY',p_item_type=>'NATIVE_SELECT_LIST',p_heading=>'Category',p_lov_type=>'SHARED',p_lov_id=>wwv_flow_imp.id(951),p_display_sequence=>40);
wwv_flow_imp_page.create_region_column(p_id=>wwv_flow_imp.id(3006),p_name=>'SECRET',p_source_type=>'DB_COLUMN',p_source_expression=>'SECRET',p_item_type=>'NATIVE_DISPLAY_ONLY',p_heading=>'Secret',p_display_sequence=>50);
wwv_flow_imp_page.create_region_column(p_id=>wwv_flow_imp.id(3007),p_name=>'APEX$ROW_ACTION',p_item_type=>'NATIVE_ROW_ACTION',p_display_sequence=>60);
wwv_flow_imp_page.create_interactive_grid(p_id=>wwv_flow_imp.id(3010),p_is_editable=>true,p_edit_operations=>'u');
wwv_flow_imp_page.create_ig_report(p_id=>wwv_flow_imp.id(3011),p_interactive_grid_id=>wwv_flow_imp.id(3010),p_type=>'PRIMARY');
wwv_flow_imp_page.create_ig_report_view(p_id=>wwv_flow_imp.id(3012),p_report_id=>wwv_flow_imp.id(3011),p_view_type=>'GRID');
wwv_flow_imp_page.create_ig_report_column(p_id=>wwv_flow_imp.id(3013),p_view_id=>wwv_flow_imp.id(3012),p_display_seq=>1,p_column_id=>wwv_flow_imp.id(3003),p_is_visible=>true,p_is_frozen=>true,p_width=>200);
wwv_flow_imp_page.create_ig_report_column(p_id=>wwv_flow_imp.id(3014),p_view_id=>wwv_flow_imp.id(3012),p_display_seq=>2,p_column_id=>wwv_flow_imp.id(3004),p_is_visible=>true,p_is_frozen=>false);
wwv_flow_imp_page.create_ig_report_column(p_id=>wwv_flow_imp.id(3015),p_view_id=>wwv_flow_imp.id(3012),p_display_seq=>3,p_column_id=>wwv_flow_imp.id(3005),p_is_visible=>false,p_is_frozen=>false);
wwv_flow_imp_page.create_page_process(p_id=>wwv_flow_imp.id(3020),p_process_sequence=>10,p_region_id=>wwv_flow_imp.id(3001),p_process_type=>'NATIVE_IG_DML',p_process_name=>'Save');
wwv_flow_imp_page.create_page(p_id=>4,p_name=>'Old page',p_page_is_public_y_n=>'Y',p_required_patch=>wwv_flow_imp.id(902));
wwv_flow_imp_page.create_page(p_id=>5,p_name=>'Cheap',p_page_is_public_y_n=>'Y');
wwv_flow_imp_page.create_report_region(p_id=>wwv_flow_imp.id(5001),p_name=>'Cheap products',p_display_sequence=>10,p_source=>'select id, name, price from product where price < 10',p_source_type=>'NATIVE_SQL_REPORT');
wwv_flow_imp_page.create_report_columns(p_id=>wwv_flow_imp.id(5002),p_query_column_id=>1,p_column_alias=>'ID',p_column_display_sequence=>1,p_column_heading=>'Id',p_hidden_column=>'Y');
wwv_flow_imp_page.create_report_columns(p_id=>wwv_flow_imp.id(5003),p_query_column_id=>2,p_column_alias=>'NAME',p_column_display_sequence=>2,p_column_heading=>'Cheap product',p_column_link=>'f?p=&APP_ID.:2:&SESSION.::&DEBUG.::P2_ID:#ID#',p_column_linktext=>'#NAME#');
wwv_flow_imp_page.create_report_columns(p_id=>wwv_flow_imp.id(5004),p_query_column_id=>3,p_column_alias=>'PRICE',p_column_display_sequence=>3,p_column_heading=>'Price',p_column_format=>'990D00');
end;
/
`;
  const ALIAS = 'apex209-shop';
  before(async () => {
    await owner.query(`delete from meta.app where alias = $1`, [ALIAS]);
    await owner.query('drop schema if exists apex209 cascade');
    await owner.query(`create schema apex209;
      create table apex209.category (code text primary key, name text not null);
      create table apex209.product (id int primary key, name text not null, price numeric(10,2), category text references apex209.category, secret text);
      insert into apex209.category values ('T', 'Tools'), ('G', 'Garden');
      insert into apex209.product values (1, 'Hammer', 12.5, 'T', 'top secret'), (2, 'Rake', 7.25, 'G', null), (3, 'Anvil', 99, 'T', null);
      grant usage on schema apex209 to hr_app;
      grant select, insert, update, delete on all tables in schema apex209 to hr_app`);
  });
  after(async () => {
    await owner.query(`delete from meta.app where alias = $1`, [ALIAS]);
    await owner.query('drop schema if exists apex209 cascade');
  });

  test('plsqlAsSql: SQL statements, item assignments, SELECT and RETURNING … INTO; real PL/SQL stays', () => {
    const t = (code: string) => plsqlAsSql(code)?.sql ?? null;
    assert.equal(t("begin\n  update emp set sal = sal * 1.1 where deptno = :P2_DEPTNO;\n  delete from log where x = 'a;b';\nend;"),
      "update emp set sal = sal * 1.1 where deptno = :P2_DEPTNO;\ndelete from log where x = 'a;b'");
    assert.equal(t(':P1_A := upper(:P1_B);\n:P1_C := nvl(:P1_D, 0);'), 'select upper(:P1_B) as p1_a,\n       nvl(:P1_D, 0) as p1_c');
    assert.equal(t('select ename, sal into :P3_ENAME, :P3_SAL from emp where empno = :P3_EMPNO;'), 'select ename as p3_ename, sal as p3_sal\n from emp where empno = :P3_EMPNO');
    assert.equal(t('insert into t (a) values (:P1_A) returning id into :P1_ID;'), 'insert into t (a) values (:P1_A) returning id as p1_id');
    assert.equal(t("begin\n  -- a comment; with a semicolon\n  :P1_X := 'it''s; fine';\nend;"), "select 'it''s; fine' as p1_x");
    assert.equal(t('update t set a = 1;\n:P1_DONE := \'Y\';'), "update t set a = 1;\nselect 'Y' as p1_done");
    for (const code of [
      ":P1_A := 'x';\n:P1_B := :P1_A || 'y';", // reads an item set just before: one SELECT would see the old value
      'begin if :P1_X is null then null; end if; end;',
      'declare l number; begin null; end;',
      "apex_util.set_session_state('P1_X', 1);",
      'select count(*) into l_cnt from emp',
      'select a, b into :P1_A from t',
      ':P1_A := 1;\nupdate t set a = 1;',
      '',
    ]) assert.equal(t(code), null, code);
  });

  test('build options, application items, processes, computations and settings', () => {
    const { doc, report } = apexToDoc(SHOP, { alias: ALIAS }) as { doc: any; report: any };
    const entry = (kind: string, name: string) => report.entries.find((e: any) => e.kind === kind && e.name === name);
    assert.deepEqual(doc.build_options, [
      { name: 'FEATURE_EXTRAS', status: 'include', description: 'Extra features', configurable: false },
      { name: 'COMMENTED_OUT', status: 'exclude', description: null, configurable: false },
    ]);
    assert.equal(entry('build_option', 'Commented Out').target, 'COMMENTED_OUT');
    assert.deepEqual(doc.app_items, [{ name: 'AI_CURRENCY', description: "The shop's currency" }, { name: 'AI_GREETING', description: null }]);
    assert.match(entry('app_item', 'AI_GREETING').notes.join(), /scope Global/);
    const proc = (n: string) => doc.app_processes.find((p: any) => p.name === n);
    assert.deepEqual(proc('Set currency'), { seq: 1, name: 'Set currency', point: 'after_login', code: "select 'EUR' as ai_currency", authz: null, build_option: null });
    assert.equal(proc('Greeting').point, 'before_page');
    assert.equal(proc('Greeting').code, "select 'Hello from ' || coalesce(:AI_CURRENCY, 'the shop') as ai_greeting");
    assert.equal(proc('Greeting').build_option, 'FEATURE_EXTRAS');
    assert.equal(proc('Real PL/SQL').point, 'ajax');
    assert.ok(entry('app_process', 'Real PL/SQL').port, 'real PL/SQL needs porting');
    assert.match(entry('app_process', 'Real PL/SQL').notes.join(), /condition \(NEVER\) is not carried over/);
    assert.deepEqual(doc.app_computations.map((c: any) => [c.item_name, c.point, c.type, c.expression]), [['AI_CURRENCY', 'after_authentication', 'sql_query', "select 'EUR'"]]);
    assert.equal(entry('app_computation', 'AI_GREETING').status, 'not_mapped');
    assert.deepEqual(doc.app_settings, [{ name: 'SHIP_MODE', value: 'FAST', description: 'How we ship', required: true, valid_values: ['FAST', 'SLOW'], keep_on_upgrade: false }]);
    // p_required_patch: the option, or (a negative id) while it is excluded
    const p1 = doc.pages.find((p: any) => p.page_no === 1);
    assert.equal(p1.regions.find((r: any) => r.title === 'Greeting').build_option, '!COMMENTED_OUT');
    assert.equal(p1.regions.find((r: any) => r.title === 'Old notes').build_option, 'COMMENTED_OUT');
    assert.equal(doc.pages.find((p: any) => p.page_no === 4).build_option, 'COMMENTED_OUT');
    assert.deepEqual(report.skipped, {});
  });

  test('interactive report, classic report and grid column settings', () => {
    const { doc, report } = apexToDoc(SHOP, { alias: ALIAS }) as { doc: any; report: any };
    const region = (t: string) => doc.pages.flatMap((p: any) => p.regions).find((r: any) => r.title === t);
    const notes = (t: string) => report.entries.find((e: any) => e.kind === 'region' && e.name === t).notes.join('\n');
    const ir = region('Products');
    // (sprint 211) the category column shows its list of values' display value: looked up in the query
    assert.equal(ir.source, 'select q."id",\n       q."name",\n       q."price",\n'
      + '       (select l.d from (select name d, code r from apex209.category order by 1) l(d, r) where l.r::text = q."category"::text limit 1) as "category",\n'
      + '       q."secret"\n  from (select * from apex209.product) q\n order by "name" desc');
    assert.deepEqual(ir.config, {
      headings: { name: 'Product', secret: 'Secret note' }, hidden: ['id', 'secret'], formats: { price: '999G990D00' },
      link: { column: 'id', page: 2, items: { P2_ID: '#id#' }, icon: true }, empty: 'No products.',
    });
    assert.match(notes('Products'), /columns category show their list of values' display value/);
    assert.match(notes('Products'), /APEX's SINCE format is not carried over/);
    assert.match(notes('Products'), /columns not in the default report \(secret\) became hidden columns/);
    const classic = region('Cheap products');
    assert.deepEqual(classic.config, { headings: { name: 'Cheap product' }, hidden: ['id'], formats: { price: '990D00' }, link: { column: 'name', page: 2, items: { P2_ID: '#id#' } } });
    const grid = region('Price list');
    assert.deepEqual(grid.config, {
      headings: { name: 'Product' }, hidden: ['id'], formats: { price: '999G990D00' }, readonly: ['secret'],
      columns: { name: { required: true }, price: { default: '0' }, category: { lov: 'LOV:CATEGORIES' } },
      layout: { order: ['name', 'price', 'category'], hidden: ['category'], widths: { name: 200 }, frozen: 1 },
      allow: { insert: false, update: true, delete: false },
    });
  });

  test('imported, the pages run: columns, link, build options, application items; a failing load process leaves the page working', async () => {
    const { doc } = apexToDoc(SHOP, { alias: ALIAS, dbRole: 'hr_app' });
    await owner.query('select meta.import_app($1::jsonb, $2)', [JSON.stringify(doc), ALIAS]);
    const back = (await owner.one<{ d: any }>('select meta.export_app($1) as d', [ALIAS]))!.d;
    for (const k of ['build_options', 'app_items', 'app_processes', 'app_computations', 'app_settings']) assert.equal(back[k].length, (doc as any)[k].length, k);
    const b = new Browser(app);
    const p1 = await b.get(`/a/${ALIAS}/1`);
    assert.equal(p1.statusCode, 200);
    const body = p1.body;
    assert.ok(body.includes('Hammer') && body.includes('Rake'), 'the report shows its rows after the failing load process');
    assert.ok(body.indexOf('Rake') < body.indexOf('Hammer'), 'sorted by name, descending');
    assert.match(body, /missing_column|unexpected error/, 'the load process\'s error shows');
    assert.ok(!body.includes('current transaction is aborted'));
    assert.match(body, />Product</);
    assert.ok(body.includes('Tools') && body.includes('Garden'), '(sprint 211) the category column shows its list of values\' display value');
    assert.ok(!body.includes('top secret'), 'a column left out of the default report is hidden');
    assert.match(body, /Hello from the shop/, 'the application process (build option included) sets the application item');
    assert.ok(!body.includes('commented out'), 'a region of an excluded build option is left out');
    assert.match(body, /href="[^"]*\/a\/apex209-shop\/2[^"]*P2_ID=3/, 'the detail link');
    assert.equal((await b.get(`/a/${ALIAS}/4`)).statusCode, 404, 'a page of an excluded build option');
    const p5 = await b.get(`/a/${ALIAS}/5`);
    assert.match(p5.body, /Cheap product/);
    assert.match(p5.body, /7\.25/);
    const p3 = await b.get(`/a/${ALIAS}/3`);
    assert.equal(p3.statusCode, 200);
    assert.match(p3.body, /Anvil/);
  });

  test('app 77536: its build options and settings, interactive report columns and links, grid layouts', () => {
    const { doc } = apexToDoc(readFileSync(join(FIX, 'f77536.sql'), 'utf8')) as { doc: any };
    assert.equal(doc.build_options.length, 9);
    assert.equal(doc.build_options.find((b: any) => b.name === 'COMMENTED_OUT').status, 'exclude');
    assert.deepEqual(doc.app_settings.map((s: any) => s.name).sort(), ['ACCESS_CONTROL_SCOPE', 'FEEDBACK_ATTACHMENTS_YN']);
    assert.ok(doc.pages.filter((p: any) => p.build_option).length >= 20, 'the administration pages keep their feature build options');
    const regions = doc.pages.flatMap((p: any) => p.regions);
    const countries = regions.find((r: any) => r.title === 'Countries' && r.type === 'report');
    assert.deepEqual(countries.config.link, { column: 'country_id', page: 13, items: { P13_COUNTRY_ID: '#country_id#' }, icon: true });
    assert.deepEqual(countries.config.hidden, ['country_id']);
    assert.match(countries.source, /order by "country_id"$/);
    const products = regions.find((r: any) => r.title === 'Product Information' && r.type === 'report');
    assert.ok(products.config.hidden.includes('category_id'));
    const items = regions.find((r: any) => r.title === 'Order Items' && r.type === 'grid');
    assert.ok(items.config.hidden.includes('line_item_id'));
    assert.ok(items.config.layout?.order.length >= 3);
  });
});

describe('sprint 211 NX-F5: saved reports, LOV display values, grid validations, breadcrumbs, chart axes, ACL roles, dynamic content', () => {
  // a hand-written export in APEX 23.2's format: the parts sprint 211 reads
  const STORE = `
begin
wwv_flow_imp.import_begin(p_version_yyyy_mm_dd=>'2023.10.31',p_release=>'23.2.0',p_default_application_id=>211,p_default_owner=>'APEX211');
end;
/
begin
wwv_imp_workspace.create_flow(p_id=>wwv_flow.g_flow_id,p_owner=>'APEX211',p_name=>'Store 211',p_alias=>'STORE211',p_flow_language=>'en');
wwv_flow_imp_shared.create_acl_role(p_id=>wwv_flow_imp.id(801),p_static_id=>'ADMINISTRATOR',p_name=>'Administrator',p_description=>'Runs the store.');
wwv_flow_imp_shared.create_acl_role(p_id=>wwv_flow_imp.id(802),p_static_id=>'READER',p_name=>'Reader');
wwv_flow_imp_shared.create_security_scheme(p_id=>wwv_flow_imp.id(811),p_name=>'Administration Rights',p_scheme_type=>'NATIVE_IS_IN_GROUP',p_attributes=>wwv_flow_t_plugin_attributes(wwv_flow_t_varchar2('name', 'Administrator', 'type', 'A')).to_clob,p_error_message=>'Administrators only');
wwv_flow_imp_shared.create_app_setting(p_id=>wwv_flow_imp.id(821),p_name=>'ACCESS_CONTROL_SCOPE',p_value=>'ALL_USERS',p_valid_values=>'ACL_ONLY, ALL_USERS');
wwv_flow_imp_shared.create_list_of_values(p_id=>wwv_flow_imp.id(831),p_lov_name=>'CATEGORIES',p_lov_query=>'select name d, code r from category',p_source_type=>'LEGACY_SQL');
wwv_flow_imp_shared.create_menu(p_id=>wwv_flow_imp.id(841),p_name=>'Breadcrumb');
wwv_flow_imp_shared.create_menu_option(p_id=>wwv_flow_imp.id(842),p_short_name=>'Home',p_link=>'f?p=&APP_ID.:1:&APP_SESSION.::&DEBUG.:::',p_page_id=>1);
wwv_flow_imp_shared.create_menu_option(p_id=>wwv_flow_imp.id(843),p_parent_id=>wwv_flow_imp.id(842),p_short_name=>'Price list',p_link=>'f?p=&APP_ID.:2:&APP_SESSION.::&DEBUG.:::',p_page_id=>2);
wwv_flow_imp_shared.create_menu_option(p_id=>wwv_flow_imp.id(844),p_parent_id=>wwv_flow_imp.id(843),p_short_name=>'Figures',p_link=>'f?p=&APP_ID.:3:&APP_SESSION.::&DEBUG.:::',p_page_id=>3);
wwv_flow_imp_shared.create_menu_option(p_id=>wwv_flow_imp.id(845),p_parent_id=>wwv_flow_imp.id(842),p_short_name=>'Help',p_link=>'https://example.com/help');
wwv_flow_imp_page.create_page(p_id=>1,p_name=>'Home',p_page_is_public_y_n=>'Y');
wwv_flow_imp_page.create_page_plug(p_id=>wwv_flow_imp.id(1000),p_plug_name=>'Trail',p_plug_display_sequence=>5,p_plug_source_type=>'NATIVE_BREADCRUMB',p_menu_id=>wwv_flow_imp.id(841));
wwv_flow_imp_page.create_page_plug(p_id=>wwv_flow_imp.id(1001),p_plug_name=>'Products',p_plug_display_sequence=>10,p_query_type=>'TABLE',p_query_table=>'PRODUCT',p_plug_source_type=>'NATIVE_IR');
wwv_flow_imp_page.create_worksheet(p_id=>wwv_flow_imp.id(1002),p_show_detail_link=>'N');
wwv_flow_imp_page.create_worksheet_column(p_id=>wwv_flow_imp.id(1003),p_db_column_name=>'ID',p_display_order=>1,p_column_identifier=>'A',p_column_label=>'Id',p_display_text_as=>'HIDDEN_ESCAPE_SC');
wwv_flow_imp_page.create_worksheet_column(p_id=>wwv_flow_imp.id(1004),p_db_column_name=>'NAME',p_display_order=>2,p_column_identifier=>'B',p_column_label=>'Product');
wwv_flow_imp_page.create_worksheet_column(p_id=>wwv_flow_imp.id(1005),p_db_column_name=>'PRICE',p_display_order=>3,p_column_identifier=>'C',p_column_label=>'Price');
wwv_flow_imp_page.create_worksheet_column(p_id=>wwv_flow_imp.id(1006),p_db_column_name=>'CATEGORY',p_display_order=>4,p_column_identifier=>'D',p_column_label=>'Category',p_display_text_as=>'LOV_ESCAPE_SC',p_rpt_named_lov=>wwv_flow_imp.id(831));
wwv_flow_imp_page.create_worksheet_rpt(p_id=>wwv_flow_imp.id(1010),p_application_user=>'APXWS_DEFAULT',p_is_default=>'Y',p_status=>'PUBLIC',p_report_columns=>'NAME:PRICE:CATEGORY');
wwv_flow_imp_page.create_worksheet_rpt(p_id=>wwv_flow_imp.id(1011),p_application_user=>'APXWS_ALTERNATIVE',p_name=>'Cheap things',p_status=>'PUBLIC',p_report_columns=>'NAME:PRICE',p_sort_column_1=>'PRICE',p_sort_direction_1=>'DESC',p_display_rows=>25);
wwv_flow_imp_page.create_worksheet_condition(p_id=>wwv_flow_imp.id(1012),p_report_id=>wwv_flow_imp.id(1011),p_condition_type=>'FILTER',p_column_name=>'PRICE',p_operator=>'<',p_expr=>'50',p_enabled=>'Y');
wwv_flow_imp_page.create_worksheet_condition(p_id=>wwv_flow_imp.id(1013),p_report_id=>wwv_flow_imp.id(1011),p_condition_type=>'HIGHLIGHT',p_condition_name=>'Rakes',p_column_name=>'NAME',p_operator=>'=',p_expr=>'Rake',p_row_bg_color=>'#99FF99',p_enabled=>'Y');
wwv_flow_imp_page.create_worksheet_condition(p_id=>wwv_flow_imp.id(1014),p_report_id=>wwv_flow_imp.id(1011),p_condition_type=>'FILTER',p_column_name=>'NAME',p_operator=>'regexp_like',p_expr=>'^R',p_enabled=>'Y');
wwv_flow_imp_page.create_worksheet_computation(p_id=>wwv_flow_imp.id(1015),p_report_id=>wwv_flow_imp.id(1011),p_db_column_name=>'APXWS_CC_001',p_column_identifier=>'E',p_computation_expr=>'C * 2',p_column_label=>'Double price');
wwv_flow_imp_page.create_worksheet_rpt(p_id=>wwv_flow_imp.id(1016),p_application_user=>'ALICE',p_name=>'Mine',p_status=>'PRIVATE',p_report_columns=>'NAME');
wwv_flow_imp_page.create_worksheet_rpt(p_id=>wwv_flow_imp.id(1017),p_application_user=>'not a user!',p_name=>'Lost',p_status=>'PRIVATE',p_report_columns=>'NAME');
wwv_flow_imp_page.create_report_region(p_id=>wwv_flow_imp.id(1020),p_name=>'Sizes',p_display_sequence=>20,p_source=>'select id, sz from product_size',p_source_type=>'NATIVE_SQL_REPORT');
wwv_flow_imp_page.create_report_columns(p_id=>wwv_flow_imp.id(1021),p_query_column_id=>1,p_column_alias=>'ID',p_column_display_sequence=>1);
wwv_flow_imp_page.create_report_columns(p_id=>wwv_flow_imp.id(1022),p_query_column_id=>2,p_column_alias=>'SZ',p_column_display_sequence=>2,p_column_heading=>'Size',p_display_as=>'TEXT_FROM_LOV_ESC',p_inline_lov=>'STATIC:Small;S,Large;L');
wwv_flow_imp_page.create_page(p_id=>2,p_name=>'Price list',p_page_is_public_y_n=>'Y');
wwv_flow_imp_page.create_page_plug(p_id=>wwv_flow_imp.id(2001),p_plug_name=>'Price list',p_plug_display_sequence=>10,p_query_type=>'TABLE',p_query_table=>'PRODUCT',p_plug_source_type=>'NATIVE_IG');
wwv_flow_imp_page.create_region_column(p_id=>wwv_flow_imp.id(2002),p_name=>'ID',p_source_type=>'DB_COLUMN',p_source_expression=>'ID',p_item_type=>'NATIVE_HIDDEN',p_display_sequence=>10,p_is_primary_key=>true);
wwv_flow_imp_page.create_region_column(p_id=>wwv_flow_imp.id(2003),p_name=>'NAME',p_source_type=>'DB_COLUMN',p_source_expression=>'NAME',p_item_type=>'NATIVE_TEXT_FIELD',p_heading=>'Product',p_display_sequence=>20);
wwv_flow_imp_page.create_region_column(p_id=>wwv_flow_imp.id(2004),p_name=>'PRICE',p_source_type=>'DB_COLUMN',p_source_expression=>'PRICE',p_item_type=>'NATIVE_NUMBER_FIELD',p_heading=>'Price',p_display_sequence=>30);
wwv_flow_imp_page.create_interactive_grid(p_id=>wwv_flow_imp.id(2010),p_is_editable=>true,p_edit_operations=>'i:u:d');
wwv_flow_imp_page.create_page_validation(p_id=>wwv_flow_imp.id(2020),p_tabular_form_region_id=>wwv_flow_imp.id(2001),p_validation_name=>'Name required',p_validation_sequence=>10,p_validation=>'NAME',p_validation_type=>'ITEM_NOT_NULL',p_error_message=>'#COLUMN_HEADER# must have a value.',p_associated_column=>'NAME');
wwv_flow_imp_page.create_page_validation(p_id=>wwv_flow_imp.id(2021),p_tabular_form_region_id=>wwv_flow_imp.id(2001),p_validation_name=>'Price positive',p_validation_sequence=>20,p_validation=>':PRICE >= 0',p_validation_type=>'SQL_EXPRESSION',p_error_message=>'The price cannot be negative.',p_associated_column=>'PRICE');
wwv_flow_imp_page.create_page_validation(p_id=>wwv_flow_imp.id(2022),p_tabular_form_region_id=>wwv_flow_imp.id(2001),p_validation_name=>'Name letters',p_validation_sequence=>30,p_validation=>'NAME',p_validation2=>'^[A-Za-z ]+$',p_validation_type=>'REGULAR_EXPRESSION',p_error_message=>'Letters only.',p_associated_column=>'NAME');
wwv_flow_imp_page.create_page_validation(p_id=>wwv_flow_imp.id(2023),p_tabular_form_region_id=>wwv_flow_imp.id(2001),p_validation_name=>'Real PL/SQL',p_validation_sequence=>40,p_validation=>'begin return true; end;',p_validation_type=>'FUNC_BODY_RETURNING_BOOLEAN',p_error_message=>'No.',p_associated_column=>'PRICE');
wwv_flow_imp_page.create_page_process(p_id=>wwv_flow_imp.id(2030),p_process_sequence=>10,p_region_id=>wwv_flow_imp.id(2001),p_process_type=>'NATIVE_IG_DML',p_process_name=>'Save');
wwv_flow_imp_page.create_page(p_id=>3,p_name=>'Figures',p_page_is_public_y_n=>'Y');
wwv_flow_imp_page.create_page_plug(p_id=>wwv_flow_imp.id(3001),p_plug_name=>'Revenue',p_plug_display_sequence=>10,p_query_type=>'TABLE',p_query_table=>'PRODUCT',p_plug_source_type=>'NATIVE_JET_CHART');
wwv_flow_imp_page.create_jet_chart(p_id=>wwv_flow_imp.id(3002),p_region_id=>wwv_flow_imp.id(3001),p_chart_type=>'bar');
wwv_flow_imp_page.create_jet_chart_series(p_id=>wwv_flow_imp.id(3003),p_chart_id=>wwv_flow_imp.id(3002),p_seq=>10,p_name=>'Price',p_data_source_type=>'REGION_SOURCE',p_items_value_column_name=>'PRICE',p_items_label_column_name=>'NAME');
wwv_flow_imp_page.create_jet_chart_axis(p_id=>wwv_flow_imp.id(3004),p_chart_id=>wwv_flow_imp.id(3002),p_axis=>'x',p_is_rendered=>'on',p_title=>'Product');
wwv_flow_imp_page.create_jet_chart_axis(p_id=>wwv_flow_imp.id(3005),p_chart_id=>wwv_flow_imp.id(3002),p_axis=>'y',p_is_rendered=>'on',p_format_type=>'decimal',p_decimal_places=>2,p_scaling=>'log',p_min=>0,p_max=>200);
wwv_flow_imp_page.create_jet_chart_axis(p_id=>wwv_flow_imp.id(3006),p_chart_id=>wwv_flow_imp.id(3002),p_axis=>'y2',p_is_rendered=>'on');
wwv_flow_imp_page.create_page_plug(p_id=>wwv_flow_imp.id(3010),p_plug_name=>'Stock',p_plug_display_sequence=>20,p_query_type=>'SQL',p_plug_source=>'select ''Stock'' label, 42 value from dual',p_plug_source_type=>'NATIVE_JET_CHART');
wwv_flow_imp_page.create_jet_chart(p_id=>wwv_flow_imp.id(3011),p_region_id=>wwv_flow_imp.id(3010),p_chart_type=>'dial',p_value_min=>0,p_value_max=>100);
wwv_flow_imp_page.create_jet_chart_series(p_id=>wwv_flow_imp.id(3012),p_chart_id=>wwv_flow_imp.id(3011),p_seq=>10,p_name=>'Stock',p_data_source_type=>'REGION_SOURCE',p_items_value_column_name=>'VALUE',p_items_label_column_name=>'LABEL');
wwv_flow_imp_page.create_jet_chart_axis(p_id=>wwv_flow_imp.id(3013),p_chart_id=>wwv_flow_imp.id(3011),p_axis=>'y',p_format_type=>'currency');
wwv_flow_imp_page.create_page_plug(p_id=>wwv_flow_imp.id(3020),p_plug_name=>'Count',p_plug_display_sequence=>30,p_function_body_language=>'PLSQL',p_plug_source=>'begin'||wwv_flow.LF||'  return ''<p class="lead">Products: '' || (select count(*) from product) || ''</p>'';'||wwv_flow.LF||'end;',p_plug_source_type=>'NATIVE_DYNAMIC_CONTENT');
wwv_flow_imp_page.create_page_plug(p_id=>wwv_flow_imp.id(3021),p_plug_name=>'Printed',p_plug_display_sequence=>40,p_plug_source=>'htp.p(''<p>Cheapest: '');'||wwv_flow.LF||'sys.htp.prn((select min(price) from product));'||wwv_flow.LF||'htp.p(''</p>'');',p_plug_source_type=>'NATIVE_PLSQL');
wwv_flow_imp_page.create_page_plug(p_id=>wwv_flow_imp.id(3022),p_plug_name=>'Looped',p_plug_display_sequence=>50,p_plug_source=>'begin for r in (select name from product) loop htp.p(r.name); end loop; end;',p_plug_source_type=>'NATIVE_PLSQL');
end;
/
`;
  const ALIAS = 'apex211-store';
  let doc: any;
  let report: any;
  let savedReports: any[];
  before(async () => {
    ({ doc, report, savedReports } = apexToDoc(STORE, { alias: ALIAS, dbRole: 'hr_app', schema: 'apex211' } as any) as any);
    await owner.query(`delete from meta.app where alias = $1`, [ALIAS]);
    await owner.query('drop schema if exists apex211 cascade');
    await owner.query(`create schema apex211;
      create table apex211.category (code text primary key, name text not null);
      create table apex211.product (id int primary key, name text not null, price numeric(10,2), category text references apex211.category);
      create table apex211.product_size (id int primary key, sz text);
      insert into apex211.category values ('T', 'Tools'), ('G', 'Garden');
      insert into apex211.product values (1, 'Hammer', 12.5, 'T'), (2, 'Rake', 7.25, 'G'), (3, 'Anvil', 99, 'T'), (4, 'Spade', 30, 'G');
      insert into apex211.product_size values (1, 'S'), (2, 'L');
      grant usage on schema apex211 to hr_app;
      grant select, insert, update, delete on all tables in schema apex211 to hr_app`);
  });
  after(async () => {
    await owner.query(`delete from meta.app where alias = $1`, [ALIAS]);
    await owner.query('drop schema if exists apex211 cascade');
  });
  const entry = (kind: string, name: string) => report.entries.find((e: any) => e.kind === kind && e.name === name);
  const region = (t: string) => doc.pages.flatMap((p: any) => p.regions).find((r: any) => r.title === t);

  test('saved interactive reports: public and private, filters, highlights, sort, columns, computations', () => {
    assert.equal(savedReports.length, 2, 'the default report is the region itself; a report without a usable owner is left out');
    const cheap = savedReports.find((s) => s.name === 'Cheap things');
    assert.deepEqual({ ...cheap, params: undefined }, { page: 1, region: 'products', name: 'Cheap things', public: true, username: null, params: undefined });
    assert.deepEqual(cheap.params, [['c', 'Double price|price * 2'], ['x', 'category'], ['s', '3'], ['d', 'desc'], ['n', '25'],
      ['f', 'price|lt|50'], ['h', 'name|eq|green|Rake']]);
    assert.match(entry('saved_report', 'Products: Cheap things').notes.join('\n'), /filter NAME \(regexp_like\) is not carried over/);
    const mine = savedReports.find((s) => s.name === 'Mine');
    assert.equal(mine.username, 'alice');
    assert.equal(mine.public, false);
    assert.equal(entry('saved_report', 'Products: Lost').status, 'not_mapped');
  });

  test('report columns with a list of values show its display value (shared and static)', () => {
    assert.ok(region('Products').source.includes(`(select l.d from (select name d, code r from apex211.category) l(d, r) where l.r::text = q."category"::text limit 1) as "category"`));
    const sizes = region('Sizes');
    assert.equal(sizes.source, `select q."id",\n       (select l.d from (select d, r from (values ('Small', 'S', 0), ('Large', 'L', 1)) v(d, r, n)) l(d, r) where l.r::text = q."sz"::text limit 1) as "sz"\n  from (select id, sz from apex211.product_size) q`);
  });

  test('interactive grid column validations become the grid columns\' validations', () => {
    const cols = region('Price list').config.columns;
    assert.equal(cols.name.validation, "(nullif(:NAME, '') is not null) and (:NAME is null or :NAME ~ '^[A-Za-z ]+$')");
    assert.equal(cols.name.validation_message, 'Product must have a value.');
    assert.equal(cols.price.validation, ':PRICE >= 0');
    assert.equal(cols.price.validation_message, 'The price cannot be negative.');
    assert.equal(entry('validation', 'Real PL/SQL').status, 'not_mapped');
    assert.match(entry('validation', 'Name letters').notes.join('\n'), /more than one validation/);
  });

  test('breadcrumbs: the entries set the pages\' breadcrumb parents', () => {
    const parent = (n: number) => doc.pages.find((p: any) => p.page_no === n).parent_page;
    assert.equal(parent(1), null);
    assert.equal(parent(2), 1);
    assert.equal(parent(3), 2);
    assert.equal(entry('breadcrumb', 'Help').status, 'not_mapped');
    assert.match(entry('breadcrumb', 'Price list').target, /page 2 → parent 1/);
    assert.equal(region('Trail').position, 'breadcrumb');
  });

  test('chart axes: the value axis\' format, a gauge\'s range; the rest is noted', () => {
    const revenue = region('Revenue');
    assert.equal(revenue.config.format_mask, 'FM999G999G999G990D00');
    const notes = entry('region', 'Revenue').notes.join('\n');
    assert.match(notes, /second value axis \(y2\) is not carried over/);
    assert.match(notes, /the label axis's title "Product"/);
    assert.match(notes, /the value axis's log scale/);
    assert.match(notes, /fixed range \(0 to 200\)/);
    const stock = region('Stock');
    assert.equal(stock.config.kind, 'gauge');
    assert.deepEqual(stock.config.gauge, { min: 0, max: 100 });
    assert.equal(stock.config.format_mask, 'FML999G999G999G990D00');
  });

  test('ACL roles become the roles the authorization schemes check; ALL_USERS lets every user in', () => {
    assert.deepEqual(doc.authz_schemes.find((s: any) => s.name === 'ADMINISTRATION_RIGHTS'), { name: 'ADMINISTRATION_RIGHTS', type: 'role', value: 'administrator', error_message: 'Administrators only' });
    assert.equal(entry('acl_role', 'Administrator').target, 'role administrator');
    assert.match(entry('acl_role', 'Administrator').notes.join('\n'), /checked by the authorization scheme ADMINISTRATION_RIGHTS/);
    assert.match(entry('acl_role', 'Reader').notes.join('\n'), /no authorization scheme checks it/);
    assert.equal(doc.app.access_control, 'any_user');
  });

  test('dynamic content: a return or htp.p calls become a dynamic region; real PL/SQL stays to port', () => {
    const count = region('Count');
    assert.equal(count.type, 'dynamic');
    assert.equal(count.source, `select '<p class="lead">Products: ' || (select count(*) from apex211.product) || '</p>'`);
    const printed = region('Printed');
    assert.equal(printed.type, 'dynamic');
    assert.equal(printed.source, `select ('<p>Cheapest: ') || chr(10)\n    || ((select min(price) from apex211.product))\n    || ('</p>') || chr(10)`);
    const looped = region('Looped');
    assert.equal(looped.type, 'static');
    assert.equal(entry('region', 'Looped').status, 'not_mapped');
    assert.ok(entry('region', 'Looped').port);
  });

  test('imported, it runs: saved reports written, display values, breadcrumb, dynamic content', async () => {
    await owner.query('select meta.import_app($1::jsonb, $2)', [JSON.stringify(doc), ALIAS]);
    const appId = (await owner.one<{ id: number }>('select id from meta.app where alias = $1', [ALIAS]))!.id;
    const { apexSavedReports } = await import('../src/apex-saved-reports.ts');
    assert.equal(await apexSavedReports(owner, savedReports, { appId, owner: 'Developer' }), 2);
    const rows = (await owner.query(`select username, name, public, params from meta.saved_report where app_id = $1 order by name`, [appId])).rows;
    assert.deepEqual(rows.map((r: any) => [r.username, r.name, r.public]), [['developer', 'Cheap things', true], ['alice', 'Mine', false]]);
    assert.equal(await apexSavedReports(owner, savedReports, { appId, owner: 'developer' }), 0, 'a second run adds nothing');
    const b = new Browser(app);
    const p1 = await b.get(`/a/${ALIAS}/1`);
    assert.equal(p1.statusCode, 200);
    assert.ok(p1.body.includes('Tools') && p1.body.includes('Garden'), 'the category column shows its display value');
    assert.ok(p1.body.includes('Small') && p1.body.includes('Large'), 'a static list of values too');
    // the saved report's parameters, as the runtime reads them
    const cheapPage = (await b.get(`/a/${ALIAS}/1?${rows.find((r: any) => r.name === 'Cheap things').params}`)).body;
    // the rows' text (a highlight names its value in the table's markup too)
    const cheap = cheapPage.slice(cheapPage.indexOf('<table')).replace(/<[^>]*>/g, ' ');
    assert.ok(cheap.includes('Rake') && cheap.includes('Spade') && !cheap.includes('Anvil'), 'the filter price < 50');
    assert.match(cheap, /Double Price[\s\S]*Spade\s+30\.00\s+60\.00/, 'the computed column');
    assert.ok(cheap.indexOf('Spade') < cheap.indexOf('Hammer') && cheap.indexOf('Hammer') < cheap.indexOf('Rake'), 'sorted by price, descending');
    const p3 = await b.get(`/a/${ALIAS}/3`);
    assert.equal(p3.statusCode, 200);
    assert.match(p3.body, /<p class="lead">Products: 4<\/p>/);
    assert.match(p3.body, /Cheapest: \s*7\.25/);
    assert.match(p3.body, /href="[^"]*\/a\/apex211-store\/2[^"]*"[^>]*>Price list</, 'the breadcrumb leads to the parent pages');
  });
});
