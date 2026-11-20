// (sprint 237, MG-3) A document template's PDF from SQL and in a send_email process: meta.document_pdf gives
// a reference the server draws when the process ends, in place in the mail attachment; {"document": …}
// attachments of send_email are drawn directly. Every PDF is asserted as real bytes (%PDF-, its text).
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { mailTick } from '../src/mail/mail.ts';
import { sendEmailProblems } from '../src/runtime/processes.ts';
import { Browser, pdfText } from './helpers.ts';

let app: FastifyInstance;
let appId: number;
let page3: number;
const made: { processes: number[]; buttons: number[] } = { processes: [], buttons: [] };

/** (sprint 237) HR sends through a "log only" service of the test's own (another test file may have removed HR's). */
async function useLogService(appId: number, name: string) {
  // (sprint 236) an application may link several services: keep them all, send only through this one meanwhile
  const before = (await owner.query('select service_id, from_address, max_per_day, is_default from meta.app_mail_service where app_id = $1 order by is_default desc', [appId])).rows;
  await owner.query('delete from meta.mail_service where name = $1', [name]);
  const sid = (await owner.one(`insert into meta.mail_service (name, provider, senders, settings) values ($1, 'log', '{@example.com}', '{"default_from": "hr@example.com"}') returning id`, [name])).id;
  await owner.query('delete from meta.app_mail_service where app_id = $1', [appId]);
  await owner.query(`insert into meta.app_mail_service (app_id, service_id, from_address, is_default) values ($1, $2, 'hr@example.com', true)`, [appId, sid]);
  return async () => {
    await owner.query('delete from meta.mail_service where name = $1', [name]);
    await owner.query('delete from meta.app_mail_service where app_id = $1', [appId]);
    for (const r of before)
      await owner.query('insert into meta.app_mail_service (app_id, service_id, from_address, max_per_day, is_default) values ($1, $2, $3, $4, $5)',
        [appId, r.service_id, r.from_address, r.max_per_day, r.is_default]);
  };
}

let restoreMail: () => Promise<void>;
const words = (pdf: Buffer) => pdfText(pdf).replace(/\s+/g, ' ');

before(async () => {
  app = await buildApp({ logger: false });
  appId = (await owner.one(`select id from meta.app where alias = 'hr'`)).id;
  page3 = (await owner.one('select id from meta.page where app_id = $1 and page_no = 3', [appId])).id;
  restoreMail = await useLogService(appId, 'T237_LOG');
});

beforeEach(async () => {
  await owner.query(`update meta.mail_queue set status = 'cancelled' where app_id = $1 and status = 'queued'`, [appId]);
});

after(async () => {
  for (const id of made.processes) await owner.query('delete from meta.process where id = $1', [id]);
  for (const id of made.buttons) await owner.query('delete from meta.button where id = $1', [id]);
  await owner.query(`delete from meta.mail_queue where app_id = $1 and subject like 'T237 %'`, [appId]);
  await restoreMail();
  await app.close();
  await closePools();
});

/** A submit button on the employee form and a process it runs. */
async function processOn3(name: string, type: string, code: string | null, config: unknown = {}) {
  const button = (await owner.one(
    `insert into meta.button (page_id, region_id, seq, name, label, action)
     select $1, r.id, 900 + (select count(*) from meta.button where page_id = $1), $2, $2, 'submit' from meta.region r where r.page_id = $1 and r.type = 'form' returning id`,
    [page3, name])).id;
  made.buttons.push(button);
  const proc = (await owner.one(
    `insert into meta.process (page_id, seq, name, type, point, when_button, code, config) values ($1, 900, $2, $3, 'submit', $2, $4, $5) returning id`,
    [page3, name, type, code, JSON.stringify(config)])).id;
  made.processes.push(proc);
  return proc;
}

const SCOTT = { P3_ENAME: 'SCOTT', P3_JOB: 'ANALYST', P3_DEPTNO: '20', P3_MGR: '7566', P3_HIREDATE: '1987-04-19', P3_SAL: '3000.00', P3_ACTIVE: 'true', P3_USERNAME: 'scott' };

/** Signed in, on the employee form of 7788 (through the report's checksummed link), then press `button`. */
async function press(button: string, user = 'king') {
  const b = new Browser(app);
  await b.login(user);
  const list = (await b.get('/a/hr/2')).body;
  const href = /href="(\/a\/hr\/3\?[^"]*P3_EMPNO=7788[^"]*)"/.exec(list)![1].replace(/&amp;/g, '&');
  await b.get(href);
  // the form as a browser posts it (P3_EMPNO is in the session state from the checksummed link)
  return b.submit('/a/hr/3', { __request: button, ...SCOTT });
}

const attachmentsOf = async (subject: string) =>
  (await owner.query(
    `select a.filename, a.mime, a.content from meta.mail_attachment a join meta.mail_queue m on m.id = a.mail_id
      where m.app_id = $1 and m.subject = $2 order by a.id`, [appId, subject])).rows as { filename: string; mime: string; content: Buffer }[];

