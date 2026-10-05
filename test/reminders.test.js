'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const reminders = require('../src/main/reminders');

// Wednesday 7 October 2026, 14:30 local time.
const NOW = new Date(2026, 9, 7, 14, 30, 0);
const at = (month, day, hour = 0, minute = 0) => new Date(2026, month - 1, day, hour, minute);
const MIN = 60_000;

const detect = (text, opts = {}) => reminders.detect(text, { now: NOW, ...opts });

function set(text, opts) {
  const d = detect(text, opts);
  assert.ok(d && d.type === 'set', `"${text}" should set something (got ${JSON.stringify(d)})`);
  return d;
}

test('sets a reminder, however it is phrased', () => {
  const cases = [
    ['remind me to call mum in 20 minutes', 'call mum', 'to', NOW.getTime() + 20 * MIN],
    ['Remind me in 20 minutes to call mum', 'call mum', 'to', NOW.getTime() + 20 * MIN],
    ['remind me at 6pm to stretch', 'stretch', 'to', at(10, 7, 18).getTime()],
    ['remind me to buy milk tomorrow at 9', 'buy milk', 'to', at(10, 8, 9).getTime()],
    ['remind me about the meeting at 3pm', 'the meeting', 'about', at(10, 7, 15).getTime()],
    ['remind me that I have a dentist appointment on friday at 10am', 'I have a dentist appointment', 'that', at(10, 9, 10).getTime()],
    ['can you please remind me to take my pills at 8', 'take my pills', 'to', at(10, 7, 20).getTime()],
    ['Nibo, remind me to check the oven in half an hour', 'check the oven', 'to', NOW.getTime() + 30 * MIN],
    ['hey nibo can you set a reminder for 6pm to call dad', 'call dad', 'to', at(10, 7, 18).getTime()],
    ['set a reminder to water the plants tomorrow', 'water the plants', 'to', at(10, 8, 9).getTime()],
    ['reminder: pay rent on the 15th', 'pay rent', '', at(10, 15, 9).getTime()],
    ["don't let me forget to call mum in an hour", 'call mum', 'to', NOW.getTime() + 60 * MIN],
    ['ping me in 5 minutes to drink water', 'drink water', 'to', NOW.getTime() + 5 * MIN],
    ['remind me to log in in 5 minutes', 'log in', 'to', NOW.getTime() + 5 * MIN],
    ['remind me to call 911 in 5 minutes', 'call 911', 'to', NOW.getTime() + 5 * MIN],
    ['remind me to take 2 pills at 8', 'take 2 pills', 'to', at(10, 7, 20).getTime()],
    ['remind me to boil the eggs for 8 minutes in 10 minutes', 'boil the eggs for 8 minutes', 'to', NOW.getTime() + 10 * MIN],
    ['remind me in 20 minutes about the 6pm meeting', 'the 6pm meeting', 'about', NOW.getTime() + 20 * MIN],
    ['remind me in 5 minutes', '', '', NOW.getTime() + 5 * MIN],
  ];
  for (const [text, what, connector, due] of cases) {
    const d = set(text);
    assert.equal(d.kind, 'reminder', text);
    assert.equal(d.text, what, text);
    assert.equal(d.connector, connector, text);
    assert.equal(d.due.getTime(), due, text);
  }
});

test('wake-up calls and alarms get a default message', () => {
  assert.equal(set('wake me up in 10 minutes').text, 'wake up');
  const alarm = set('set an alarm for 7am');
  assert.equal(alarm.text, 'your alarm');
  assert.equal(alarm.due.getTime(), at(10, 8, 7).getTime());
  // Alarms lean towards the morning.
  assert.equal(set('set alarm 6:30').due.getTime(), at(10, 8, 6, 30).getTime());
  assert.equal(set('set an alarm for 7').due.getTime(), at(10, 8, 7).getTime());
  assert.equal(set('set an alarm for 7pm').due.getTime(), at(10, 7, 19).getTime());
});

