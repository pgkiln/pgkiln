// Sprint 101 (Database Actions DA-12): pg_cron schedules without a database (src/cron-schedule.ts).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { cronTimeZone, describeSchedule, formatRun, joinSchedule, nextRuns, parseSchedule, PRESETS, scheduleProblem, splitSchedule } from '../src/cron-schedule.ts';

const runs = (expr: string, after: string, count = 5, tz = 'UTC') => nextRuns(parseSchedule(expr), new Date(after), count, tz).map((d) => d.toISOString());

describe('parseSchedule', () => {
  test('five fields: lists, ranges, steps, names, Sunday as 0 or 7', () => {
    const s = parseSchedule('0,30 9-17/2 1,15 jan-mar mon-fri');
    assert.equal(s.kind, 'cron');
    if (s.kind !== 'cron') return;
    assert.deepEqual([...s.minutes], [0, 30]);
    assert.deepEqual([...s.hours], [9, 11, 13, 15, 17]);
    assert.deepEqual([...s.days], [1, 15]);
    assert.deepEqual([...s.months], [1, 2, 3]);
    assert.deepEqual([...s.weekdays], [1, 2, 3, 4, 5]);
    assert.equal(s.either, true);
    const sun = parseSchedule('0 0 * * 7');
    assert.ok(sun.kind === 'cron' && sun.weekdays.has(0) && !sun.weekdays.has(7));
    const step = parseSchedule('5/20 * * * *');
    assert.ok(step.kind === 'cron' && [...step.minutes].join() === '5,25,45');
    const star = parseSchedule('0 0 */2 * 1');
    assert.ok(star.kind === 'cron' && star.either === false, 'a field starting with * is unrestricted (Vixie cron)');
  });

  test('macros, n seconds, @reboot and $', () => {
    assert.deepEqual(splitSchedule('@daily'), { minute: '0', hour: '0', day: '*', month: '*', weekday: '*' });
    assert.deepEqual(parseSchedule('30 seconds'), { kind: 'seconds', seconds: 30 });
    assert.deepEqual(parseSchedule('1 second'), { kind: 'seconds', seconds: 1 });
    assert.deepEqual(parseSchedule(' @REBOOT '), { kind: 'reboot' });
    const last = parseSchedule('0 23 $ * *');
    assert.ok(last.kind === 'cron' && last.lastDay && last.days.size === 0);
    const both = parseSchedule('0 0 15,$ * *');
    assert.ok(both.kind === 'cron' && both.lastDay && both.days.has(15));
  });

  test('problems are explained', () => {
    const cases: [string, RegExp][] = [
      ['', /Enter a schedule/],
      ['* * * *', /five fields/],
      ['* * * * * *', /five fields/],
      ['60 * * * *', /Minute: "60" is not between 0 and 59/],
      ['* 24 * * *', /Hour/],
      ['* * 0 * *', /Day of month/],
      ['* * * 13 *', /Month/],
      ['* * * * 8', /Day of week/],
      ['*/0 * * * *', /bad step/],
      ['*/x * * * *', /bad step/],
      ['5-1 * * * *', /runs backwards/],
      ['1--2 * * * *', /not a number/],
      ['a * * * *', /Minute/],
      ['0 0 * * $', /Day of week/],
      ['0 seconds', /1 to 59/],
      ['60 seconds', /1 to 59/],
      ['@sometimes', /Unknown shortcut/],
      ['0 0 30 2 *', /never matches/],
      ['x'.repeat(201), /at most 200/],
      ["0 0 * * *'; drop table x", /five fields/],
    ];
    for (const [expr, re] of cases) assert.match(scheduleProblem(expr) ?? '', re, expr);
    assert.equal(scheduleProblem('0 2 * * *'), null);
    assert.equal(scheduleProblem('10 seconds'), null);
  });
});

