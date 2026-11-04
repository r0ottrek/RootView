// Dashboard periods and dates picked in the From/To boxes. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { customPeriod, isoDayOf, parsePeriod, periodRange } from '../.test-build/util.js';

const TZ = 'America/Chicago';
const CDT = (m, d, h = 0, min = 0) => Date.UTC(2026, m - 1, d, h + 5, min); // 2026, before Nov 1
const CST = (m, d, h = 0, min = 0) => Date.UTC(2026, m - 1, d, h + 6, min); // 2026, from Nov 1

test('period names from the address bar: known ones accepted, anything else falls back', () => {
  for (const p of ['week', 'month', 'last', 'quarter', 'year', 'all']) assert.equal(parsePeriod(p), p);
  for (const p of ['lastweek', 'constructor', 'toString', '_', 'x_y', '', undefined]) assert.equal(parsePeriod(p), 'month', String(p));
  assert.equal(parsePeriod(undefined, 'all'), 'all', 'each page picks its own fallback');
});

test('picked dates: both must be real dates; picked backwards they are swapped', () => {
  assert.equal(customPeriod('2026-10-01', '2026-10-15'), '2026-10-01_2026-10-15');
  assert.equal(customPeriod('2026-10-15', '2026-10-01'), '2026-10-01_2026-10-15');
  for (const [a, b] of [['2026-02-30', '2026-03-01'], ['2026-10-01', ''], ['10/01/2026', '2026-10-15'], ['1999-12-31', '2026-01-01'], [undefined, '2026-10-01'], ['2026-10-01', '2101-01-01']])
    assert.equal(customPeriod(a, b), null, `${a} to ${b}`);
  assert.equal(customPeriod('2028-02-29', '2028-03-01'), '2028-02-29_2028-03-01', 'leap days are real');
  assert.equal(parsePeriod('2026-10-15_2026-10-01'), '2026-10-01_2026-10-15');
  assert.equal(parsePeriod('2026-13-01_2026-10-01'), 'month', 'a bad date falls back');
  assert.equal(parsePeriod('2026-10-01_2026-10-15_2026-10-20'), 'month', 'three dates is not a range');
  assert.equal(isoDayOf(CDT(10, 26, 23, 30), TZ), '2026-10-26', 'late evening is still that day');
});

test('picked dates: whole days, midnight to midnight, both days included, compared with as many days before', () => {
  const r = periodRange('2026-10-01_2026-10-15', TZ, CDT(10, 26, 10));
  assert.deepEqual([r.start, r.end], [CDT(10, 1), CDT(10, 16)]);
  assert.deepEqual([r.prevStart, r.prevEnd], [CDT(9, 16), CDT(10, 1)]);
  assert.equal(r.label, 'Oct 1 – Oct 15, 2026');
  assert.equal(r.prevLabel, 'the 15 days before');
});

test('picked dates: one day, across the new year, across the clock change, into today, in the future', () => {
  const day = periodRange('2026-10-24_2026-10-24', TZ, CDT(10, 26, 10));
  assert.deepEqual([day.start, day.end, day.label, day.prevLabel], [CDT(10, 24), CDT(10, 25), 'Oct 24, 2026', 'the day before']);
  assert.equal(periodRange('2025-12-20_2026-01-05', TZ, CDT(10, 26)).label, 'Dec 20, 2025 – Jan 5, 2026');
  const dst = periodRange('2026-10-31_2026-11-02', TZ, CST(11, 20));
  assert.deepEqual([dst.start, dst.end], [CDT(10, 31), CST(11, 3)]);
  assert.equal(dst.end - dst.start, 3 * 86_400_000 + 3_600_000, 'the extra hour on Nov 1 is included');
  const at = CDT(10, 26, 10);
  const toToday = periodRange('2026-10-20_2026-10-26', TZ, at);
  assert.deepEqual([toToday.start, toToday.end], [CDT(10, 20), at + 1], 'stops at now');
  assert.equal(toToday.prevEnd - toToday.prevStart, toToday.end - toToday.start, 'compared like for like');
  const future = periodRange('2026-11-10_2026-11-12', TZ, at);
  assert.equal(future.end, future.start, 'nothing yet');
});

test('a preset still works as before', () => {
  const r = periodRange('month', TZ, CDT(10, 26, 10));
  assert.deepEqual([r.start, r.label], [CDT(10, 1), 'This month']);
  assert.equal(periodRange('all', TZ, CDT(10, 26)).start, 0);
});
