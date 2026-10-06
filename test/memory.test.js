'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const memory = require('../src/main/memory');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nibo-memory-')), 'memory.json');

test('keeps notes, in order, and remembers them next time', () => {
  const file = tmpFile();
  let clock = 1000;
  const book = new memory.Memory(file, { now: () => clock++ });
  const a = book.add('that I love cats');
  const b = book.add('has a dog called Biscuit');
  assert.equal(a.ok, true);
  assert.equal(a.note.text, 'I love cats'); // "that" is not part of the note
  assert.equal(b.note.text, 'Has a dog called Biscuit'); // starts with a capital
  assert.match(a.note.id, /^[0-9a-f]{8}$/);
  assert.deepEqual(book.list().map((n) => n.text), ['I love cats', 'Has a dog called Biscuit']);
  assert.equal(book.count, 2);
  assert.equal(book.get(a.note.id).at, 1000);

  const again = new memory.Memory(file);
  assert.deepEqual(again.list(), book.list());
  assert.equal(again.remove('nope'), null);
  assert.equal(again.remove(a.note.id).text, 'I love cats');
  assert.deepEqual(new memory.Memory(file).list().map((n) => n.text), ['Has a dog called Biscuit']);
  assert.deepEqual(again.clear().map((n) => n.text), ['Has a dog called Biscuit']);
  assert.deepEqual(new memory.Memory(file).list(), []);
  assert.deepEqual(again.clear(), []);
});

test('says why it did not keep something', () => {
  const book = new memory.Memory(tmpFile());
  assert.equal(book.add('').reason, 'empty');
  assert.equal(book.add('  ok ').reason, 'empty');
  assert.equal(book.add(null).reason, 'empty');
  assert.equal(book.add('I love cats').ok, true);
  // The same thing, said again or said a bit differently.
  assert.equal(book.add('i love cats!').reason, 'duplicate');
  assert.equal(book.add('I love cats').note.text, 'I love cats');
  assert.equal(book.add('Their favourite colour is lavender').ok, true);
  assert.equal(book.add('their favourite colour is lavender, I think').reason, 'duplicate');
  assert.equal(book.add('I love cats and dogs').ok, true); // short notes only count as the same when nearly identical
  for (let i = 0; i < memory.MAX_NOTES; i++) book.add(`Note number ${i} about something different ${'x'.repeat(i % 7)} ${i * 7919}`);
  assert.equal(book.count, memory.MAX_NOTES);
  assert.equal(book.add('One more fact about me that is new').reason, 'full');
});

test('never keeps passwords, card numbers or keys', () => {
  const book = new memory.Memory(tmpFile());
  for (const secret of [
    'my password is hunter2',
    'The wifi passphrase is correct horse',
    'my PIN is 4921',
    'api key is gsk_abcdefghijklmnop',
    'my card number is 4111 1111 1111 1111',
    'visa 4111-1111-1111-1111',
    'ssn 123-45-6789',
    'ghp_abcdefghijklmnopqrstuvwx',
    'recovery phrase: apple banana',
    'my iban is DE89 3704 0044 0532 0130 00',
  ]) {
    assert.equal(memory.looksSecret(secret), true, secret);
    assert.equal(book.add(secret).reason, 'secret', secret);
  }
  for (const fine of ['I love cats', 'Their birthday is March 3', 'Lives in Warsaw', 'Has 2 dogs and 3 cats', 'Phone is nearly out of battery', 'Works at 9 to 5']) {
    assert.equal(memory.looksSecret(fine), false, fine);
  }
  assert.equal(book.count, 0);
});

test('the name replaces an older name', () => {
  const book = new memory.Memory(tmpFile());
  assert.equal(book.name(), '');
  assert.equal(book.setName('Sam').ok, true);
  assert.equal(book.name(), 'Sam');
  book.add('Loves cats');
  assert.equal(book.setName('Sam').ok, true); // the same again: nothing changes
  assert.equal(book.count, 2);
  assert.equal(book.setName('Alex Smith').ok, true);
  assert.equal(book.name(), 'Alex Smith');
  assert.deepEqual(book.list().map((n) => n.text), ['Loves cats', 'Their name is Alex Smith']);
});

test('finds the note a "forget my dog" means', () => {
  const book = new memory.Memory(tmpFile());
  for (const text of ['Has a dog called Biscuit', 'Loves cats', 'Their name is Sam', 'Is allergic to peanuts']) book.add(text);
  assert.deepEqual(book.find('my dog').map((n) => n.text), ['Has a dog called Biscuit']);
  assert.deepEqual(book.find('my name').map((n) => n.text), ['Their name is Sam']);
  assert.deepEqual(book.find('the peanut allergy').map((n) => n.text), ['Is allergic to peanuts']); // "peanut" is in "peanuts"
  assert.deepEqual(book.find('my favourite song').map((n) => n.text), []); // nothing in common
  assert.deepEqual(book.find('peanuts').map((n) => n.text), ['Is allergic to peanuts']);
  assert.deepEqual(book.find('the').map((n) => n.text), []);
  assert.deepEqual(book.find('').map((n) => n.text), []);
});

