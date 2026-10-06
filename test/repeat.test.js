'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const repeat = require('../src/main/repeat');
const when = require('../src/main/when');

// Wednesday 7 October 2026, 14:30 (local time).
const NOW = new Date(2026, 9, 7, 14, 30, 0);
const at = (month, day, hour = 0, minute = 0, year = 2026) => new Date(year, month - 1, day, hour, minute);
const MIN = 60_000;

function parse(text, now = NOW) {
  const r = repeat.parseRepeat(text, now);
  assert.ok(r && r.rule, `"${text}" should be a repeat (got ${JSON.stringify(r)})`);
  return r;
}

function same(actual, expected, label) {
  assert.equal(actual.getTime(), expected.getTime(), `${label}: got ${actual.toString()}, wanted ${expected.toString()}`);
}

test('understands how often, in many words', () => {
  const rules = {
    'every day at 9': { unit: 'day', every: 1, at: [9, 0] },
    'daily at 6pm': { unit: 'day', every: 1, at: [18, 0] },
    'every other day at 9': { unit: 'day', every: 2, at: [9, 0] },
    'every 3 days at noon': { unit: 'day', every: 3, at: [12, 0] },
    'every morning': { unit: 'day', every: 1, at: [9, 0] },
    'every evening at 7': { unit: 'day', every: 1, at: [19, 0] },
    'every night': { unit: 'day', every: 1, at: [21, 0] },
    'every weekday at 8:30': { unit: 'week', every: 1, at: [8, 30], weekdays: [1, 2, 3, 4, 5] },
    'on weekdays at 8': { unit: 'week', every: 1, at: [8, 0], weekdays: [1, 2, 3, 4, 5] },
    'every weekend at 10am': { unit: 'week', every: 1, at: [10, 0], weekdays: [0, 6] },
    'every monday at 9': { unit: 'week', every: 1, at: [9, 0], weekdays: [1] },
    'on mondays at 5pm': { unit: 'week', every: 1, at: [17, 0], weekdays: [1] },
    'every monday and thursday at 6:30pm': { unit: 'week', every: 1, at: [18, 30], weekdays: [1, 4] },
    'every mon, wed and fri at 7am': { unit: 'week', every: 1, at: [7, 0], weekdays: [1, 3, 5] },
    'every friday evening': { unit: 'week', every: 1, at: [18, 0], weekdays: [5] },
    'weekly on friday at 5': { unit: 'week', every: 1, at: [17, 0], weekdays: [5] },
    'every other week on monday at 9': { unit: 'week', every: 2, at: [9, 0], weekdays: [1] },
    'every month on the 15th at 9am': { unit: 'month', every: 1, at: [9, 0], dom: 15 },
    'on the 1st of every month at 10': { unit: 'month', every: 1, at: [10, 0], dom: 1 },
    'every 2 months on the 10th at noon': { unit: 'month', every: 2, at: [12, 0], dom: 10 },
    'every year on march 3 at 8am': { unit: 'year', every: 1, at: [8, 0], dom: 3, month: 2 },
    'yearly on 3 march at 8am': { unit: 'year', every: 1, at: [8, 0], dom: 3, month: 2 },
    'every hour': { unit: 'hour', every: 1 },
    'hourly': { unit: 'hour', every: 1 },
    'every 2 hours': { unit: 'hour', every: 2 },
    'every two hours': { unit: 'hour', every: 2 },
    'every half hour': { unit: 'minute', every: 30 },
    'every 45 minutes': { unit: 'minute', every: 45 },
    'every 1.5 hours': { unit: 'minute', every: 90 },
  };
  for (const [text, rule] of Object.entries(rules)) assert.deepEqual(parse(text).rule, rule, text);
});

test('"daily" and friends count as a repeat when they say how often, not when they name something', () => {
  for (const text of ['feed the cat daily', 'daily to take pills', 'weekly on friday at 5', 'stretch hourly, please', 'water the plants weekly.', 'monthly at 9am', 'daily 9am']) {
    assert.ok(repeat.parseRepeat(text, NOW), text);
  }
});

test('asks for the time of day when it is missing', () => {
  for (const text of ['every monday', 'every weekday', 'every day', 'monthly on the 1st', 'every month', 'every year on march 3', 'every 2 weeks']) {
    const r = parse(text);
    assert.equal(r.needsTime, true, text);
    assert.equal(r.rule.at, undefined, text);
  }
  for (const text of ['every hour', 'every 20 minutes', 'every morning']) assert.equal(parse(text).needsTime, false, text);
  // "every week" repeats on the day it was asked for, "every month" on its date.
  assert.deepEqual(parse('every week').rule.weekdays, [3]);
  assert.equal(parse('every month').rule.dom, 7);
  assert.equal(parse('every year').rule.month, 9);
});

