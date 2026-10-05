'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const when = require('../src/main/when');

// Wednesday 7 October 2026, 14:30 (local time, so the tests don't depend on the time zone).
const NOW = new Date(2026, 9, 7, 14, 30, 0);
const at = (month, day, hour = 0, minute = 0, second = 0) => new Date(2026, month - 1, day, hour, minute, second);
const MIN = 60_000;

function due(text, opts, now = NOW) {
  const r = when.parseWhen(text, now, opts);
  assert.ok(r && r.ok, `"${text}" should be understood (got ${JSON.stringify(r)})`);
  return r.due;
}

function same(actual, expected, label) {
  assert.equal(actual.getTime(), expected.getTime(), `${label}: got ${actual.toString()}, wanted ${expected.toString()}`);
}

test('understands delays in many words', () => {
  const cases = {
    'in 20 minutes': 20 * MIN,
    'in 20 min': 20 * MIN,
    'in 20 mins': 20 * MIN,
    'in 20m': 20 * MIN,
    'after 10 minutes': 10 * MIN,
    'within 10 minutes': 10 * MIN,
    'in an hour': 60 * MIN,
    'in 1 hour': 60 * MIN,
    'in half an hour': 30 * MIN,
    'in a half hour': 30 * MIN,
    'in an hour and a half': 90 * MIN,
    'in one and a half hours': 90 * MIN,
    'in 2 and a half hours': 150 * MIN,
    'in 1 hour 30 minutes': 90 * MIN,
    'in 1 hour and 30 minutes': 90 * MIN,
    'in 1h30': 90 * MIN,
    'in 1h 30m': 90 * MIN,
    'in 90 min': 90 * MIN,
    'in 2.5 hours': 150 * MIN,
    'in 1,5 hours': 90 * MIN,
    'in a quarter of an hour': 15 * MIN,
    'in three quarters of an hour': 45 * MIN,
    'in a couple of minutes': 2 * MIN,
    'in a few minutes': 3 * MIN,
    'in twenty five minutes': 25 * MIN,
    'in twenty-five minutes': 25 * MIN,
    'in 30 seconds': 30_000,
    'in 45s': 45_000,
    'in about 20 minutes': 20 * MIN,
    'in around 20 minutes': 20 * MIN,
    'in 20 minutes time': 20 * MIN,
    "in 20 minutes' time": 20 * MIN,
    '10 minutes from now': 10 * MIN,
    '5 minutes later': 5 * MIN,
    'another 5 minutes': 5 * MIN,
  };
  for (const [text, ms] of Object.entries(cases)) {
    assert.equal(due(text).getTime() - NOW.getTime(), ms, text);
  }
});

test('understands days and weeks, keeping the clock time', () => {
  same(due('in 3 days'), at(10, 10, 14, 30), 'in 3 days');
  same(due('in a week'), at(10, 14, 14, 30), 'in a week');
  same(due('in 2 weeks'), at(10, 21, 14, 30), 'in 2 weeks');
  same(due('in a month'), at(11, 7, 14, 30), 'in a month');
  same(due('in 3 days at 5pm'), at(10, 10, 17), 'in 3 days at 5pm');
  same(due('in 2 days 3 hours'), at(10, 9, 17, 30), 'in 2 days 3 hours');
});

test('understands clock times, taking the next time it will be that time', () => {
  same(due('at 6pm'), at(10, 7, 18), 'at 6pm');
  same(due('at 6 p.m.'), at(10, 7, 18), 'at 6 p.m.');
  same(due('at 6:30pm'), at(10, 7, 18, 30), 'at 6:30pm');
  same(due('at 6.30pm'), at(10, 7, 18, 30), 'at 6.30pm');
  same(due('at 18:30'), at(10, 7, 18, 30), 'at 18:30');
  same(due('at 6'), at(10, 7, 18), 'at 6 (this evening)');
  same(due('at 3'), at(10, 7, 15), 'at 3 (half an hour from now)');
  same(due('at 9'), at(10, 7, 21), 'at 9 (tonight: 9am has passed)');
  same(due('at 9am'), at(10, 8, 9), 'at 9am (tomorrow)');
  same(due('at 7:45 am'), at(10, 8, 7, 45), 'at 7:45 am');
  same(due('at 6 o\'clock'), at(10, 7, 18), "at 6 o'clock");
  same(due('at noon'), at(10, 8, 12), 'at noon (tomorrow)');
  same(due('at midnight'), at(10, 8, 0), 'at midnight');
  same(due('at half past six'), at(10, 7, 18, 30), 'at half past six');
  same(due('at quarter to 5'), at(10, 7, 16, 45), 'at quarter to 5');
  same(due('at six pm'), at(10, 7, 18), 'at six pm');
  same(due('at six thirty pm'), at(10, 7, 18, 30), 'at six thirty pm');
  // After the afternoon: the morning one is next.
  same(due('at 9', undefined, new Date(2026, 9, 7, 22, 0)), at(10, 8, 9), 'at 9 late at night');
  same(due('at 5', undefined, new Date(2026, 9, 7, 18, 0)), at(10, 8, 17), 'at 5 after 5pm');
  same(due('at 9', undefined, new Date(2026, 9, 7, 8, 30)), at(10, 7, 9), 'at 9 early in the morning');
});