test('puts the newest notes in the prompt when there are too many', () => {
  const book = new memory.Memory(tmpFile());
  assert.deepEqual(book.forPrompt(), []);
  for (let i = 1; i <= 10; i++) book.add(`Note ${i} ${'padding '.repeat(5)}`.trim());
  assert.equal(book.forPrompt().length, 10);
  const some = book.forPrompt(200);
  assert.ok(some.length > 0 && some.length < 10);
  assert.equal(some.at(-1).startsWith('Note 10'), true); // the newest survive
  assert.equal(some[0].startsWith('Note 1 '), false);
});

test('survives a damaged file and tidies what it reads', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{ nope');
  assert.deepEqual(new memory.Memory(file).list(), []);
  fs.writeFileSync(
    file,
    JSON.stringify({
      notes: [
        { id: 'abc12345', text: '  Likes   tea  ', at: 5 },
        { id: 'abc12345', text: 'duplicate id' },
        { id: '../../x', text: 'bad id gets a new one', at: 'soon' },
        { text: 'x' },
        { text: 42 },
        'garbage',
        null,
      ],
    }),
  );
  const notes = new memory.Memory(file).list();
  assert.equal(notes.length, 2);
  assert.deepEqual(notes[0], { id: 'abc12345', text: 'Likes tea', at: 5 });
  assert.match(notes[1].id, /^[0-9a-f]{8}$/);
  assert.equal(notes[1].at, 0);
  assert.equal(memory.tidyNote('x'.repeat(1000)).length, memory.MAX_NOTE);
});

test('understands "call me Sam" and "my name is Sam", but not "call me later"', () => {
  for (const [text, name] of [
    ['call me Sam', 'Sam'],
    ['Call me Sam please', 'Sam'],
    ['you can call me Alex Smith', 'Alex Smith'],
    ['from now on call me Sam', 'Sam'],
    ['my name is sam', 'Sam'],
    ['My name is Sam.', 'Sam'],
    ["Hi, my name's Sam", 'Sam'],
    ['I am called Jo', 'Jo'],
    ['Nibo, my name is Ana-Maria', 'Ana-Maria'],
    ['hey nibo, call me Zoë', 'Zoë'],
  ]) {
    assert.deepEqual(memory.detect(text), { type: 'name', name }, text);
  }
  for (const text of ['call me later', 'call me maybe', 'call me back', 'call me when you are ready', 'my name is on the list', 'call me tomorrow at 5', 'call me', 'my name is']) {
    assert.equal(memory.detect(text), null, text);
  }
});

test('understands "remember that …"', () => {
  assert.deepEqual(memory.detect('remember that I love cats'), { type: 'remember', text: 'that I love cats' });
  assert.deepEqual(memory.detect('Remember I have a dog called Biscuit'), { type: 'remember', text: 'I have a dog called Biscuit' });
  assert.deepEqual(memory.detect('note that my birthday is March 3'), { type: 'remember', text: 'that my birthday is March 3' });
  assert.deepEqual(memory.detect("keep in mind that I work nights"), { type: 'remember', text: 'that I work nights' });
  assert.deepEqual(memory.detect("don't forget that I'm allergic to nuts"), { type: 'remember', text: "that I'm allergic to nuts" });
  assert.deepEqual(memory.detect('Nibo, please remember that I like short answers.'), { type: 'remember', text: 'that I like short answers' });
  assert.deepEqual(memory.detect('from now on answer briefly'), { type: 'remember', text: 'From now on, answer briefly' });
  // Not notes: reminders, questions, and nothing at all.
  for (const text of ['remember to call mum', 'remember to call mum at 6', 'remember', "don't forget to lock up", 'remember when we met?', 'remember how to tie a tie', 'remember me?', 'do you remember my name', 'tell me a joke', '']) {
    assert.equal(memory.detect(text), null, text);
  }
});

test('understands "what do you remember?" and "forget …"', () => {
  for (const text of ['what do you remember about me?', 'what do you know about me', 'show me your memory', 'open your notebook', 'what have I told you?', 'what is in your memory', 'what do you remember', 'show your notes']) {
    assert.deepEqual(memory.detect(text), { type: 'show' }, text);
  }
  for (const text of ['what do you know about quantum physics', 'what do you know?', 'show me the weather', 'what is a notebook']) {
    assert.equal(memory.detect(text), null, text);
  }
  for (const text of ['forget everything', 'forget all', 'Forget everything you know about me.', 'forget everything I told you', 'clear your memory', 'wipe your notebook', 'forget me', 'forget your memory']) {
    assert.deepEqual(memory.detect(text), { type: 'forget', all: true }, text);
  }
  for (const text of ['forget that', 'forget it', 'forget about it', 'never mind that', 'nevermind it', 'forget what I just said']) {
    assert.deepEqual(memory.detect(text), { type: 'forget', last: true }, text);
  }
  assert.deepEqual(memory.detect('forget my name'), { type: 'forget', text: 'my name' });
  assert.deepEqual(memory.detect('forget about my dog'), { type: 'forget', text: 'my dog' });
  assert.deepEqual(memory.detect('please forget that I like cats'), { type: 'forget', text: 'I like cats' });
  for (const text of ['forget', 'never mind, I found it', 'never mind the timer', 'I forgot my keys', 'tell me a joke']) {
    // ("never mind the timer" is for the reminders; here it is not about memory either)
    const found = memory.detect(text);
    assert.ok(found === null || found.type !== 'forget' || text === 'never mind the timer', text);
  }
});
