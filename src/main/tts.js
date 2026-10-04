'use strict';

// Nibo's voice on Windows: the built-in Windows (SAPI) voices render each
// sentence to audio, which the renderer then plays itself. Audio played by
// Chromium can be removed from the microphone by its echo cancellation, so the
// user can talk over Nibo to interrupt him. (The Web Speech API plays straight
// through Windows instead, where echo cancellation can't see it.)
//
// A small PowerShell helper stays running and answers one line per request:
//   in:  "<id> <base64 utf-8 text>"
//   out: "<id> ok <base64 16-bit mono PCM>" | "<id> err <base64 message>"

const { spawn } = require('child_process');

const SAMPLE_RATE = 22050;
const START_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 10_000;

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
try { $synth.SelectVoiceByHints([System.Speech.Synthesis.VoiceGender]::Female) } catch {}
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(22050, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$utf8 = New-Object System.Text.UTF8Encoding($false)
$reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $utf8)
$out = [Console]::Out
$out.WriteLine('ready')
$out.Flush()
while ($true) {
  $line = $reader.ReadLine()
  if ($line -eq $null) { break }
  $sep = $line.IndexOf(' ')
  if ($sep -lt 1) { continue }
  $id = $line.Substring(0, $sep)
  try {
    $text = $utf8.GetString([Convert]::FromBase64String($line.Substring($sep + 1)))
    $stream = New-Object System.IO.MemoryStream
    $synth.SetOutputToAudioStream($stream, $format)
    $synth.Speak($text)
    $synth.SetOutputToNull()
    $out.WriteLine($id + ' ok ' + [Convert]::ToBase64String($stream.ToArray()))
  } catch {
    $synth.SetOutputToNull()
    $out.WriteLine($id + ' err ' + [Convert]::ToBase64String($utf8.GetBytes($_.Exception.Message)))
  }
  $out.Flush()
}
`;

function encodedCommand(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

class WindowsVoice {
  /**
   * opts.spawnHelper() -> ChildProcess   (injectable for tests)
   * opts.platform                         (defaults to process.platform)
   */
  constructor(opts = {}) {
    this.platform = opts.platform || process.platform;
    this.spawnHelper =
      opts.spawnHelper ||
      (() =>
        spawn(
          'powershell.exe',
          ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encodedCommand(SCRIPT)],
          { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
        ));
    this.child = null;
    this.ready = null;
    this.broken = false;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
  }

  available() {
    return this.platform === 'win32' && !this.broken;
  }

  start() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      let child;
      try {
        child = this.spawnHelper();
      } catch (err) {
        reject(err);
        return;
      }
      this.child = child;
      const timer = setTimeout(() => reject(new Error('voice helper did not start')), START_TIMEOUT_MS);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (data) => {
        this.buffer += data;
        let nl;
        while ((nl = this.buffer.indexOf('\n')) >= 0) {
          const line = this.buffer.slice(0, nl).replace(/\r$/, '');
          this.buffer = this.buffer.slice(nl + 1);
          if (line === 'ready') {
            clearTimeout(timer);
            resolve();
          } else {
            this.handleLine(line);
          }
        }
      });
      child.stderr.on('data', () => {}); // PowerShell chatter; failures surface as timeouts
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('exit', () => {
        clearTimeout(timer);
        reject(new Error('voice helper exited'));
        this.failAll(new Error('voice helper exited'));
        this.child = null;
        this.ready = null;
      });
    }).catch((err) => {
      this.broken = true;
      this.stop();
      throw err;
    });
    return this.ready;
  }

  handleLine(line) {
    const [id, status, payload = ''] = line.split(' ');
    const request = this.pending.get(id);
    if (!request) return;
    this.pending.delete(id);
    clearTimeout(request.timer);
    if (status === 'ok') request.resolve({ sampleRate: SAMPLE_RATE, pcm: Buffer.from(payload, 'base64') });
    else request.reject(new Error(Buffer.from(payload, 'base64').toString('utf8') || 'speech failed'));
  }

  failAll(err) {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(err);
    }
    this.pending.clear();
  }

  /** Resolves with { sampleRate, pcm } (16-bit little-endian mono). */
  async synthesize(text) {
    if (!this.available()) throw new Error('Windows voice is not available');
    await this.start();
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('speech timed out'));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${id} ${Buffer.from(String(text).slice(0, 1000), 'utf8').toString('base64')}\n`);
    });
  }

  stop() {
    this.failAll(new Error('voice stopped'));
    if (this.child) {
      this.child.removeAllListeners('exit');
      this.child.kill();
    }
    this.child = null;
    this.ready = null;
  }
}

module.exports = { WindowsVoice, SAMPLE_RATE, SCRIPT };