test('sets a timer', () => {
  const cases = [
    ['set a timer for 5 minutes', '', 5 * MIN],
    ['set a 10 minute timer', '', 10 * MIN],
    ['5 minute timer', '', 5 * MIN],
    ['timer 25 min', '', 25 * MIN],
    ['start a timer for 1 hour 30 minutes', '', 90 * MIN],
    ['set a timer for 10 minutes for the pasta', 'the pasta', 10 * MIN],
    ['set a timer for 5 minutes called pasta', 'pasta', 5 * MIN],
    ['set an egg timer for 8 minutes', 'egg', 8 * MIN],
    ['countdown 30 seconds', '', 30_000],
    ['set timer for 2 hours', '', 120 * MIN],
    ['could you set a timer for ten minutes please?', '', 10 * MIN],
    ['Hey Nibo, start a 3 minute timer', '', 3 * MIN],
  ];
  for (const [text, what, ms] of cases) {
    const d = set(text);
    assert.equal(d.kind, 'timer', text);
    assert.equal(d.text, what, text);
    assert.equal(d.due.getTime() - NOW.getTime(), ms, text);
  }
  assert.equal(set('timer for 6pm').due.getTime(), at(10, 7, 18).getTime());
});

test('asks when it is missing something', () => {
  assert.deepEqual(detect('remind me to call mum'), { type: 'ask-when', kind: 'reminder', text: 'call mum', connector: 'to' });
  assert.deepEqual(detect('remind me'), { type: 'ask-when', kind: 'reminder', text: '', connector: '' });
  assert.deepEqual(detect('set a reminder'), { type: 'ask-when', kind: 'reminder', text: '', connector: '' });
  assert.deepEqual(detect('set a timer'), { type: 'ask-when', kind: 'timer', text: '', connector: '' });
  assert.equal(detect('remind me to catch the 6pm train').type, 'ask-when');
});

test('says when a time is not usable', () => {
  assert.equal(detect('remind me to swim this morning').reason, 'past');
  assert.equal(detect('remind me in 0 minutes').reason, 'zero');
  assert.equal(detect('remind me in 500 years to relax').reason, 'far');
  assert.equal(detect('remind me on feb 30 to call mum').reason, 'baddate');
  assert.match(reminders.badTimeText('past'), /already passed/);
  assert.match(reminders.badTimeText('far'), /too far/);
  assert.match(reminders.badTimeText('nonsense'), /already passed/);
});

test('does not mistake other talk for a request', () => {
  for (const text of [
    'remind me how to tie a tie',
    'remind me of a good movie',
    'what does this remind me of',
    'my timer is broken',
    'what is a timer',
    'how do I set a timer for 5 minutes?',
    'how do I set a reminder?',
    'open spotify',
    'tell me a joke',
    'what time is it',
    'hello',
    '',
  ]) {
    assert.equal(detect(text), null, text);
  }
  assert.equal(detect(`remind me ${'to do things '.repeat(40)} in 5 minutes`), null, 'very long text');
});

test("doesn't pretend to repeat reminders", () => {
  assert.deepEqual(detect('remind me every day at 9 to take pills'), { type: 'unsupported', reason: 'repeat' });
  assert.deepEqual(detect('remind me to feed the cat each morning'), { type: 'unsupported', reason: 'repeat' });
  // "every" inside the thing to remember is fine.
  assert.equal(detect('remind me to say hi to everyone in 5 minutes').type, 'set');
  assert.equal(detect('remind me to give each kid a hug at 5').type, 'set');
});

