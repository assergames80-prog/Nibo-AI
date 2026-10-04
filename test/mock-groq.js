'use strict';

// A tiny fake Groq API (OpenAI-style endpoints) for tests and screenshots.

const http = require('http');

function startMockGroq(options = {}) {
  const {
    reply = 'Hi! I am a mock bunny brain. 🐰',
    models = ['openai/gpt-oss-20b', 'llama-3.1-8b-instant', 'whisper-large-v3'],
    missingModels = [],
    status = null,
    chunkDelayMs = 5,
    // (body) => { name, arguments } | null: makes the model call a tool.
    toolCall = null,
    transcript = 'hello nibo',
    transcribeStatus = null,
  } = options;
  const requests = [];

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      const isJson = /json/.test(req.headers['content-type'] || '');
      const body = raw && isJson ? JSON.parse(raw) : null;
      requests.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });

      const fail = (code, message, extra = {}) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message, type: 'invalid_request_error', ...extra } }));
      };

      if (req.method === 'GET' && req.url.startsWith('/openai/v1/models')) {
        if (status === 401) return fail(401, 'Invalid API Key', { code: 'invalid_api_key' });
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(
          JSON.stringify({
            object: 'list',
            data: models.map((id) => ({ id, object: 'model', created: 0, owned_by: 'mock', active: true })),
          }),
        );
      }

      if (req.method === 'POST' && req.url.startsWith('/openai/v1/audio/transcriptions')) {
        requests.at(-1).multipart = raw;
        if (transcribeStatus) return fail(transcribeStatus, `mock error ${transcribeStatus}`);
        res.writeHead(200, { 'content-type': 'application/json' });
        const said = typeof transcript === 'function' ? transcript(requests.filter((r) => r.multipart).length) : transcript;
        return res.end(JSON.stringify({ text: ` ${said} ` }));
      }

      if (req.method === 'POST' && req.url.startsWith('/openai/v1/chat/completions')) {
        if (status) return fail(status, `mock error ${status}`);
        if (missingModels.includes(body.model)) {
          return fail(404, `The model \`${body.model}\` does not exist or you do not have access to it.`, {
            code: 'model_not_found',
          });
        }
        const replyText = () => (typeof reply === 'function' ? reply(body) : reply);
        if (!body.stream) {
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(
            JSON.stringify({
              id: 'mock',
              object: 'chat.completion',
              created: 0,
              model: body.model,
              choices: [{ index: 0, message: { role: 'assistant', content: replyText() }, finish_reason: 'stop' }],
            }),
          );
        }
        const call = toolCall && body.tools && body.tool_choice !== 'none' ? toolCall(body) : null;
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        const send = (delta, finish = null) =>
          res.write(
            `data: ${JSON.stringify({
              id: 'mock',
              object: 'chat.completion.chunk',
              created: 0,
              model: body.model,
              choices: [{ index: 0, delta, finish_reason: finish }],
            })}\n\n`,
          );
        send({ role: 'assistant', content: '' });
        if (call) {
          send({ content: 'Let me check! ' });
          send({ tool_calls: [{ index: 0, id: 'call_mock', type: 'function', function: { name: call.name, arguments: '' } }] });
          send({ tool_calls: [{ index: 0, function: { arguments: call.arguments } }] });
          send({}, 'tool_calls');
          res.write('data: [DONE]\n\n');
          return res.end();
        }
        for (const piece of replyText().match(/\S+\s*/g) || []) {
          send({ content: piece });
          await new Promise((r) => setTimeout(r, chunkDelayMs));
        }
        send({}, 'stop');
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      fail(404, 'not found');
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

module.exports = { startMockGroq };
