'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Groq } = require('groq-sdk');
const { Brain, reasoningParams, choosePreferred, testKey } = require('../src/main/brain');
const { startMockGroq } = require('./mock-groq');

function makeBrain(mock, overrides = {}) {
  let model = overrides.model || 'openai/gpt-oss-20b';
  const brain = new Brain({
    getApiKey: () => ('apiKey' in overrides ? overrides.apiKey : 'gsk_test'),
    getModel: () => model,
    setModel: (m) => (model = m),
    createClient: (apiKey) => new Groq({ apiKey, baseURL: mock.url, maxRetries: 0 }),
  });
  return { brain, getModel: () => model };
}

test('streams an answer from Groq and remembers the chat', async () => {
  const mock = await startMockGroq({ reply: 'Carrots are crunchy and delicious!' });
  try {
    const { brain } = makeBrain(mock);
    const deltas = [];
    const res = await brain.ask('Tell me about carrots', {
      status: { mood: 'happy', fullness: 80, localTime: 'noon' },
      onDelta: (d) => deltas.push(d),
    });
    assert.equal(res.ok, true);
    assert.equal(res.text, 'Carrots are crunchy and delicious!');
    assert.ok(deltas.length > 1, 'expected several streamed chunks');
    assert.equal(deltas.join(''), 'Carrots are crunchy and delicious!');

    const req = mock.requests.at(-1);
    assert.equal(req.auth, 'Bearer gsk_test');
    assert.equal(req.body.stream, true);
    assert.equal(req.body.model, 'openai/gpt-oss-20b');
    assert.equal(req.body.reasoning_effort, 'low');
    assert.equal(req.body.messages[0].role, 'system');
    assert.match(req.body.messages[0].content, /Nibo/);
    assert.match(req.body.messages.at(-2).content, /80% full/);
    assert.deepEqual(req.body.messages.at(-1), { role: 'user', content: 'Tell me about carrots' });

    await brain.ask('And again?');
    const second = mock.requests.at(-1).body.messages;
    assert.deepEqual(
      second.filter((m) => m.role !== 'system').map((m) => m.role),
      ['user', 'assistant', 'user'],
    );
  } finally {
    await mock.close();
  }
});

test('keeps history bounded', async () => {
  const mock = await startMockGroq({ reply: 'ok', chunkDelayMs: 0 });
  try {
    const { brain } = makeBrain(mock);
    for (let i = 0; i < 12; i++) await brain.ask(`question ${i}`);
    assert.equal(brain.history.length, 16);
    assert.equal(brain.history[0].content, 'question 4');
  } finally {
    await mock.close();
  }
});

test('a bad key gives a friendly message', async () => {
  const mock = await startMockGroq({ status: 401 });
  try {
    const { brain } = makeBrain(mock);
    const res = await brain.ask('hi');
    assert.equal(res.ok, false);
    assert.equal(res.kind, 'auth');
    assert.match(res.error, /Groq API key/);
  } finally {
    await mock.close();
  }
});

test('switches to another model when the configured one is gone', async () => {
  const mock = await startMockGroq({
    reply: 'Still here!',
    missingModels: ['retired-model'],
    models: ['whisper-large-v3', 'llama-3.1-8b-instant'],
  });
  try {
    const { brain, getModel } = makeBrain(mock, { model: 'retired-model' });
    const res = await brain.ask('hello?');
    assert.equal(res.ok, true);
    assert.equal(res.text, 'Still here!');
    assert.equal(getModel(), 'llama-3.1-8b-instant');
    assert.equal(mock.requests.at(-1).body.reasoning_effort, undefined);
  } finally {
    await mock.close();
  }
});

test('can be cancelled mid-stream', async () => {
  const mock = await startMockGroq({ reply: 'one two three four five six seven eight', chunkDelayMs: 40 });
  try {
    const { brain } = makeBrain(mock);
    const controller = new AbortController();
    const res = await brain.ask('long story please', {
      signal: controller.signal,
      onDelta: () => controller.abort(),
    });
    assert.equal(res.ok, false);
    assert.equal(res.aborted, true);
    assert.equal(brain.history.length, 0);
  } finally {
    await mock.close();
  }
});

test('without a key the brain declines politely', async () => {
  const { brain } = makeBrain({ url: 'http://127.0.0.1:9' }, { apiKey: null });
  assert.equal(brain.hasKey(), false);
  assert.deepEqual(await brain.ask('hi'), { ok: false, error: 'no-key' });
});

test('testKey lists chat models only', async () => {
  const mock = await startMockGroq();
  try {
    const res = await testKey('gsk_test', (k) => new Groq({ apiKey: k, baseURL: mock.url, maxRetries: 0 }));
    assert.deepEqual(res, { ok: true, models: ['llama-3.1-8b-instant', 'openai/gpt-oss-20b'] });
  } finally {
    await mock.close();
  }
});

test('model helpers', () => {
  assert.deepEqual(reasoningParams('openai/gpt-oss-20b'), { reasoning_effort: 'low', include_reasoning: false });
  assert.deepEqual(reasoningParams('llama-3.3-70b-versatile'), {});
  assert.equal(choosePreferred(['whisper-large-v3', 'some-new-model']), 'some-new-model');
  assert.equal(choosePreferred(['llama-3.3-70b-versatile', 'llama-3.1-8b-instant']), 'llama-3.3-70b-versatile');
  assert.equal(choosePreferred([]), null);
});
