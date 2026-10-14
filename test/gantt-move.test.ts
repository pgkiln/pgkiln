// Sprint 69: dragging tasks on a Gantt chart (HR page 32, part 59). The
// editable chart's markup, the move route (dates, the task's visibility, who
// may drag), the SQL with :TASK_ID, :NEW_START and :NEW_END, and the chart
// sent back.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import '../src/env.ts';
import { buildApp } from '../src/app.ts';
import { closePools, owner } from '../src/db.ts';
import { targetTime } from '../src/runtime/gantt-move.ts';
import { renderChartBody } from '../src/runtime/charts.ts';
import { PageCss } from '../src/css.ts';
import { Browser } from './helpers.ts';

let app: FastifyInstance;
let rid: number;
let saved: { id: number; starts: string; ends: string | null }[];

before(async () => {
  app = await buildApp({ logger: false });
  rid = (await owner.one(`select r.id from meta.region r join meta.page p on p.id = r.page_id join meta.app a on a.id = p.app_id
                           where a.alias = 'hr' and p.page_no = 32 and r.title = 'Office move'`)).id;
  saved = (await owner.query(`select id, starts::text, ends::text from hr.project_task order by id`)).rows;
});

after(async () => {
  for (const t of saved) await owner.query('update hr.project_task set starts = $2, ends = $3 where id = $1', [t.id, t.starts, t.ends]);
  await app.close();
  await closePools();
});

async function as(user: string) {
  const b = new Browser(app);
  await b.login(user);
  await b.get('/a/hr/32');
  return b;
}
const move = (b: Browser, form: Record<string, string>) => b.post(`/a/hr/32/chart/${rid}/move`, { __csrf: b.lastCsrf, ...form });
const task = async (id: number) => (await owner.one('select starts::text, ends::text from hr.project_task where id = $1', [id]));