test('lists, cancels and snoozes', () => {
  for (const text of ['what reminders do I have?', 'show my timers', 'list my reminders', 'any reminders?', 'my reminders', 'how long is left on the timer?']) {
    assert.deepEqual(detect(text), { type: 'list' }, text);
  }
  assert.deepEqual(detect('cancel the timer'), { type: 'cancel', kind: 'timer', all: false, text: '' });
  assert.deepEqual(detect('stop the timer'), { type: 'cancel', kind: 'timer', all: false, text: '' });
  assert.deepEqual(detect('cancel all reminders'), { type: 'cancel', kind: 'reminder', all: true, text: '' });
  assert.deepEqual(detect('cancel my reminders'), { type: 'cancel', kind: 'reminder', all: true, text: '' });
  assert.deepEqual(detect('delete the reminder to call mum'), { type: 'cancel', kind: 'reminder', all: false, text: 'call mum' });
  assert.deepEqual(detect('cancel the pasta timer'), { type: 'cancel', kind: 'timer', all: false, text: 'pasta' });
  assert.deepEqual(detect('never mind the timer'), { type: 'cancel', kind: 'timer', all: false, text: '' });

  assert.deepEqual(detect('snooze'), { type: 'snooze', ms: 5 * MIN });
  assert.deepEqual(detect('snooze for 10 minutes'), { type: 'snooze', ms: 10 * MIN });
  assert.deepEqual(detect('remind me again in 10 minutes'), { type: 'snooze', ms: 10 * MIN });
  assert.deepEqual(detect('remind me later'), { type: 'snooze', ms: 10 * MIN });
  assert.deepEqual(detect('give me 5 more minutes'), { type: 'snooze', ms: 5 * MIN });
  assert.deepEqual(detect('5 more minutes'), { type: 'snooze', ms: 5 * MIN });
  assert.deepEqual(detect('give me another 15 minutes'), { type: 'snooze', ms: 15 * MIN });
});

test('a bare time answers "when?"', () => {
  const pending = { kind: 'reminder', text: 'call mum', connector: 'to' };
  for (const [reply, due] of [
    ['in 10 minutes', NOW.getTime() + 10 * MIN],
    ['10 minutes', NOW.getTime() + 10 * MIN],
    ['10', NOW.getTime() + 10 * MIN],
    ['at 6pm please', at(10, 7, 18).getTime()],
    ['tomorrow at 9', at(10, 8, 9).getTime()],
    ['make it an hour', NOW.getTime() + 60 * MIN],
  ]) {
    const d = detect(reply, { pending });
    assert.equal(d.type, 'set', reply);
    assert.equal(d.text, 'call mum');
    assert.equal(d.connector, 'to');
    assert.equal(d.due.getTime(), due, reply);
  }
  // Anything else is just a new message.
  assert.equal(detect('what is the weather', { pending }), null);
  assert.equal(detect('tell me a joke', { pending }), null);
  assert.equal(detect('cancel the timer', { pending }).type, 'cancel');

  // A timer waiting for its length.
  const timer = detect('10', { pending: { kind: 'timer', text: '' } });
  assert.equal(timer.kind, 'timer');
  assert.equal(timer.due.getTime(), NOW.getTime() + 10 * MIN);
  // A reminder waiting for both parts.
  const both = detect('call mum in 20 minutes', { pending: { kind: 'reminder', text: '' } });
  assert.equal(both.text, 'call mum');
  assert.equal(both.due.getTime(), NOW.getTime() + 20 * MIN);
  // A time that is no good is explained.
  assert.equal(detect('at 1pm today', { pending: { kind: 'reminder', text: 'x' } }).reason, 'past');
});

test('the Remind me… prompt takes "call mum in 20 min" and "5 minutes"', () => {
  const prompt = (text) => reminders.detectFromPrompt(text, { now: NOW });
  assert.equal(prompt('5 minutes').kind, 'timer');
  assert.equal(prompt('5 minutes').due.getTime(), NOW.getTime() + 5 * MIN);
  assert.equal(prompt('6pm').kind, 'reminder');
  assert.equal(prompt('call mum in 20 min').text, 'call mum');
  assert.equal(prompt('at 6pm stretch').text, 'stretch');
  assert.equal(prompt('tomorrow at 9 dentist').text, 'dentist');
  assert.equal(prompt('call mum').type, 'ask-when');
  assert.equal(prompt('timer for 10 minutes').kind, 'timer');
  assert.equal(prompt('remind me to nap in 5 minutes').text, 'nap');
  assert.equal(prompt('cancel the timer').type, 'cancel');
  assert.equal(prompt(''), null);
});

