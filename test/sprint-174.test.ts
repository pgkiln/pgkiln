// Sprint 174 (parity leftover CD-1): column validations in an interactive grid. A column's SQL expression must be
// true for a row that is added or changed; a row that fails is not saved, and its message shows in the notification
// and in the cell. HR example page 27 (examples/hr/hr_83_grid_validations.sql): salary > 0, commission <= salary.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { mergeGridSettings } from '../src/builder/region-settings.ts';
import { Browser, gridForm } from './helpers.ts';

let app: FastifyInstance;
let king: Browser;
let staffId: number;
let deptsId: number;
let g = '';

before(async () => {
  app = await buildApp({ logger: false });
  king = new Browser(app);
  await king.login('king');
  const rows = (await owner.query(`select r.id, r.title from meta.region r join meta.page p on p.id = r.page_id join meta.app a on a.id = p.app_id where a.alias = 'hr' and p.page_no = 27`)).rows;
  staffId = rows.find((r) => r.title === 'Staff').id;
  deptsId = rows.find((r) => r.title === 'Departments').id;
  g = `g${staffId}`;
  await owner.query(`delete from hr.emp where ename like 'GRIDV%'`);
});
after(async () => {
  await owner.query(`delete from hr.emp where ename like 'GRIDV%'`);
  await app.close();
  await closePools();
});