describe('gantt drag and drop', () => {
  test('target dates: a day or an hour, real dates only', () => {
    assert.equal(targetTime('2026-10-14'), Date.UTC(2026, 9, 14));
    assert.equal(targetTime('2026-10-14T09:30'), Date.UTC(2026, 9, 14, 9, 30));
    for (const bad of ['2026-02-30', '2026-13-01', '2026-10-14 09:30', '2026-10-14T25:00', '1800-01-01', "2026-10-14'; drop table x", '', '2026-10-14T09:30:00'])
      assert.ok(Number.isNaN(targetTime(bad)), bad);
  });

  test('an editable chart marks its tasks; without a task_id or for others it is a plain chart', async () => {
    const page = (await (await as('king')).get('/a/hr/32')).body;
    assert.match(page, new RegExp(`<div class="gantt gantt-editable" data-gantt="${rid}" data-snap="day" data-lo="\\d+" data-hi="\\d+">`));
    assert.match(page, /data-task="3" data-label="Plan the floor layout" data-start="\d+" data-end="\d+"/);
    assert.match(page, /<span class="gantt-handle" aria-hidden="true"><\/span>/);
    assert.match(page, /Drag a task to move it/);
    // the leave chart on the same page has no gantt_move
    assert.equal((page.match(/gantt-editable/g) ?? []).length, 1);
    const scott = (await (await as('scott')).get('/a/hr/32')).body;
    assert.doesNotMatch(scott, /gantt-editable|data-task=/, 'not a manager');
    // hours when a task has a time; a chart without task_id is never editable
    const css = new PageCss();
    const fields = [{ name: 'Task' }, { name: 'From' }, { name: 'To' }, { name: 'task_id' }];
    const hours = renderChartBody('gantt', 'x', [['A', '2026-10-14 09:00', '2026-10-14 17:30', 1]], fields, css, 'en', undefined, { edit: { region: 1 } }).toString();
    assert.match(hours, /data-snap="hour"/);
    const none = renderChartBody('gantt', 'x', [['A', '2026-10-14', '2026-10-16']], fields.slice(0, 3), css, 'en', undefined, { edit: { region: 1 } }).toString();
    assert.doesNotMatch(none, /gantt-editable/);
  });

  test('a manager moves a task and changes an end; the chart comes back with the new dates', async () => {
    const b = await as('blake');
    const res = await move(b, { task: '4', start: '2030-01-07', end: '2030-01-18' });
    assert.equal(res.statusCode, 200, res.body);
    const json = JSON.parse(res.body);
    assert.equal(json.message, 'Order furniture: 2030-01-07 – 2030-01-18.');
    assert.match(json.region, new RegExp(`data-task="4" data-label="Order furniture" data-start="${Date.UTC(2030, 0, 7)}" data-end="${Date.UTC(2030, 0, 18)}"`));
    assert.deepEqual(await task(4), { starts: '2030-01-07', ends: '2030-01-18' });
    // a milestone (no end) keeps none
    await move(b, { task: '7', start: '2030-02-01', end: '2030-02-01' });
    assert.deepEqual(await task(7), { starts: '2030-02-01', ends: null });
  });

  test('refused: an end before the start, a bad date, an unknown task, no CSRF token, users who may not drag', async () => {
    const b = await as('jones');
    const before = await task(5);
    for (const [form, code] of [
      [{ task: '5', start: '2030-03-10', end: '2030-03-09' }, 400],
      [{ task: '5', start: '2030-02-30', end: '2030-03-09' }, 400],
      [{ task: '5', start: "2030-03-10'::date; delete from hr.project_task; --", end: '2030-03-11' }, 400],
      [{ task: '999', start: '2030-03-10', end: '2030-03-11' }, 403],
      [{ task: "5' or '1'='1", start: '2030-03-10', end: '2030-03-11' }, 403],
    ] as const) {
      const res = await move(b, form);
      assert.equal(res.statusCode, code, JSON.stringify(form));
    }
    assert.equal((await b.post(`/a/hr/32/chart/${rid}/move`, { task: '5', start: '2030-03-10', end: '2030-03-11' })).statusCode, 403, 'no CSRF token');
    const scott = await as('scott');
    const res = await move(scott, { task: '5', start: '2030-03-10', end: '2030-03-11' });
    assert.equal(res.statusCode, 403);
    assert.match(JSON.parse(res.body).error, /can't be moved/);
    // the leave chart: no gantt_move
    const leave = (await owner.one(`select r.id from meta.region r join meta.page p on p.id = r.page_id join meta.app a on a.id = p.app_id where a.alias = 'hr' and p.page_no = 32 and r.title = 'Leave on the calendar'`)).id;
    assert.equal((await b.post(`/a/hr/32/chart/${leave}/move`, { __csrf: b.lastCsrf, task: '1', start: '2030-03-10', end: '2030-03-11' })).statusCode, 403);
    assert.deepEqual(await task(5), before);
    assert.equal(await owner.one(`select 1 as ok from hr.project_task where id = 1 and starts = '2030-03-10'`), undefined);
  });

  test('the builder saves the drag settings with the chart\'s', async () => {
    const { mergeChartSettings } = await import('../src/builder/region-settings.ts');
    const out = mergeChartSettings({ kind: 'gantt' }, { kind: 'gantt', gantt_move: ' update x set a = 1 ', gantt_move_authz: 'manager', gantt_snap: 'hour' }, { pages: new Set(), authz: new Set(['MANAGER']) } as never);
    assert.deepEqual(out, { kind: 'gantt', gantt_move: 'update x set a = 1', gantt_move_authz: 'MANAGER', gantt_snap: 'hour' });
    const unknown = mergeChartSettings({}, { kind: 'gantt', gantt_move_authz: 'NOPE', gantt_snap: 'minute' }, { pages: new Set(), authz: new Set(['MANAGER']) } as never);
    assert.deepEqual(unknown, { kind: 'gantt' });
  });
});