test('reads the time out of a phrase for the AI tool', () => {
  const parse = (phrase, opts) => reminders.parsePhrase(phrase, { now: NOW, ...opts });
  assert.equal(parse('in 20 minutes').due.getTime(), NOW.getTime() + 20 * MIN);
  assert.equal(parse('20').due.getTime(), NOW.getTime() + 20 * MIN);
  assert.equal(parse('tomorrow at 9am').due.getTime(), at(10, 8, 9).getTime());
  assert.equal(parse('friday at 5pm').due.getTime(), at(10, 9, 17).getTime());
  assert.equal(parse('half an hour').due.getTime(), NOW.getTime() + 30 * MIN);
  assert.equal(parse('5 minutes', { timer: true }).due.getTime(), NOW.getTime() + 5 * MIN);
  assert.equal(parse('gibberish'), null);
  assert.equal(parse('in 0 minutes').ok, false);
});

// ---------- the notebook ----------

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nibo-reminders-')), 'reminders.json');
}

test('the notebook keeps reminders in order, and remembers them', () => {
  const file = tmpFile();
  const book = new reminders.ReminderBook(file, { now: () => NOW.getTime() });
  const late = book.add({ kind: 'reminder', text: 'later', due: NOW.getTime() + 60 * MIN });
  const soon = book.add({ kind: 'timer', text: 'soon', due: NOW.getTime() + 5 * MIN });
  assert.deepEqual(book.list().map((i) => i.text), ['soon', 'later']);
  assert.match(soon.id, /^[0-9a-f]{8}$/);
  assert.notEqual(soon.id, late.id);
  assert.equal(book.get(soon.id).kind, 'timer');
  assert.equal(soon.created, NOW.getTime());

  const again = new reminders.ReminderBook(file);
  assert.deepEqual(again.list(), book.list());

  assert.equal(book.remove('nope'), null);
  assert.equal(book.remove(soon.id).text, 'soon');
  assert.deepEqual(new reminders.ReminderBook(file).list().map((i) => i.text), ['later']);
});

test('the notebook hands over what is due, once', () => {
  const file = tmpFile();
  const book = new reminders.ReminderBook(file);
  book.add({ kind: 'reminder', text: 'b', due: NOW.getTime() + 2 * MIN });
  book.add({ kind: 'timer', text: 'a', due: NOW.getTime() + 1 * MIN });
  book.add({ kind: 'reminder', text: 'c', due: NOW.getTime() + 30 * MIN });
  assert.deepEqual(book.takeDue(NOW.getTime()), []);
  assert.deepEqual(book.takeDue(NOW.getTime() + 2 * MIN).map((i) => i.text), ['a', 'b']);
  assert.deepEqual(book.takeDue(NOW.getTime() + 2 * MIN), []);
  // What was handed over is gone from the disk too, so it can't ring twice.
  assert.deepEqual(new reminders.ReminderBook(file).list().map((i) => i.text), ['c']);
});

test('the notebook can clear one kind or everything', () => {
  const book = new reminders.ReminderBook(tmpFile());
  book.add({ kind: 'reminder', text: 'r1', due: NOW.getTime() + MIN });
  book.add({ kind: 'reminder', text: 'r2', due: NOW.getTime() + 2 * MIN });
  book.add({ kind: 'timer', text: 't1', due: NOW.getTime() + 3 * MIN });
  assert.deepEqual(book.clear('timer').map((i) => i.text), ['t1']);
  assert.deepEqual(book.list().map((i) => i.text), ['r1', 'r2']);
  assert.deepEqual(book.clear().map((i) => i.text), ['r1', 'r2']);
  assert.deepEqual(book.clear(), []);
  assert.deepEqual(book.list(), []);
});

