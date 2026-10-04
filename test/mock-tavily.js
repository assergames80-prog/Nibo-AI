'use strict';

// A tiny fake Tavily search API for tests and the screenshot script.

const http = require('http');

function startMockTavily(options = {}) {
  const {
    validKey = 'tvly-test',
    answer = 'It is sunny and 21°C in Paris today.',
    results = [
      { title: 'Paris weather today', url: 'https://weather.example.com/paris', content: 'Sunny, 21°C, light breeze.', score: 0.9 },
      { title: 'Météo Paris', url: 'https://www.meteo.example.fr/paris', content: 'Ensoleillé, 21 degrés.', score: 0.8 },
      { title: 'Not a link', url: 'javascript:alert(1)', content: 'should be dropped' },
    ],
    status = null,
    delayMs = 0,
  } = options;
  const requests = [];

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      const body = raw ? JSON.parse(raw) : null;
      requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      const reply = (code, data) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      if (req.method !== 'POST' || req.url !== '/search') return reply(404, { detail: { error: 'Not found' } });
      if (status) return reply(status, { detail: { error: `mock error ${status}` } });
      if (req.headers.authorization !== `Bearer ${validKey}`) {
        return reply(401, { detail: { error: 'Unauthorized: missing or invalid API key.' } });
      }
      return reply(200, { query: body.query, answer: body.include_answer ? answer : null, results, response_time: 0.42 });
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        requests,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

module.exports = { startMockTavily };
