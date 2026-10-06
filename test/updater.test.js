'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { spawn, spawnSync } = require('child_process');
const updater = require('../src/main/updater');

const REPO = 'assergames80-prog/Nibo-AI';
const URL_ = `https://github.com/${REPO}/releases/download/v2.0.0/Nibo-AI-Setup-2.0.0.exe`;
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nibo-updater-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A stand-in for GitHub's file server: serves `body` (optionally slowly, or from another address).
function startServer(handler) {
  const server = http.createServer((req, res) => handler(req, res));
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) })),
  );
}

// fetch that asks the stand-in server whatever address it is given.
const via = (server) => (url, options) => fetch(server.url + new URL(url).pathname, options);
const LOCAL = { allowHosts: ['127.0.0.1'], requireHttps: false, repo: REPO };

function serve(body, { headers = {}, status = 200, slow = 0 } = {}) {
  return startServer(async (req, res) => {
    if (req.url.endsWith('/redirect')) {
      res.writeHead(302, { location: '/real' });
      return res.end();
    }
    res.writeHead(status, { 'content-length': body.length, ...headers });
    if (!slow) return res.end(body);
    for (let i = 0; i < body.length; i += 1000) {
      res.write(body.subarray(i, i + 1000));
      await sleep(slow);
    }
    res.end();
  });
}