test('understands days, and part-of-day words that decide am or pm', () => {
  same(due('tomorrow'), at(10, 8, 9), 'tomorrow');
  same(due('tomorrow at 9'), at(10, 8, 9), 'tomorrow at 9');
  same(due('tomorrow at 5'), at(10, 8, 17), 'tomorrow at 5');
  same(due('tomorrow morning'), at(10, 8, 9), 'tomorrow morning');
  same(due('tomorrow evening at 7'), at(10, 8, 19), 'tomorrow evening at 7');
  same(due('tomorrow night at 9'), at(10, 8, 21), 'tomorrow night at 9');
  same(due('day after tomorrow at 8'), at(10, 9, 8), 'day after tomorrow at 8');
  same(due('tonight'), at(10, 7, 21), 'tonight');
  same(due('tonight at 9'), at(10, 7, 21), 'tonight at 9');
  same(due('tonight at 12'), at(10, 8, 0), 'tonight at 12');
  same(due('this evening'), at(10, 7, 18), 'this evening');
  same(due('this afternoon'), at(10, 7, 15), 'this afternoon');
  same(due('today at 5pm'), at(10, 7, 17), 'today at 5pm');
  same(due('in the morning'), at(10, 8, 9), 'in the morning');
  same(due('at 9 in the morning'), at(10, 8, 9), 'at 9 in the morning');
  same(due('at 5 in the afternoon'), at(10, 7, 17), 'at 5 in the afternoon');
  same(due('at 3 at night'), at(10, 8, 3), 'at 3 at night');
  same(due('next week'), at(10, 12, 9), 'next week is the coming Monday');
  same(due('next week at 10am'), at(10, 12, 10), 'next week at 10am');
});

test('understands weekdays and dates', () => {
  same(due('friday'), at(10, 9, 9), 'friday');
  same(due('on friday at 5pm'), at(10, 9, 17), 'on friday at 5pm');
  same(due('on fri at 4'), at(10, 9, 16), 'on fri at 4');
  same(due('friday evening'), at(10, 9, 18), 'friday evening');
  same(due('wednesday at 3pm'), at(10, 7, 15), 'later today when it is that weekday');
  same(due('wednesday at 1pm'), at(10, 14, 13), 'next week when this weekday is over');
  same(due('wednesday'), at(10, 14, 9), 'wednesday said on a wednesday');
  same(due('next wednesday'), at(10, 14, 9), 'next wednesday');
  same(due('on the 15th'), at(10, 15, 9), 'on the 15th');
  same(due('on the 7th'), at(11, 7, 9), 'on the 7th (today is the 7th)');
  same(due('on the 15th at 2pm'), at(10, 15, 14), 'on the 15th at 2pm');
  same(due('on march 3rd'), new Date(2027, 2, 3, 9), 'on march 3rd');
  same(due('on 3 march at 10am'), new Date(2027, 2, 3, 10), 'on 3 march at 10am');
  same(due('on december 25'), at(12, 25, 9), 'on december 25');
});

test('timers: "for 5 minutes", "5 minute timer"', () => {
  assert.equal(due('set a timer for 5 minutes', { timer: true }).getTime() - NOW.getTime(), 5 * MIN);
  assert.equal(due('5 minute timer', { timer: true }).getTime() - NOW.getTime(), 5 * MIN);
  assert.equal(due('a 10-minute timer', { timer: true }).getTime() - NOW.getTime(), 10 * MIN);
  assert.equal(due('timer 25 min', { timer: true }).getTime() - NOW.getTime(), 25 * MIN);
  assert.equal(due('timer for an hour', { timer: true }).getTime() - NOW.getTime(), 60 * MIN);
  // Without the timer flag, "for 8 minutes" is not a delay.
  assert.equal(when.parseWhen('boil the eggs for 8 minutes', NOW), null);
});

test('a bare delay only counts when asked', () => {
  assert.equal(when.parseWhen('20 minutes', NOW), null);
  assert.equal(due('20 minutes', { bare: true }).getTime() - NOW.getTime(), 20 * MIN);
  assert.equal(due('an hour', { bare: true }).getTime() - NOW.getTime(), 60 * MIN);
});