test('keeps what was said about how often, without the time', () => {
  assert.equal(parse('take pills every day at 9am').phrase, 'every day');
  assert.equal(parse('every friday evening').phrase, 'every friday evening');
  assert.equal(parse('every year on march 3 at 9am').phrase, 'every year on march 3');
  assert.equal(parse('monthly on the 15th').phrase, 'monthly on the 15th');
  // The spans cover everything that was about timing, so the rest is what to remember.
  const text = 'call mum every sunday at 6pm please';
  assert.equal(when.cut(text, parse(text).spans).replace(/\s+/g, ' ').trim(), 'call mum please');
});

test('leaves other sentences alone', () => {
  for (const text of ['tomorrow at 9', 'in 20 minutes', 'at 6pm', 'every kid gets a hug', 'give each kid a hug', 'the daily standup at 10', 'a weekly planner', 'my monthly report is due', 'everything', 'once a day']) {
    assert.equal(repeat.parseRepeat(text, NOW), null, text);
  }
});

test('notices when it should stop after a while (which it cannot do)', () => {
  for (const text of ['every day for 5 days at 9', 'every day until friday at 9', 'every weekday for the next 2 weeks at 8', 'every monday 4 times at 9', 'every day for a week at 9']) {
    assert.equal(parse(text).endCondition, true, text);
  }
  assert.equal(parse('every day at 9').endCondition, false);
});

test('refuses nagging and non-sense', () => {
  assert.equal(repeat.parseRepeat('every minute', NOW).rule, null);
  assert.equal(repeat.parseRepeat('every minute', NOW).reason, 'too-often');
  assert.equal(repeat.parseRepeat('every 4 minutes', NOW).reason, 'too-often');
  assert.deepEqual(parse('every 5 minutes').rule, { unit: 'minute', every: 5 });
  assert.equal(repeat.parseRepeat('every 5000 days at 9', NOW).reason, 'too-far');
});

test('works out the first time it rings', () => {
  same(repeat.firstDue(parse('every day at 9').rule, NOW), at(10, 8, 9), 'every day at 9');
  same(repeat.firstDue(parse('every day at 6pm').rule, NOW), at(10, 7, 18), 'every day at 6pm (later today)');
  same(repeat.firstDue(parse('every weekday at 8:30').rule, NOW), at(10, 8, 8, 30), 'every weekday');
  same(repeat.firstDue(parse('every weekday at 8:30').rule, new Date(2026, 9, 9, 10, 0)), at(10, 12, 8, 30), 'a friday morning after 8:30 skips the weekend');
  same(repeat.firstDue(parse('every monday at 9').rule, NOW), at(10, 12, 9), 'every monday');
  same(repeat.firstDue(parse('every monday and thursday at 6:30pm').rule, NOW), at(10, 8, 18, 30), 'monday or thursday');
  same(repeat.firstDue(parse('every wednesday at 6pm').rule, NOW), at(10, 7, 18), 'a wednesday, later today');
  same(repeat.firstDue(parse('every wednesday at 9am').rule, NOW), at(10, 14, 9), 'a wednesday that has already passed');
  same(repeat.firstDue(parse('every 2 hours').rule, NOW), new Date(NOW.getTime() + 120 * MIN), 'every 2 hours');
  same(repeat.firstDue(parse('every month on the 15th at 9am').rule, NOW), at(10, 15, 9), 'the 15th');
  same(repeat.firstDue(parse('every month on the 1st at 10').rule, NOW), at(11, 1, 10), 'the 1st (already passed)');
  same(repeat.firstDue(parse('every year on march 3 at 8am').rule, NOW), at(3, 3, 8, 0, 2027), 'a yearly date');
  same(repeat.firstDue(parse('every year on october 7 at 9am').rule, NOW), at(10, 7, 9, 0, 2027), 'yearly, today already past');
});