const sectionOf = (page: string, id: number) => {
  const start = page.indexOf(`id="R${id}"`);
  return page.slice(start, page.indexOf('</section>', start));
};
/** The Staff grid of department 20 (Research), as the page shows it. */
const staffOf20 = async () => {
  const page = (await king.get('/a/hr/27')).body;
  const m = new RegExp(`href="([^"]*r${deptsId}_sel=20&amp;[^"]*)"`).exec(page);
  assert.ok(m, 'the select link of department 20');
  return sectionOf((await king.get(m[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"'))).body, staffId);
};
const rowOf = (form: Record<string, string>, ename: string) => Object.keys(form).find((k) => form[k] === ename)!.replace(/_c\d+$/, '');
const save = (form: Record<string, string>, changes: Record<string, string>) => king.submit('/a/hr/27', { ...form, __request: `GRID_SAVE_${staffId}`, ...changes });
const scott = () => owner.one(`select sal::text, comm::text from hr.emp where ename = 'SCOTT'`);

describe('interactive grid: column validations (CD-1)', () => {
  test('a changed row that fails is not saved: the message in the notification and in the cell, the typed value kept', async () => {
    const before = await scott();
    const form = gridForm(await staffOf20(), g);
    const row = rowOf(form, 'SCOTT');
    const res = await save(form, { [`${row}_c5`]: '0' });
    assert.equal(res.statusCode, 422);
    const n = Number(row.split('_')[1]) + 1;
    assert.match(res.body, new RegExp(`Row ${n}: The salary must be more than zero\\.`));
    const staff = sectionOf(res.body, staffId);
    const cell = new RegExp(`<input type="number"[^>]*name="(${g}_\\d+_c5)" value="0"[^>]*aria-invalid="true" aria-describedby="\\1_error"><small class="error grid-cell-error" id="\\1_error">The salary must be more than zero\\.</small>`);
    assert.match(staff, cell);
    assert.equal((staff.match(/grid-cell-error/g) ?? []).length, 1, 'only that cell');
    assert.deepEqual(await scott(), before);
  });

  test('a validation sees the whole row: what was posted over what the page showed', async () => {
    const before = await scott();
    const form = gridForm(await staffOf20(), g);
    const row = rowOf(form, 'SCOTT');
    // only the commission changes: the salary comes from the row as it was shown
    const res = await save(form, { [`${row}_c6`]: '99999' });
    assert.equal(res.statusCode, 422);
    assert.match(sectionOf(res.body, staffId), new RegExp(`name="${g}_\\d+_c6" value="99999"[^>]*aria-invalid="true"[^>]*><small class="error grid-cell-error"[^>]*>The commission cannot be more than the salary\\.</small>`));
    assert.deepEqual(await scott(), before);
    // both changed and both fine: saved
    try {
      const ok = await save(form, { [`${row}_c5`]: '3100', [`${row}_c6`]: '3100' });
      assert.equal(ok.statusCode, 303, ok.body.match(/alert-error[^<]*<[^<]*/)?.[0] ?? '');
      assert.deepEqual(await scott(), { sal: '3100.00', comm: '3100.00' });
    } finally {
      await owner.query(`update hr.emp set sal = $1, comm = $2 where ename = 'SCOTT'`, [before.sal, before.comm]);
    }
  });

  test('one failing row does not stop the others from being checked; nothing of the save is kept', async () => {
    const form = gridForm(await staffOf20(), g);
    const a = rowOf(form, 'SCOTT');
    const b = rowOf(form, 'ADAMS');
    const before = await owner.one(`select sal::text from hr.emp where ename = 'ADAMS'`);
    const res = await save(form, { [`${a}_c5`]: '-1', [`${b}_c5`]: '1234' });
    assert.equal(res.statusCode, 422);
    assert.deepEqual(await owner.one(`select sal::text from hr.emp where ename = 'ADAMS'`), before, 'the process failed: its other rows are rolled back');
    assert.equal((sectionOf(res.body, staffId).match(/grid-cell-error/g) ?? []).length, 1);
  });

  test('a new row: checked before it is inserted, its cells marked; a valid one is added', async () => {
    const form = gridForm(await staffOf20(), g);
    const bad = await save(form, { [`${g}_n0_c1`]: 'GRIDV1', [`${g}_n0_c4`]: '2026-01-02', [`${g}_n0_c5`]: '-5' });
    assert.equal(bad.statusCode, 422);
    assert.match(bad.body, /New row: The salary must be more than zero\./);
    assert.match(sectionOf(bad.body, staffId), new RegExp(`name="${g}_n0_c5" value="-5"[^>]*aria-invalid="true" aria-describedby="${g}_n0_c5_error"><small class="error grid-cell-error" id="${g}_n0_c5_error">`));
    assert.equal(await owner.one(`select 1 as x from hr.emp where ename = 'GRIDV1'`), undefined);
    const ok = await save(form, { [`${g}_n0_c1`]: 'GRIDV2', [`${g}_n0_c4`]: '2026-01-02', [`${g}_n0_c5`]: '100' });
    assert.equal(ok.statusCode, 303, ok.body.match(/alert-error[^<]*<[^<]*/)?.[0] ?? '');
    assert.equal((await owner.one(`select sal::text from hr.emp where ename = 'GRIDV2'`)).sal, '100.00');
  });

  test('a required column that is emptied says so in its cell', async () => {
    const form = gridForm(await staffOf20(), g);
    const row = rowOf(form, 'SCOTT');
    const res = await save(form, { [`${row}_c1`]: '' });
    assert.equal(res.statusCode, 422);
    assert.match(sectionOf(res.body, staffId), new RegExp(`name="${g}_\\d+_c1" value=""[^>]*aria-invalid="true"[^>]*><small class="error grid-cell-error"[^>]*>Required</small>`));
  });

  test('an expression that fails as SQL refuses the row with the error, not the save with a crash', async () => {
    const cfg = (await owner.one('select config from meta.region where id = $1', [staffId])).config;
    await owner.query(`update meta.region set config = jsonb_set(config, '{columns,sal,validation}', '":SAL::numeric > no_such_column"') where id = $1`, [staffId]);
    try {
      const form = gridForm(await staffOf20(), g);
      const res = await save(form, { [`${rowOf(form, 'SCOTT')}_c5`]: '3001' });
      assert.equal(res.statusCode, 422);
      assert.match(sectionOf(res.body, staffId), /grid-cell-error/);
      assert.equal((await scott()).sal, '3000.00');
    } finally {
      await owner.query('update meta.region set config = $2 where id = $1', [staffId, cfg]);
    }
  });
});

describe('the builder\'s grid settings: column validations', () => {
  const allowed = { lovs: new Set<string>(), authz: new Set<string>(), pages: new Set<number>(), items: new Set<string>() } as never;
  const form = { n: '2', col_0: 'sal', shown_0: 'true', col_1: 'comm', shown_1: 'true', allow_insert: 'true', allow_update: 'true', allow_delete: 'true' };

  test('an expression with its message is kept per column; an empty expression removes both; an older form changes nothing', () => {
    const made = mergeGridSettings({}, { ...form, validation_0: ' :SAL::numeric > 0 ', validation_message_0: ' More than zero. ', validation_1: '', validation_message_1: 'left over' }, allowed);
    assert.deepEqual(made.columns, { sal: { validation: ':SAL::numeric > 0', validation_message: 'More than zero.' } });
    const cleared = mergeGridSettings(made, { ...form, validation_0: '', validation_message_0: 'More than zero.', validation_1: '' }, allowed);
    assert.equal(cleared.columns, undefined);
    const untouched = mergeGridSettings(made, form, allowed);
    assert.deepEqual(untouched.columns, made.columns);
  });
});
