'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawn } = require('child_process');
const { WindowsVoice, SAMPLE_RATE } = require('../src/main/tts');

const fake = () => spawn(process.execPath, [path.join(__dirname, 'fake-voice-helper.js')], { stdio: ['pipe', 'pipe', 'pipe'] });

test('only offered on Windows', () => {
  assert.equal(new WindowsVoice({ platform: 'linux' }).available(), false);
  assert.equal(new WindowsVoice({ platform: 'win32', spawnHelper: fake }).available(), true);
});

test('renders sentences through the helper, in order, with unicode intact', async () => {
  const voice = new WindowsVoice({ platform: 'win32', spawnHelper: fake });
  try {
    const [a, b] = await Promise.all([voice.synthesize('Hello there!'), voice.synthesize('Héllo bünny 🐰, "quotes" & stuff')]);
    assert.equal(a.sampleRate, SAMPLE_RATE);
    assert.equal(a.pcm.toString('utf8'), 'Hello there!');
    assert.equal(b.pcm.toString('utf8'), 'Héllo bünny 🐰, "quotes" & stuff');
  } finally {
    voice.stop();
  }
});

test('reports helper errors and survives a helper crash', async () => {
  const voice = new WindowsVoice({ platform: 'win32', spawnHelper: fake });
  try {
    await assert.rejects(voice.synthesize('fail'), /No voice installed/);
    await assert.rejects(voice.synthesize('crash'), /exited/);
    const again = await voice.synthesize('back again');
    assert.equal(again.pcm.toString('utf8'), 'back again');
  } finally {
    voice.stop();
  }
});

test('gives up for good when the helper cannot start', async () => {
  const voice = new WindowsVoice({
    platform: 'win32',
    spawnHelper: () => spawn('definitely-not-a-real-program-nibo', [], { stdio: ['pipe', 'pipe', 'pipe'] }),
  });
  await assert.rejects(voice.synthesize('hi'));
  assert.equal(voice.available(), false);
});

// The real PowerShell helper, on Windows (GitHub's Windows runner runs this).
test('the real Windows voice helper renders speech', { skip: process.platform !== 'win32', timeout: 90_000 }, async (t) => {
  const voice = new WindowsVoice();
  try {
    let begin = Date.now();
    await voice.start(); // must really start: a timeout here is a bug, not "no voices"
    t.diagnostic(`helper started in ${Date.now() - begin} ms`);
    begin = Date.now();
    try {
      const { pcm, sampleRate } = await voice.synthesize('Hi! I am Nibo, your bunny buddy.');
      t.diagnostic(`rendered ${pcm.length} bytes in ${Date.now() - begin} ms`);
      assert.equal(sampleRate, SAMPLE_RATE);
      assert.ok(pcm.length > SAMPLE_RATE, `only ${pcm.length} bytes of audio`);
    } catch (err) {
      // Some server images have no voices installed; that's the only acceptable failure.
      t.diagnostic(`synthesis failed: ${err.message}`);
      assert.match(err.message, /no voice|not installed|voice.*available/i);
    }
  } finally {
    voice.stop();
  }
});