test('after it rings, picks the next time and skips the ones that were missed', () => {
  const rule = (text) => parse(text).rule;
  // On time.
  same(repeat.advance(rule('every day at 9'), at(10, 8, 9), at(10, 8, 9, 0)), at(10, 9, 9), 'daily');
  same(repeat.advance(rule('every day at 9'), at(10, 8, 9), at(10, 8, 9, 5)), at(10, 9, 9), 'daily, 5 minutes late');
  // A week away: one ring, then the next 9am, not seven.
  same(repeat.advance(rule('every day at 9'), at(10, 8, 9), at(10, 16, 12)), at(10, 17, 9), 'daily after a week');
  same(repeat.advance(rule('every other day at 9'), at(10, 8, 9), at(10, 16, 12)), at(10, 18, 9), 'every other day stays on its beat');
  same(repeat.advance(rule('every weekday at 9'), at(10, 9, 9), at(10, 9, 9, 1)), at(10, 12, 9), 'friday to monday');
  same(repeat.advance(rule('every monday and thursday at 18:30'), at(10, 8, 18, 30), at(10, 8, 18, 31)), at(10, 12, 18, 30), 'thursday to monday');
  same(repeat.advance(rule('every other week on monday at 9'), at(10, 12, 9), at(10, 12, 9, 1)), at(10, 26, 9), 'every other week');
  same(repeat.advance(rule('every hour'), at(10, 8, 9), at(10, 8, 9, 20)), at(10, 8, 10), 'hourly, on the beat');
  same(repeat.advance(rule('every 45 minutes'), at(10, 8, 9), at(10, 8, 12, 0)), at(10, 8, 12, 45), 'skips missed intervals, stays on the beat (9:00, 9:45 … 12:00, 12:45)');
  // Months and years: the 31st becomes the last day of a short month, then comes back.
  const monthly = { unit: 'month', every: 1, at: [9, 0], dom: 31 };
  same(repeat.advance(monthly, at(1, 31, 9), at(1, 31, 9, 1)), at(2, 28, 9), 'jan 31 -> feb 28');
  same(repeat.advance(monthly, at(2, 28, 9), at(2, 28, 9, 1)), at(3, 31, 9), 'feb 28 -> mar 31');
  same(repeat.advance(rule('every month on the 15th at 9am'), at(10, 15, 9), at(10, 15, 9, 1)), at(11, 15, 9), 'monthly');
  same(repeat.advance(rule('every 2 months on the 10th at 9am'), at(10, 10, 9), at(10, 10, 9, 1)), at(12, 10, 9), 'every 2 months');
  same(repeat.advance(rule('every year on march 3 at 8am'), at(3, 3, 8, 0, 2027), at(3, 3, 8, 1, 2027)), at(3, 3, 8, 0, 2028), 'yearly');
  const leap = { unit: 'year', every: 1, at: [9, 0], dom: 29, month: 1 };
  same(repeat.advance(leap, new Date(2028, 1, 29, 9), new Date(2028, 1, 29, 9, 1)), new Date(2029, 1, 28, 9), 'feb 29 -> feb 28');
});

test('the time of day sticks across a change to summer time', () => {
  // (In zones without one this is just a normal week.)
  const rule = parse('every day at 9').rule;
  let due = new Date(2026, 2, 25, 9, 0);
  for (let i = 0; i < 12; i++) {
    due = repeat.advance(rule, due, new Date(due.getTime() + MIN));
    assert.deepEqual([due.getHours(), due.getMinutes()], [9, 0]);
  }
});

test('describes a rule in words', () => {
  const clock = (h, m = 0) => when.formatClock(new Date(2026, 0, 5, h, m));
  const words = (text) => repeat.describeRule(parse(text).rule);
  assert.equal(words('every day at 9'), `every day at ${clock(9)}`);
  assert.equal(words('every 3 days at noon'), `every 3 days at ${clock(12)}`);
  assert.equal(words('every weekday at 8:30'), `every weekday at ${clock(8, 30)}`);
  assert.equal(words('every weekend at 10am'), `every weekend at ${clock(10)}`);
  assert.equal(words('every monday and thursday at 6:30pm'), `every Monday and Thursday at ${clock(18, 30)}`);
  assert.equal(words('every mon, wed and fri at 7am'), `every Monday, Wednesday and Friday at ${clock(7)}`);
  assert.equal(words('every other week on monday at 9'), `every 2 weeks on Monday at ${clock(9)}`);
  assert.equal(words('every month on the 1st at 10'), `every month on the 1st at ${clock(10)}`);
  assert.equal(words('every 2 months on the 22nd at 10'), `every 2 months on the 22nd at ${clock(10)}`);
  assert.equal(words('every year on march 3 at 8am'), `every year on March 3 at ${clock(8)}`);
  assert.equal(words('every hour'), 'every hour');
  assert.equal(words('every 2 hours'), 'every 2 hours');
  assert.equal(words('every 90 minutes'), 'every 1 hour 30 minutes');
  assert.equal(words('every 20 minutes'), 'every 20 minutes');
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 31].map(repeat.ordinal), ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '31st']);
});

test('only keeps rules that make sense', () => {
  assert.deepEqual(repeat.sanitizeRule({ unit: 'day', every: 2, at: [9, 0], extra: 'ignored' }), { unit: 'day', every: 2, at: [9, 0] });
  assert.deepEqual(repeat.sanitizeRule({ unit: 'week', weekdays: [3, 1, 3], at: [8, 5] }), { unit: 'week', every: 1, at: [8, 5], weekdays: [1, 3] });
  for (const bad of [
    null,
    'daily',
    {},
    { unit: 'fortnight', every: 1 },
    { unit: 'day', every: 0, at: [9, 0] },
    { unit: 'day', every: 1.5, at: [9, 0] },
    { unit: 'day', every: 1, at: [25, 0] },
    { unit: 'day', every: 1, at: [9] },
    { unit: 'minute', every: 2 },
    { unit: 'week', every: 1, at: [9, 0], weekdays: [] },
    { unit: 'week', every: 1, at: [9, 0], weekdays: [7] },
    { unit: 'week', every: 2, at: [9, 0], weekdays: [1, 2] },
    { unit: 'month', every: 1, at: [9, 0] },
    { unit: 'month', every: 1, at: [9, 0], dom: 32 },
    { unit: 'year', every: 1, at: [9, 0], dom: 3 },
  ]) {
    assert.equal(repeat.sanitizeRule(bad), null, JSON.stringify(bad));
  }
});
