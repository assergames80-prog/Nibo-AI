'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const offline = require('../src/main/offline');

const first = () => 0;

test('safe math evaluation', () => {
  assert.equal(offline.evaluate('2 + 2 * 3'), 8);
  assert.equal(offline.evaluate('(2 + 2) * 3'), 12);
  assert.equal(offline.evaluate('2 ^ 3 ^ 2'), 512);
  assert.equal(offline.evaluate('-2^2'), -4);
  assert.equal(offline.evaluate('7 % 4'), 3);
  assert.equal(offline.evaluate('1 / 3'), 0.3333333333);
  assert.equal(offline.evaluate('5 x 3'), 15);
  assert.equal(offline.evaluate('1 / 0'), null);
  assert.equal(offline.evaluate('2 +'), null);
  assert.equal(offline.evaluate('alert(1)'), null);
  assert.equal(offline.evaluate('(1 + 2'), null);
});

test('answers math questions offline', () => {
  assert.match(offline.answer("what's 12 * 12?").text, /= 144/);
  assert.match(offline.answer('calculate (3+4)*2').text, /= 14/);
});

test('detects search requests', () => {
  assert.equal(offline.detectSearch('search for fluffy bunnies'), 'fluffy bunnies');
  assert.equal(offline.detectSearch('Search the web for cake recipes?'), 'cake recipes');
  assert.equal(offline.detectSearch('google pancakes'), 'pancakes');
  assert.equal(offline.detectSearch('look up the weather in Paris'), 'the weather in Paris');
  assert.equal(offline.detectSearch('google is a big company'), null);
  assert.equal(offline.detectSearch('what is a rabbit?'), null);
});

test('builds search URLs safely', () => {
  assert.equal(offline.searchUrl('cats & dogs', 'google'), 'https://www.google.com/search?q=cats%20%26%20dogs');
  assert.equal(offline.searchUrl('x', 'duckduckgo'), 'https://duckduckgo.com/?q=x');
  assert.equal(offline.searchUrl('x', 'nope'), 'https://www.google.com/search?q=x');
});

test('offline brain has personality', () => {
  assert.equal(offline.answer('tell me a joke', { rand: first }).text, offline.JOKES[0]);
  assert.equal(offline.answer('fun fact please', { rand: first }).text, offline.FACTS[0]);
  assert.equal(offline.answer('cheer me up', { rand: first }).text, offline.COMPLIMENTS[0]);
  assert.match(offline.answer('how are you?', { mood: 'hungry' }).text, /hungry/i);
  assert.match(offline.answer('what time is it', { now: new Date(2026, 0, 1, 9, 5) }).text, /9:05/);
});

test('unknown questions offer search and settings', () => {
  const r = offline.answer('What is the capital of Mongolia?');
  assert.deepEqual(
    r.actions.map((a) => a.action),
    ['search', 'settings'],
  );
  assert.equal(r.actions[0].arg, 'What is the capital of Mongolia?');
});

test('organize sorts desktop items into silly piles', () => {
  const report = offline.organize(
    [
      { name: 'Chrome.lnk', isDir: false },
      { name: 'Steam.url', isDir: false },
      { name: 'taxes.pdf', isDir: false },
      { name: 'cat.jpg', isDir: false },
      { name: 'Projects', isDir: true },
      { name: 'desktop.ini', isDir: false },
      { name: 'mystery.xyz', isDir: false },
      { name: 'Chrome.lnk', isDir: false },
    ],
    first,
  );
  assert.equal(report.total, 6);
  assert.equal(report.piles[0].label, '🚀 Zoomy shortcuts');
  assert.deepEqual(report.piles[0].items, ['Chrome', 'Steam']);
  assert.match(report.text, /nothing was moved/);
  assert.doesNotMatch(report.text, /desktop\.ini/);
});

test('organize handles an empty desktop', () => {
  assert.match(offline.organize([]).text, /spotless/);
});
