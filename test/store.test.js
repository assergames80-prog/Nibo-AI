'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Store } = require('../src/main/store');

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nibo-store-'));
  return path.join(dir, 'settings.json');
}

const fakeCipher = {
  isAvailable: () => true,
  encrypt: (s) => Buffer.from(s.split('').reverse().join(''), 'utf8'),
  decrypt: (b) => b.toString('utf8').split('').reverse().join(''),
};

test('defaults when no file exists', () => {
  const s = new Store(tmpFile(), fakeCipher);
  assert.equal(s.get('searchEngine'), 'google');
  assert.equal(s.get('voice'), false);
});

test('persists settings and encrypts the API key', () => {
  const file = tmpFile();
  const s = new Store(file, fakeCipher);
  s.set({ voice: true });
  s.setApiKey('  gsk_secret123456  ');
  const raw = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(raw, /gsk_secret/);

  const again = new Store(file, fakeCipher);
  assert.equal(again.get('voice'), true);
  assert.equal(again.getApiKey(), 'gsk_secret123456');
  assert.equal(again.keyHint(), 'gsk_…3456');
  assert.equal(again.keySource(), 'settings');

  again.setApiKey('');
  assert.equal(new Store(file, fakeCipher).keySource(), process.env.GROQ_API_KEY ? 'env' : null);
});

test('falls back to the GROQ_API_KEY environment variable', () => {
  const old = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = 'gsk_from_env';
  try {
    const s = new Store(tmpFile(), fakeCipher);
    assert.equal(s.getApiKey(), 'gsk_from_env');
    assert.equal(s.keySource(), 'env');
  } finally {
    if (old === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = old;
  }
});

test('repairs a corrupt file and bad values', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{ not json');
  assert.equal(new Store(file, fakeCipher).get('model'), 'openai/gpt-oss-20b');
  fs.writeFileSync(file, JSON.stringify({ searchEngine: 'altavista' }));
  assert.equal(new Store(file, fakeCipher).get('searchEngine'), 'google');
});

test('keeps the Tavily key separately, encrypted, with its own env fallback', () => {
  const file = tmpFile();
  const s = new Store(file, fakeCipher);
  s.setApiKey('gsk_groq_key_1234');
  s.setSecret('tavily', 'tvly-secret-5678');
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /tvly-secret/);

  const again = new Store(file, fakeCipher);
  assert.equal(again.getSecret('tavily'), 'tvly-secret-5678');
  assert.equal(again.getApiKey(), 'gsk_groq_key_1234');
  assert.equal(again.secretHint('tavily'), 'tvly…5678');

  again.setSecret('tavily', '');
  const old = process.env.TAVILY_API_KEY;
  process.env.TAVILY_API_KEY = 'tvly-env';
  try {
    assert.equal(again.getSecret('tavily'), 'tvly-env');
    assert.equal(again.secretSource('tavily'), 'env');
    assert.equal(again.getApiKey(), 'gsk_groq_key_1234');
  } finally {
    if (old === undefined) delete process.env.TAVILY_API_KEY;
    else process.env.TAVILY_API_KEY = old;
  }
});

test('repairs an unknown mic sensitivity', () => {
  const file = tmpFile();
  fs.writeFileSync(file, JSON.stringify({ micSensitivity: 'deafening' }));
  assert.equal(new Store(file, fakeCipher).get('micSensitivity'), 'normal');
});