test('downloads a file and keeps it only if it is exactly what GitHub says', async () => {
  const body = crypto.randomBytes(300_000);
  const server = await serve(body);
  const dir = tmpDir();
  try {
    const progress = [];
    const to = path.join(dir, 'Nibo-AI-Setup-2.0.0.exe');
    const res = await updater.download({ url: URL_, to, size: body.length, sha256: sha(body), fetchImpl: via(server), onProgress: (p) => progress.push(p), ...LOCAL });
    assert.equal(res.path, to);
    assert.equal(res.bytes, body.length);
    assert.ok(fs.readFileSync(to).equals(body));
    assert.deepEqual(fs.readdirSync(dir), ['Nibo-AI-Setup-2.0.0.exe']); // no .part left behind
    assert.equal(progress.at(-1).percent, 100);
    assert.ok(progress.every((p, i) => i === 0 || p.percent >= progress[i - 1].percent));
    assert.equal(progress[0].total, body.length);
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('follows a redirect, like GitHub does to its file servers', async () => {
  const body = Buffer.from('a small file');
  const server = await serve(body);
  const dir = tmpDir();
  try {
    const url = `https://github.com/${REPO}/releases/download/v2.0.0/redirect`;
    const to = path.join(dir, 'x.exe');
    await updater.download({ url, to, size: body.length, sha256: sha(body), fetchImpl: via(server), ...LOCAL });
    assert.ok(fs.readFileSync(to).equals(body));
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('throws away a file that is not the one GitHub described', async () => {
  const body = crypto.randomBytes(50_000);
  const tampered = Buffer.from(body);
  tampered[1234] ^= 0xff;
  const cases = [
    ['a changed byte', tampered, { size: body.length, sha256: sha(body) }, /checksum/],
    ['the wrong checksum', body, { size: body.length, sha256: 'f'.repeat(64) }, /checksum/],
    ['a shorter file than announced', body.subarray(0, 40_000), { size: body.length, sha256: sha(body) }, /bytes/],
    ['a longer file than announced', Buffer.concat([body, Buffer.from('extra')]), { size: body.length, sha256: sha(body) }, /bytes|bigger/],
  ];
  for (const [label, served, expected, message] of cases) {
    const server = await serve(served);
    const dir = tmpDir();
    try {
      await assert.rejects(
        updater.download({ url: URL_, to: path.join(dir, 'x.exe'), ...expected, fetchImpl: via(server), ...LOCAL }),
        (err) => err.kind === 'verify' && message.test(err.message),
        label,
      );
      assert.deepEqual(fs.readdirSync(dir), [], `${label}: nothing may be left behind`);
    } finally {
      await server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('stops on trouble with GitHub or an unexpected address', async () => {
  const body = Buffer.from('hello');
  const dir = tmpDir();
  try {
    const missing = await serve(Buffer.from('nope'), { status: 404 });
    await assert.rejects(
      updater.download({ url: URL_, to: path.join(dir, 'a.exe'), size: 5, sha256: sha(body), fetchImpl: via(missing), ...LOCAL }),
      (err) => err.kind === 'network' && /404/.test(err.message),
    );
    await missing.close();

    const down = await serve(body);
    const gone = via(down);
    await down.close();
    await assert.rejects(updater.download({ url: URL_, to: path.join(dir, 'b.exe'), size: 5, sha256: sha(body), fetchImpl: gone, ...LOCAL }), (err) => err.kind === 'network');

    // A download that ends up on some other site is refused, whatever it contains.
    const elsewhere = async () => ({ ok: true, url: 'https://evil.example/Nibo.exe', headers: new Headers({ 'content-length': '5' }), body: [Buffer.from('hello')] });
    await assert.rejects(
      updater.download({ url: URL_, to: path.join(dir, 'c.exe'), size: 5, sha256: sha(body), fetchImpl: elsewhere, repo: REPO }),
      (err) => err.kind === 'verify' && /unexpected/.test(err.message),
    );
    const fromGithub = async () => ({ ok: true, url: 'https://objects.githubusercontent.com/x/Nibo.exe', headers: new Headers({ 'content-length': '5' }), body: [Buffer.from('hello')] });
    const ok = await updater.download({ url: URL_, to: path.join(dir, 'd.exe'), size: 5, sha256: sha(body), fetchImpl: fromGithub, repo: REPO });
    assert.equal(ok.bytes, 5);
    assert.deepEqual(fs.readdirSync(dir), ['d.exe']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('refuses to even start for the wrong address, size or checksum', async () => {
  const dir = tmpDir();
  let asked = 0;
  const fetchImpl = async () => (asked++, assert.fail('should not be asked'));
  const good = { to: path.join(dir, 'x.exe'), size: 5, sha256: 'a'.repeat(64), fetchImpl, repo: REPO };
  try {
    for (const bad of [
      { url: 'https://evil.example/Nibo-AI-Setup-2.0.0.exe' },
      { url: `https://github.com/someone-else/Nibo-AI/releases/download/v2/x.exe` },
      { url: 'file:///C:/Windows/System32/calc.exe' },
      { url: URL_, size: 0 },
      { url: URL_, size: 1.5 },
      { url: URL_, size: 10 ** 12 },
      { url: URL_, sha256: 'not a checksum' },
      { url: URL_, sha256: 'A'.repeat(64) }, // must be lower-case hex, as the caller normalizes it
      { url: URL_, sha256: undefined },
    ]) {
      await assert.rejects(updater.download({ ...good, ...bad }), (err) => err.kind === 'verify', JSON.stringify(bad));
    }
    assert.equal(asked, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('can be cancelled in the middle, leaving nothing behind', async () => {
  const body = crypto.randomBytes(40_000);
  const server = await serve(body, { slow: 30 });
  const dir = tmpDir();
  try {
    const controller = new AbortController();
    const started = Date.now();
    const job = updater.download({
      url: URL_,
      to: path.join(dir, 'x.exe'),
      size: body.length,
      sha256: sha(body),
      fetchImpl: via(server),
      onProgress: () => controller.abort(),
      signal: controller.signal,
      ...LOCAL,
    });
    await assert.rejects(job, (err) => err.kind === 'cancelled');
    assert.ok(Date.now() - started < 1000, 'should stop waiting');
    await sleep(100);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('only downloads from GitHub', () => {
  for (const url of ['https://github.com/a/b', 'https://objects.githubusercontent.com/x', 'https://release-assets.githubusercontent.com/y']) {
    assert.equal(updater.hostAllowed(url), true, url);
  }
  for (const url of ['http://github.com/a', 'https://evil.example/github.com', 'https://github.com.evil.example/a', 'https://notgithub.com/a', 'https://evilgithubusercontent.com/a', 'file:///x', 'nonsense', '']) {
    assert.equal(updater.hostAllowed(url), false, url);
  }
});

test('knows when it can update itself', () => {
  const update = { assetUrl: URL_, size: 1000, sha256: 'a'.repeat(64) };
  const base = { update, packaged: true, platform: 'win32', writable: () => true };
  assert.deepEqual(updater.supported(base), { ok: true });
  assert.deepEqual(updater.supported({ ...base, portableFile: 'C:\\Games\\Nibo.exe' }), { ok: true });
  for (const [patch, why] of [
    [{ update: null }, /no update/],
    [{ packaged: false }, /installed copy/],
    [{ platform: 'linux' }, /Windows/],
    [{ update: { ...update, assetUrl: null } }, /no file/],
    [{ update: { ...update, sha256: null } }, /how to check/],
    [{ update: { ...update, size: null } }, /how to check/],
    [{ portableFile: 'C:\\Program Files\\Nibo.exe', writable: () => false }, /folder/],
  ]) {
    const res = updater.supported({ ...base, ...patch });
    assert.equal(res.ok, false);
    assert.match(res.reason, why);
  }
});

// ---------- the installer ----------

function fakeChild() {
  const child = new EventEmitter();
  child.unrefed = false;
  child.unref = () => (child.unrefed = true);
  return child;
}

test('starts the installer quietly, as an update, and starts Nibo again afterwards', async () => {
  assert.deepEqual(updater.installerArgs(), ['--updated', '/S', '--force-run']);
  const child = fakeChild();
  const calls = [];
  await updater.launchInstaller('C:\\temp\\Setup.exe', { spawnImpl: (...args) => (calls.push(args), child), graceMs: 20 });
  assert.deepEqual(calls, [['C:\\temp\\Setup.exe', ['--updated', '/S', '--force-run'], { detached: true, stdio: 'ignore', windowsHide: true }]]);
  assert.equal(child.unrefed, true); // it keeps running when Nibo quits
});

test('notices when the installer cannot start or stops at once', async () => {
  const error = fakeChild();
  const a = updater.launchInstaller('x.exe', { spawnImpl: () => error, graceMs: 500 });
  error.emit('error', new Error('EACCES'));
  await assert.rejects(a, (err) => err.kind === 'install' && /EACCES/.test(err.message));

  const crash = fakeChild();
  const b = updater.launchInstaller('x.exe', { spawnImpl: () => crash, graceMs: 500 });
  crash.emit('exit', 1);
  await assert.rejects(b, (err) => err.kind === 'install' && /code 1/.test(err.message));

  const ends = fakeChild();
  const c = updater.launchInstaller('x.exe', { spawnImpl: () => ends, graceMs: 500 });
  ends.emit('exit', 0); // e.g. it handed over to a copy with more rights
  await c;

  await assert.rejects(
    updater.launchInstaller('x.exe', {
      spawnImpl: () => {
        throw new Error('nope');
      },
    }),
    (err) => err.kind === 'install',
  );
});

// ---------- the portable file ----------

test('writes a swap script that is careful with names', () => {
  const script = updater.swapScript({ target: "C:\\Users\\O'Brien\\Nibo AI.exe", fresh: "C:\\Users\\O'Brien\\Nibo AI.exe.new", waitFor: [1234, 'x', -5, 0, 77.5, 99] });
  assert.match(script, /\$target = 'C:\\Users\\O''Brien\\Nibo AI\.exe'/);
  assert.match(script, /\$fresh = 'C:\\Users\\O''Brien\\Nibo AI\.exe\.new'/);
  assert.match(script, /foreach \(\$id in @\(1234, 99\)\)/); // only real process ids
  assert.match(script, /Start-Process -FilePath \$target -ArgumentList '--updated'/);
  assert.match(script, /Move-Item -LiteralPath \$old -Destination \$target -Force\s+Start-Process -FilePath \$target\s+exit 3/); // a failed swap puts the old one back and starts it
  const quiet = updater.swapScript({ target: 'a', fresh: 'b', relaunch: false });
  assert.doesNotMatch(quiet, /Start-Process/);
  assert.match(quiet, /@\(\)/);
  const args = updater.powershellArgs(script);
  assert.equal(args.at(-2), '-EncodedCommand');
  assert.equal(Buffer.from(args.at(-1), 'base64').toString('utf16le'), script);
  assert.ok(args.includes('-NonInteractive') && args.includes('Bypass'));
});

test('will not swap in a file that is not there', () => {
  assert.throws(() => updater.launchSwap({ target: 'a', fresh: path.join(tmpDir(), 'missing.exe') }, { spawnImpl: () => assert.fail('no') }), (err) => err.kind === 'install');
  const dir = tmpDir();
  const fresh = path.join(dir, 'new.exe');
  fs.writeFileSync(fresh, 'x');
  const child = fakeChild();
  const calls = [];
  assert.equal(updater.launchSwap({ target: path.join(dir, 'old.exe'), fresh }, { spawnImpl: (...a) => (calls.push(a), child) }), child);
  assert.equal(calls[0][0], 'powershell.exe');
  assert.deepEqual(calls[0][2], { detached: true, stdio: 'ignore', windowsHide: true });
  assert.equal(child.unrefed, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

const onWindows = { skip: process.platform !== 'win32', timeout: 120_000 };

function runScript(options) {
  const script = updater.swapScript({ relaunch: false, cleanupSeconds: 0, ...options });
  return spawnSync('powershell.exe', updater.powershellArgs(script), { encoding: 'utf8', timeout: 100_000 });
}

test('the real swap on Windows: the new file takes the old one\'s place', onWindows, () => {
  const dir = tmpDir();
  const target = path.join(dir, 'Nibo AI Portable.exe');
  const fresh = `${target}.new`;
  fs.writeFileSync(target, 'the old version');
  fs.writeFileSync(fresh, 'the NEW version');
  try {
    const res = runScript({ target, fresh });
    assert.equal(res.status, 0, `${res.stdout}${res.stderr}`);
    assert.equal(fs.readFileSync(target, 'utf8'), 'the NEW version');
    assert.deepEqual(fs.readdirSync(dir).sort(), ['Nibo AI Portable.exe'], 'neither .new nor .old is left');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the real swap on Windows: a stale ".old" from before does not get in the way', onWindows, () => {
  const dir = tmpDir();
  const target = path.join(dir, "Nibo's copy.exe"); // (an apostrophe in the name, too)
  const fresh = `${target}.new`;
  fs.writeFileSync(target, 'old');
  fs.writeFileSync(`${target}.old`, 'leftovers');
  fs.writeFileSync(fresh, 'new');
  try {
    assert.equal(runScript({ target, fresh }).status, 0);
    assert.equal(fs.readFileSync(target, 'utf8'), 'new');
    assert.deepEqual(fs.readdirSync(dir), ["Nibo's copy.exe"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the real swap on Windows: if the new file cannot be put in place, the old one comes back', onWindows, () => {
  const dir = tmpDir();
  const target = path.join(dir, 'Nibo AI Portable.exe');
  fs.writeFileSync(target, 'the old version');
  try {
    const res = runScript({ target, fresh: path.join(dir, 'does-not-exist.exe') });
    assert.equal(res.status, 3, `${res.stdout}${res.stderr}`);
    assert.equal(fs.readFileSync(target, 'utf8'), 'the old version');
    assert.deepEqual(fs.readdirSync(dir), ['Nibo AI Portable.exe']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the real swap on Windows: waits for Nibo to be gone first', onWindows, async () => {
  const dir = tmpDir();
  const target = path.join(dir, 'Nibo AI Portable.exe');
  const fresh = `${target}.new`;
  fs.writeFileSync(target, 'old');
  fs.writeFileSync(fresh, 'new');
  // A process that lives for about three seconds stands in for Nibo.
  const stand = spawn('powershell.exe', ['-NoProfile', '-Command', 'Start-Sleep -Seconds 3'], { stdio: 'ignore' });
  try {
    const begun = Date.now();
    const res = runScript({ target, fresh, waitFor: [stand.pid] });
    assert.equal(res.status, 0, `${res.stdout}${res.stderr}`);
    assert.ok(Date.now() - begun >= 1500, 'should have waited for the other process');
    assert.equal(fs.readFileSync(target, 'utf8'), 'new');
  } finally {
    stand.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the real swap on Windows: launchSwap runs on its own', onWindows, async () => {
  const dir = tmpDir();
  const target = path.join(dir, 'Nibo AI Portable.exe');
  const fresh = `${target}.new`;
  fs.writeFileSync(target, 'old');
  fs.writeFileSync(fresh, 'new');
  try {
    updater.launchSwap({ target, fresh, relaunch: false, cleanupSeconds: 0 });
    for (let i = 0; i < 60 && fs.readFileSync(target, 'utf8') !== 'new'; i++) await sleep(500);
    assert.equal(fs.readFileSync(target, 'utf8'), 'new');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
