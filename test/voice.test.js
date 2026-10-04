'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const voice = require('../src/renderer/voice');

const RATE = 16000;
const CHUNK = 1024; // 64 ms

// A chunk of sine "voice" (or quiet noise) at roughly the given dBFS level.
function chunk(db, freq = 220) {
  const amp = Math.pow(10, db / 20) * Math.SQRT2;
  const out = new Float32Array(CHUNK);
  for (let i = 0; i < CHUNK; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / RATE);
  return out;
}

function feed(detector, db, ms) {
  const events = [];
  for (let t = 0; t < ms; t += 64) events.push(...detector.push(chunk(db)).filter((e) => e.type !== 'level'));
  return events;
}

test('measures loudness in dBFS', () => {
  assert.ok(Math.abs(voice.rmsDb(chunk(-20)) + 20) < 0.5);
  assert.ok(voice.rmsDb(new Float32Array(10)) < -150);
});

test('hears a spoken phrase, with pre-roll, and ends after a pause', () => {
  const d = voice.createDetector({ sampleRate: RATE });
  assert.deepEqual(feed(d, -70, 1000), []);
  const start = feed(d, -20, 1200);
  assert.deepEqual(start, [{ type: 'start', bargeIn: false }]);
  const end = feed(d, -70, 1200);
  assert.equal(end.length, 1);
  assert.equal(end[0].type, 'end');
  assert.ok(end[0].speechMs >= 1100);
  // pre-roll (~400 ms) + speech + trailing silence
  assert.ok(end[0].durationMs > 1500 && end[0].durationMs < 3000, `duration ${end[0].durationMs}`);
  assert.equal(end[0].samples.length, Math.round((end[0].durationMs / 1000) * RATE));
});

test('ignores clicks and throws away blips that are too short', () => {
  const d = voice.createDetector({ sampleRate: RATE });
  feed(d, -70, 1000);
  assert.deepEqual(feed(d, -20, 64), []); // one 64 ms click: no start
  feed(d, -70, 500);
  const events = [...feed(d, -20, 192), ...feed(d, -70, 1200)];
  assert.deepEqual(
    events.map((e) => e.type),
    ['start', 'discard'],
  );
});

test("learns the room first, so a fan that's already running isn't speech", () => {
  const d = voice.createDetector({ sampleRate: RATE });
  assert.deepEqual(feed(d, -42, 4000), []);
  assert.ok(d.floor > -45, `floor ${d.floor}`);
  assert.deepEqual(feed(d, -15, 500), [{ type: 'start', bargeIn: false }]);
});

test('a hum that starts later is dropped once it proves to be steady', () => {
  const d = voice.createDetector({ sampleRate: RATE });
  feed(d, -70, 1000);
  const events = feed(d, -35, 3000);
  assert.deepEqual(
    events.map((e) => e.type),
    ['start', 'discard'],
  );
  assert.ok(d.floor > -40, `floor ${d.floor}`);
  assert.deepEqual(feed(d, -35, 3000), []); // now it's just background
});

test("Nibo's own voice in the speakers doesn't count as the user", () => {
  const d = voice.createDetector({ sampleRate: RATE });
  feed(d, -70, 1000);
  d.setNiboSpeaking(true);
  // His voice leaks into the mic at -32 dB the whole time he talks.
  assert.deepEqual(feed(d, -32, 3000), []);
  // A user speaking only as loud as the leak isn't treated as an interruption...
  assert.deepEqual(feed(d, -30, 600), []);
  // ...but talking clearly over him is.
  assert.deepEqual(feed(d, -14, 600), [{ type: 'start', bargeIn: true }]);
});

test('no barge-in while it is still calibrating on his voice', () => {
  const d = voice.createDetector({ sampleRate: RATE });
  feed(d, -70, 1000);
  d.setNiboSpeaking(true);
  assert.deepEqual(feed(d, -14, 640), []); // first moment of a reply
});

test('back to normal after he stops talking (and the room goes quiet)', () => {
  const d = voice.createDetector({ sampleRate: RATE });
  feed(d, -70, 1000);
  d.setNiboSpeaking(true);
  feed(d, -32, 2000);
  d.setNiboSpeaking(false);
  feed(d, -70, 3000);
  assert.deepEqual(feed(d, -30, 500), [{ type: 'start', bargeIn: false }]);
});

test('encodes 16-bit mono WAV', () => {
  const wav = voice.encodeWav(new Float32Array([0, 1, -1, 0.5]), RATE);
  const view = new DataView(wav.buffer);
  assert.equal(String.fromCharCode(...wav.slice(0, 4)), 'RIFF');
  assert.equal(String.fromCharCode(...wav.slice(8, 12)), 'WAVE');
  assert.equal(view.getUint32(24, true), RATE);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), 8);
  assert.deepEqual([1, 2, 3, 4].map((i) => view.getInt16(42 + i * 2, true)), [0, 32767, -32768, 16383]);
});

test('spots Whisper phantoms', () => {
  assert.equal(voice.isPhantom('Thank you.', { speechMs: 600 }), true);
  assert.equal(voice.isPhantom('  ', { speechMs: 2000 }), true);
  assert.equal(voice.isPhantom('Nibo, the cute bunny assistant.', { speechMs: 3000 }), true);
  assert.equal(voice.isPhantom('Thank you.', { speechMs: 2500 }), false);
  assert.equal(voice.isPhantom('what time is it', { speechMs: 600 }), false);
});

test("spots echoes of Nibo's own words", () => {
  const said = 'Bunnies munch on hay, leafy greens and the occasional carrot treat!';
  assert.equal(voice.isEcho('munch on hay leafy greens', said), true);
  assert.equal(voice.isEcho('What about carrots for dogs?', said), false);
  assert.equal(voice.isEcho('stop', 'stop it bunny'), false);
  assert.equal(voice.isEcho('anything at all', ''), false);
});