test('the notebook has a limit and survives a damaged file', () => {
  const file = tmpFile();
  const book = new reminders.ReminderBook(file);
  for (let i = 0; i < reminders.MAX_ACTIVE; i++) assert.ok(book.add({ text: `n${i}`, due: NOW.getTime() + (i + 1) * MIN }));
  assert.equal(book.add({ text: 'one too many', due: NOW.getTime() + MIN }), null);
  assert.equal(book.add({ text: 'no time at all' }), null);

  fs.writeFileSync(file, '{ not json');
  assert.deepEqual(new reminders.ReminderBook(file).list(), []);
  fs.writeFileSync(
    file,
    JSON.stringify({
      items: [
        { id: 'abc12345', kind: 'timer', text: 'ok', due: 5, created: 1 },
        { id: 'abc12345', kind: 'timer', text: 'duplicate id', due: 6 },
        { id: '../../etc', kind: 'nonsense', text: 'x'.repeat(1000), due: '7' },
        { text: 'no due' },
        'garbage',
        null,
      ],
    }),
  );
  const loaded = new reminders.ReminderBook(file).list();
  assert.equal(loaded.length, 2);
  assert.deepEqual(loaded[0], { id: 'abc12345', kind: 'timer', text: 'ok', due: 5, created: 1 });
  assert.equal(loaded[1].kind, 'reminder');
  assert.equal(loaded[1].text.length, reminders.MAX_TEXT);
  assert.match(loaded[1].id, /^[0-9a-f]{8}$/);
});

// ---------- what Nibo says ----------

function items() {
  const book = new reminders.ReminderBook(tmpFile(), { now: () => NOW.getTime() });
  return [
    book.add({ kind: 'reminder', text: 'call mum', due: NOW.getTime() + 20 * MIN }),
    book.add({ kind: 'timer', text: 'the pasta', due: NOW.getTime() + 5 * MIN }),
    book.add({ kind: 'reminder', text: '', due: at(10, 8, 16, 30).getTime() }),
  ];
}

test('confirms what was set, with the time', () => {
  const [call, pasta, plain] = items();
  const clock = (ms) => require('../src/main/when').formatClock(new Date(ms));
  assert.equal(reminders.confirmText(call, { connector: 'to' }, NOW), `Okay! I'll remind you to call mum in 20 minutes (${clock(call.due)}). ⏰`);
  assert.equal(reminders.confirmText(call, { connector: 'about' }, NOW).includes('remind you about call mum'), true);
  assert.equal(reminders.confirmText(pasta, {}, NOW), `Timer set for 5 minutes (the pasta)! ⏱️ I'll shout at ${clock(pasta.due)}.`);
  assert.equal(reminders.confirmText(plain, {}, NOW), `Okay! I'll remind you tomorrow at ${clock(plain.due)}. ⏰`);
  const day = { ...pasta, due: NOW.getTime() + 3 * 86_400_000, text: '' };
  assert.match(reminders.confirmText(day, {}, NOW), /^Timer set: .* at .*! ⏱️$/);
});

test('asks "when?" with quick answers', () => {
  const reminder = reminders.askWhen({ kind: 'reminder', text: 'call mum', connector: 'to' });
  assert.match(reminder.text, /When should I remind you to “call mum”\?/);
  assert.deepEqual(reminder.actions.map((a) => a.arg), [
    'remind me to call mum in 10 minutes',
    'remind me to call mum in 1 hour',
    'remind me to call mum tomorrow at 9am',
  ]);
  // The buttons say things Nibo understands.
  for (const a of reminder.actions) assert.equal(detect(a.arg).type, 'set', a.arg);

  const timer = reminders.askWhen({ kind: 'timer', text: 'the pasta' });
  assert.match(timer.text, /How long should the timer for “the pasta” run/);
  assert.equal(timer.actions.length, 4);
  for (const a of timer.actions) assert.equal(detect(a.arg).kind, 'timer', a.arg);

  assert.match(reminders.askWhen({ kind: 'reminder', text: '' }).text, /What should I remind you about, and when/);
});