describe('meta.document_pdf', () => {
  test('HR\'s "Mail sheet": the PDF of EMPLOYEE_SHEET is drawn into the mail of a SQL process', async () => {
    const res = await press('MAIL_SHEET');
    assert.equal(res.statusCode, 303, res.body);
    const m = await owner.one(`select * from meta.mail_queue where app_id = $1 and subject = 'Your employee sheet' order by id desc limit 1`, [appId]);
    assert.deepEqual(m.to_addresses, ['scott@example.com']);
    const [a] = (await owner.query('select filename, mime, content from meta.mail_attachment where mail_id = $1', [m.id])).rows;
    assert.equal(a.filename, 'employee-7788.pdf');
    assert.equal(a.mime, 'application/pdf');
    assert.equal(a.content.subarray(0, 5).toString('latin1'), '%PDF-');
    const text = words(a.content);
    assert.match(text, /Scott/);
    assert.match(text, /Analyst/);
    assert.match(text, /by king/);
    await owner.query('delete from meta.mail_queue where id = $1', [m.id]);
  });

  test('from PL/pgSQL, with the data as the process left it; the items win over the session state', async () => {
    await processOn3('T237_PLPGSQL', 'sql', `do $b$
declare
  v_mail bigint;
begin
  update hr.emp set job = 'PRINTER' where empno = 7839;
  v_mail := meta.send_mail('king@example.com', 'T237 plpgsql', 'Attached.');
  perform meta.add_mail_attachment(v_mail, meta.document_pdf('employee_sheet', jsonb_build_object('p3_empno', 7839)), 'king.pdf');
end
$b$`);
    try {
      const res = await press('T237_PLPGSQL');
      assert.equal(res.statusCode, 303, res.body);
      const [a] = await attachmentsOf('T237 plpgsql');
      assert.equal(a.content.subarray(0, 5).toString('latin1'), '%PDF-');
      assert.equal(a.mime, 'application/pdf', 'application/octet-stream becomes application/pdf');
      assert.equal(a.filename, 'king.pdf');
      const text = words(a.content);
      assert.match(text, /King/, 'P3_EMPNO from the items (7839), not the form (7788)');
      assert.match(text, /Printer/, 'the update earlier in the same process is in the PDF');
    } finally {
      await owner.query(`update hr.emp set job = 'PRESIDENT' where empno = 7839`);
    }
  });

  test('a failing template rolls the submit back: nothing is queued', async () => {
    await processOn3('T237_FAIL', 'sql',
      `select meta.add_mail_attachment(meta.send_mail('king@example.com', 'T237 fail', 'x'), meta.document_pdf('EMPLOYEE_SHEET', '{"P3_EMPNO": "not a number"}'), 'x.pdf')`);
    const res = await press('T237_FAIL');
    assert.equal(res.statusCode, 422, 'the page again, with the error');
    assert.match(res.body, /alert-error/);
    assert.equal((await attachmentsOf('T237 fail')).length, 0);
    assert.equal((await owner.query(`select 1 from meta.mail_queue where subject = 'T237 fail'`)).rowCount, 0);
  });

  test('a reference no process drew is never sent: the mail fails with a clear message', async () => {
    const c = await owner.pool.connect();
    let id: string;
    try {
      await c.query('begin');
      await c.query(`select set_config('pgkiln.app_id', $1, true), set_config('pgkiln.app_user', 'KING', true)`, [String(appId)]);
      await c.query('set local role hr_app');
      id = (await c.query(`select meta.send_mail('king@example.com', 'T237 undrawn', 'x') as id`)).rows[0].id;
      await c.query(`select meta.add_mail_attachment($1, meta.document_pdf('EMPLOYEE_SHEET', '{"P3_EMPNO": 7788}'), 'x.pdf')`, [id]);
      await c.query('commit');
    } finally {
      c.release();
    }
    await mailTick();
    const m = await owner.one('select status, message from meta.mail_queue where id = $1', [id]);
    assert.equal(m.status, 'error');
    assert.match(m.message, /meta\.document_pdf\) was not drawn/);
  });
});

describe('send_email with a document attachment', () => {
  test('{"document": …} attaches the template\'s PDF with &ITEM. values, next to a query\'s attachments', async () => {
    await processOn3('T237_SEND', 'send_email', null, {
      to: 'king@example.com', subject: 'T237 send', body: 'Attached.',
      attachments: [
        { document: 'EMPLOYEE_SHEET', items: { P3_EMPNO: '&P3_EMPNO.' } },
        { document: 'employee_sheet', items: { P3_EMPNO: '7839' }, filename: 'sheet-of-&APP_USER.' },
        `select convert_to('x', 'UTF8') as content, 'note.txt' as filename, 'text/plain' as mime`,
      ],
    });
    const res = await press('T237_SEND');
    assert.equal(res.statusCode, 303, res.body);
    const [first, second, note] = await attachmentsOf('T237 send');
    assert.equal(first.filename, 'employee-7788.pdf', 'the template\'s file name');
    assert.equal(first.mime, 'application/pdf');
    assert.equal(first.content.subarray(0, 5).toString('latin1'), '%PDF-');
    assert.match(words(first.content), /Scott/);
    assert.equal(second.filename, 'sheet-of-king.pdf');
    assert.match(words(second.content), /King/);
    assert.equal(note.filename, 'note.txt');
  });

  test('the configuration is checked', () => {
    const base = { to: 'a@example.com', subject: 's', body: 'b' };
    assert.deepEqual(sendEmailProblems({ ...base, attachments: { document: 'INVOICE', items: { P5_ID: '&P5_ID.' }, filename: 'x' } }), []);
    assert.deepEqual(sendEmailProblems({ ...base, attachments: ['select 1', { document: 'INVOICE' }] }), []);
    assert.match(sendEmailProblems({ ...base, attachments: { document: 'no such; name' } }).join(' '), /name of a document template/);
    assert.match(sendEmailProblems({ ...base, attachments: { document: 'X', items: { P1: 1 } } }).join(' '), /"items" of a document attachment/);
    assert.match(sendEmailProblems({ ...base, attachments: { document: 'X', query: 'select 1' } }).join(' '), /"document", "items" and "filename" only/);
    assert.match(sendEmailProblems({ ...base, attachments: 'delete from x' }).join(' '), /SELECT of content/);
    assert.match(sendEmailProblems({ ...base, attachments: 42 }).join(' '), /SELECT of content/);
  });
});