test('leaves alone numbers and times that are about something else', () => {
  assert.equal(when.parseWhen('about the 3pm meeting', NOW), null);
  assert.equal(when.parseWhen('catch the 6pm train', NOW), null);
  assert.equal(when.parseWhen('mention it at one point', NOW), null);
  assert.equal(when.parseWhen('call 911', NOW), null);
  assert.equal(when.parseWhen('buy 2 apples', NOW), null);
  assert.equal(when.parseWhen('buy a second-hand car', NOW), null);
  assert.equal(when.parseWhen('read the 21st chapter', NOW), null);
  assert.equal(when.parseWhen('today', NOW), null);
  // An explicit delay wins over a clock time that is part of the text.
  const r = when.parseWhen('in 20 minutes about the 6pm meeting', NOW);
  assert.equal(r.due.getTime() - NOW.getTime(), 20 * MIN);
  assert.equal(when.cut('in 20 minutes about the 6pm meeting', r.spans).trim(), 'about the 6pm meeting');
});

test('says why a time is unusable', () => {
  assert.equal(when.parseWhen('in 0 minutes', NOW).reason, 'zero');
  assert.equal(when.parseWhen('in 500 years', NOW).reason, 'far');
  assert.equal(when.parseWhen('in 2 years', NOW).reason, 'far');
  assert.equal(when.parseWhen('this morning', NOW).reason, 'past');
  assert.equal(when.parseWhen('today at 1pm', NOW).reason, 'past');
  assert.equal(when.parseWhen('on feb 30', NOW).reason, 'baddate');
  assert.equal(when.parseWhen('on the 31st of april', NOW).reason, 'baddate');
});

test('cuts the time out of a sentence', () => {
  const text = 'call mum in 20 minutes please';
  const r = when.parseWhen(text, NOW);
  assert.equal(when.cut(text, r.spans).replace(/\s+/g, ' ').trim(), 'call mum please');
  const text2 = 'buy milk tomorrow at 9am';
  assert.equal(when.cut(text2, when.parseWhen(text2, NOW).spans).trim(), 'buy milk');
  const text3 = 'on friday at 5pm go home';
  assert.equal(when.cut(text3, when.parseWhen(text3, NOW).spans).trim(), 'go home');
  assert.equal(when.cut('abc', []), 'abc');
});

test('formats times for people', () => {
  assert.equal(when.formatDuration(45_000), '45 seconds');
  assert.equal(when.formatDuration(1000), '1 second');
  assert.equal(when.formatDuration(90_000), '1 minute 30 seconds');
  assert.equal(when.formatDuration(20 * MIN), '20 minutes');
  assert.equal(when.formatDuration(330_000), '5 minutes');
  assert.equal(when.formatDuration(90 * MIN), '1 hour 30 minutes');
  assert.equal(when.formatDuration(26 * 60 * MIN), '1 day 2 hours');
  assert.equal(when.formatDuration(5 * 86_400_000 + 3 * 3_600_000), '5 days 3 hours');

  assert.equal(when.formatDay(NOW, NOW), 'today');
  assert.equal(when.formatDay(at(10, 8, 9), NOW), 'tomorrow');
  assert.equal(when.formatDay(at(10, 6, 9), NOW), 'yesterday');
  assert.match(when.formatDay(at(10, 9, 9), NOW), /Fri/); // within the week: with the weekday
  assert.match(when.formatDay(at(10, 20, 9), NOW), /20/);
  assert.match(when.formatDay(new Date(2027, 2, 3, 9), NOW), /2027/);

  const clock = (d) => when.formatClock(d);
  assert.equal(when.describeDue(new Date(NOW.getTime() + 45_000), NOW), 'in 45 seconds');
  assert.equal(when.describeDue(new Date(NOW.getTime() + 20 * MIN), NOW), `in 20 minutes (${clock(new Date(NOW.getTime() + 20 * MIN))})`);
  assert.equal(when.describeDue(at(10, 7, 21), NOW), `today at ${clock(at(10, 7, 21))}`);
  assert.equal(when.describeDue(at(10, 8, 9), NOW), `tomorrow at ${clock(at(10, 8, 9))}`);
});

test('reads number words', () => {
  assert.equal(when.numberOf('twenty five'), 25);
  assert.equal(when.numberOf('Ninety-nine'), 99);
  assert.equal(when.numberOf('a'), 1);
  assert.equal(when.numberOf('an'), 1);
  assert.equal(when.numberOf('a couple of'), 2);
  assert.equal(when.numberOf('a few'), 3);
  assert.equal(when.numberOf('1,5'), 1.5);
});