describe('nextRuns', () => {
  test('every day at 02:00, from just before and just after', () => {
    assert.deepEqual(runs('0 2 * * *', '2026-10-16T01:59:30Z', 3), ['2026-10-16T02:00:00.000Z', '2026-10-17T02:00:00.000Z', '2026-10-18T02:00:00.000Z']);
    assert.deepEqual(runs('0 2 * * *', '2026-10-16T02:00:00Z', 1), ['2026-10-17T02:00:00.000Z'], 'after is exclusive');
  });

  test('steps, weekdays and either-day semantics', () => {
    assert.deepEqual(runs('*/15 * * * *', '2026-10-16T10:07:00Z', 3), ['2026-10-16T10:15:00.000Z', '2026-10-16T10:30:00.000Z', '2026-10-16T10:45:00.000Z']);
    // 2026-10-16 is a Friday: weekdays at 07:00 go on on Monday
    assert.deepEqual(runs('0 7 * * 1-5', '2026-10-16T08:00:00Z', 2), ['2026-10-19T07:00:00.000Z', '2026-10-20T07:00:00.000Z']);
    // day 20 or a Sunday
    assert.deepEqual(runs('0 0 20 * sun', '2026-10-16T00:00:00Z', 3), ['2026-10-18T00:00:00.000Z', '2026-10-20T00:00:00.000Z', '2026-10-25T00:00:00.000Z']);
    // */2 is unrestricted, so both must match: odd days that are Mondays
    assert.deepEqual(runs('0 0 */2 * 1', '2026-10-16T00:00:00Z', 2), ['2026-10-19T00:00:00.000Z', '2026-11-09T00:00:00.000Z']);
  });

  test('$ is the last day of each month, leap years included', () => {
    assert.deepEqual(runs('0 23 $ * *', '2028-01-15T00:00:00Z', 4), ['2028-01-31T23:00:00.000Z', '2028-02-29T23:00:00.000Z', '2028-03-31T23:00:00.000Z', '2028-04-30T23:00:00.000Z']);
    assert.deepEqual(runs('0 0 29 2 *', '2026-10-16T00:00:00Z', 1), ['2028-02-29T00:00:00.000Z']);
  });

  test('intervals in seconds count on from now; @reboot has no next run', () => {
    assert.deepEqual(runs('20 seconds', '2026-10-16T10:00:05.400Z', 3), ['2026-10-16T10:00:25.000Z', '2026-10-16T10:00:45.000Z', '2026-10-16T10:01:05.000Z']);
    assert.deepEqual(runs('@reboot', '2026-10-16T10:00:00Z'), []);
  });

  test('time zones and daylight saving time', () => {
    // 02:00 in Amsterdam: summer time (UTC+2) until 25 October 2026, then UTC+1; 02:00 comes twice that day, it runs once
    assert.deepEqual(runs('0 2 * * *', '2026-10-23T12:00:00Z', 4, 'Europe/Amsterdam'),
      ['2026-10-24T00:00:00.000Z', '2026-10-25T00:00:00.000Z', '2026-10-26T01:00:00.000Z', '2026-10-27T01:00:00.000Z']);
    // 02:30 does not exist on 29 March 2026 in Amsterdam: that day has no run
    assert.deepEqual(runs('30 2 * * *', '2026-03-28T12:00:00Z', 2, 'Europe/Amsterdam'), ['2026-03-30T00:30:00.000Z', '2026-03-31T00:30:00.000Z']);
    // midnight on the day after a short day is not skipped
    assert.deepEqual(runs('0 0 30 3 *', '2026-03-28T12:00:00Z', 1, 'Europe/Amsterdam'), ['2026-03-29T22:00:00.000Z']);
    assert.deepEqual(runs('30 9 * * *', '2026-10-16T00:00:00Z', 1, 'Asia/Kolkata'), ['2026-10-16T04:00:00.000Z']);
    assert.equal(cronTimeZone('GMT'), 'GMT');
    assert.equal(cronTimeZone('Nowhere/Else'), 'UTC');
    assert.equal(cronTimeZone(null), 'UTC');
  });

  test('every preset parses and has five runs', () => {
    for (const [label, expr] of PRESETS) {
      assert.equal(scheduleProblem(expr), null, label);
      assert.equal(nextRuns(parseSchedule(expr), new Date('2026-10-16T00:00:00Z'), 5).length, 5, label);
    }
  });

  test('a rare schedule is found quickly', () => {
    const t = performance.now();
    runs('0 0 29 2 1', '2026-10-16T00:00:00Z', 5, 'Europe/Amsterdam'); // the 29th of February or a Monday in February
    runs('59 23 31 12 *', '2026-10-16T00:00:00Z', 5, 'America/New_York');
    assert.ok(performance.now() - t < 2000);
  });
});

describe('words and fields', () => {
  test('describeSchedule', () => {
    const d = (e: string) => describeSchedule(parseSchedule(e));
    assert.equal(d('0 2 * * *'), 'At 02:00, every day');
    assert.equal(d('* * * * *'), 'Every minute');
    assert.equal(d('*/5 * * * *'), 'Every 5 minutes');
    assert.equal(d('0 * * * *'), 'Every hour');
    assert.equal(d('15 * * * *'), 'At minute 15 of every hour');
    assert.equal(d('0 7 * * 1-5'), 'At 07:00, on weekdays');
    assert.equal(d('0 3 * * 0'), 'At 03:00, on Sunday');
    assert.equal(d('0 23 $ * *'), 'At 23:00, on the last day of the month');
    assert.equal(d('0 0 1 1 *'), 'At 00:00, on day 1 of the month, in January');
    assert.equal(d('0 0 1 * 1'), 'At 00:00, on day 1 of the month or on Monday');
    assert.equal(d('0 */6 * * *'), 'At 00:00, 06:00, 12:00, 18:00, every day');
    assert.equal(d('0 */2 * * *'), 'At minute 0 of every 2 hours, every day');
    assert.equal(d('30 seconds'), 'Every 30 seconds');
    assert.equal(d('@reboot'), 'When the database server starts');
  });

  test('join and split', () => {
    assert.equal(joinSchedule({ minute: '0', hour: '2' }), '0 2 * * *');
    assert.equal(joinSchedule({ minute: ' 5 ', hour: '', day: '$', month: '*', weekday: 'mon' }), '5 * $ * mon');
    assert.deepEqual(splitSchedule('0 2 * * *'), { minute: '0', hour: '2', day: '*', month: '*', weekday: '*' });
    assert.equal(splitSchedule('30 seconds'), null);
    assert.equal(splitSchedule('nonsense'), null);
    assert.equal(formatRun(new Date('2026-10-16T02:00:09Z')), '2026-10-16 02:00');
    assert.equal(formatRun(new Date('2026-10-16T02:00:09Z'), 'Europe/Amsterdam', true), '2026-10-16 04:00:09');
  });
});