test('lists what is coming up, with a button to cancel each', () => {
  const empty = reminders.describeList([], NOW.getTime());
  assert.match(empty.text, /not holding any reminders/);
  assert.deepEqual(empty.actions, []);

  const list = reminders.describeList(items(), NOW.getTime());
  const lines = list.text.split('\n');
  assert.equal(lines[0], "Here's what I'm keeping track of:");
  assert.match(lines[1], /^⏰ call mum: in 20 minutes/);
  assert.match(lines[2], /^⏱️ the pasta: in 5 minutes/);
  assert.match(lines[3], /^⏰ Reminder: tomorrow at /);
  assert.deepEqual(list.actions.map((a) => a.action), ['reminder-cancel', 'reminder-cancel', 'reminder-cancel', 'reminder-cancel-all']);
  assert.match(list.actions[0].label, /^✖️ call mum/);

  const many = Array.from({ length: 8 }, (_, i) => ({ id: `id${i}`, kind: 'reminder', text: `thing number ${i} that is quite long`, due: NOW.getTime() + (i + 1) * MIN }));
  const long = reminders.describeList(many, NOW.getTime());
  assert.match(long.text, /…and 2 more/);
  assert.equal(long.actions.length, 5);
  assert.ok(long.actions[0].label.length < 24);
});

test('announces what is due, and says sorry when it is late', () => {
  const [call, pasta, plain] = items();
  assert.deepEqual(reminders.alertContent([call], call.due + 1000), { text: '⏰ Reminder: call mum', speech: 'Reminder: call mum.' });
  assert.deepEqual(reminders.alertContent([pasta], pasta.due), { text: "⏱️ Time's up: the pasta", speech: "Time's up! The pasta." });
  assert.deepEqual(reminders.alertContent([{ ...pasta, text: '' }], pasta.due), { text: "⏱️ Time's up!", speech: "Time's up!" });
  assert.deepEqual(reminders.alertContent([{ ...call, text: '' }], call.due), { text: '⏰ Here is your reminder!', speech: 'Here is your reminder!' });

  const late = reminders.alertContent([call], call.due + 3 * 3_600_000);
  assert.match(late.text, /^⏰ Reminder: call mum \(that was due at .*\)$/);
  assert.equal(late.speech, "Sorry I'm late! Reminder: call mum.");

  const several = reminders.alertContent([call, pasta, plain], call.due + 10_000);
  assert.match(several.text, /^Heads up! 🐰\n• ⏰ Reminder: call mum\n• ⏱️ Time's up: the pasta/);
  // The pasta timer was due 15 minutes before the call, so Nibo is late for it.
  assert.equal(several.speech, "Sorry I'm late! Heads up! Reminder: call mum. Time's up! The pasta. Here is your reminder!");
});

test('buttons can tell two plain timers apart', () => {
  const a = { id: 'a', kind: 'timer', text: '', due: NOW.getTime() + 5 * MIN };
  const b = { id: 'b', kind: 'timer', text: '', due: NOW.getTime() + 5 * MIN + 12_000 };
  assert.notEqual(reminders.chipLabel(a), reminders.chipLabel(b));
  assert.match(reminders.chipLabel(a), /^Timer \(.+\)$/);
  assert.equal(reminders.chipLabel({ kind: 'reminder', text: 'call mum', due: 1 }), 'call mum');
  assert.ok(reminders.chipLabel({ kind: 'reminder', text: 'x'.repeat(100), due: 1 }).length <= 18);
});

test('keeps a pile of reminders readable', () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ id: `id${i}`, kind: 'reminder', text: `thing ${i}`, due: NOW.getTime() }));
  const alert = reminders.alertContent(many, NOW.getTime());
  assert.equal(alert.text.split('\n').length, 1 + 5 + 1);
  assert.match(alert.text, /• ⏰ Reminder: thing 4\n…and 4 more$/);
  assert.equal(alert.speech, 'Heads up! Reminder: thing 0. Reminder: thing 1. Reminder: thing 2. And 6 more.');
});

test('finds the reminder a cancel request means', () => {
  const [call, pasta, plain] = items();
  const all = [call, pasta, plain];
  assert.deepEqual(reminders.matchItems(all, { kind: 'timer' }), [pasta]);
  assert.deepEqual(reminders.matchItems(all, { kind: 'reminder' }), [call, plain]);
  assert.deepEqual(reminders.matchItems(all, { kind: 'reminder', text: 'mum' }), [call]);
  assert.deepEqual(reminders.matchItems(all, { text: 'pasta' }), [pasta]);
  assert.deepEqual(reminders.matchItems(all, { text: 'unicorns' }), []);
  assert.deepEqual(reminders.matchItems(all, {}), all);
});
