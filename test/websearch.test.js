'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const web = require('../src/main/websearch');
const { startMockTavily } = require('./mock-tavily');

test('searches Tavily and cleans up the results', async () => {
  const mock = await startMockTavily();
  try {
    const res = await web.tavilySearch('tvly-test', 'weather in Paris', { baseUrl: mock.url });
    assert.equal(res.answer, 'It is sunny and 21°C in Paris today.');
    assert.deepEqual(
      res.results.map((r) => [r.title, r.site]),
      [
        ['Paris weather today', 'weather.example.com'],
        ['Météo Paris', 'meteo.example.fr'],
      ],
    );
    const req = mock.requests[0];
    assert.equal(req.auth, 'Bearer tvly-test');
    assert.deepEqual(req.body, {
      query: 'weather in Paris',
      search_depth: 'basic',
      topic: 'general',
      max_results: 5,
      include_answer: true,
    });
  } finally {
    await mock.close();
  }
});

test('turns API failures into friendly errors', async () => {
  const mock = await startMockTavily({ status: 432 });
  try {
    await assert.rejects(web.tavilySearch('tvly-test', 'x', { baseUrl: mock.url }), (err) => err.kind === 'limit');
    assert.deepEqual(await web.testTavilyKey('tvly-wrong', { baseUrl: mock.url }), {
      ok: false,
      error: "I've used up my Tavily searches for now. 😅 Try again later or check your Tavily plan.",
    });
  } finally {
    await mock.close();
  }
  const ok = await startMockTavily();
  try {
    assert.deepEqual(await web.testTavilyKey('tvly-test', { baseUrl: ok.url }), { ok: true });
    const bad = await web.testTavilyKey('tvly-wrong', { baseUrl: ok.url });
    assert.match(bad.error, /Tavily key doesn't work/);
  } finally {
    await ok.close();
  }
  const offline = await web.testTavilyKey('tvly-test', { baseUrl: 'http://127.0.0.1:9' });
  assert.match(offline.error, /couldn't reach the web/);
});

test('can be cancelled', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(web.tavilySearch('k', 'x', { baseUrl: 'http://127.0.0.1:9', signal: controller.signal }), {
    name: 'AbortError',
  });
});

test('formats results for the model and the bubble', () => {
  const search = {
    query: 'bunny facts',
    answer: 'Bunnies binky when happy.',
    results: [{ title: 'Rabbit facts', url: 'https://ex.com/r', site: 'ex.com', content: 'Rabbits do binkies.' }],
  };
  const text = web.formatForModel(search, new Date(2026, 9, 4));
  assert.match(text, /Web search results for "bunny facts"/);
  assert.match(text, /untrusted web content/);
  assert.match(text, /\[1\] Rabbit facts \(ex\.com\)\nRabbits do binkies\./);
  assert.deepEqual(web.sourcesOf(search), [{ title: 'Rabbit facts', url: 'https://ex.com/r', site: 'ex.com' }]);
  assert.equal(web.formatForBubble(search), 'Bunnies binky when happy. 🔎');
  assert.match(web.formatForBubble({ ...search, answer: null, results: [] }), /couldn't find anything/);
});
