'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { spawn } = require('child_process');
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

function portableDir(oldText = 'the old version', newText = 'the NEW version') {
  const dir = tmpDir();
  const target = path.join(dir, 'Nibo AI Portable.exe');
  const fresh = `${target}.new`;
  fs.writeFileSync(target, oldText);
  fs.writeFileSync(fresh, newText);
  return { dir, target, fresh };
}

test('puts the new portable file in place and keeps the old one aside', () => {
  const { dir, target, fresh } = portableDir();
  try {
    const swap = updater.swapInPlace({ target, fresh });
    assert.equal(fs.readFileSync(target, 'utf8'), 'the NEW version');
    assert.equal(fs.readFileSync(`${target}.old`, 'utf8'), 'the old version');
    assert.equal(swap.old, `${target}.old`);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['Nibo AI Portable.exe', 'Nibo AI Portable.exe.old']);
    swap.undo();
    assert.equal(fs.readFileSync(target, 'utf8'), 'the old version');
    assert.equal(fs.readFileSync(fresh, 'utf8'), 'the NEW version');
    assert.deepEqual(fs.readdirSync(dir).sort(), ['Nibo AI Portable.exe', 'Nibo AI Portable.exe.new']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a leftover ".old" from an earlier update does not get in the way', () => {
  const { dir, target, fresh } = portableDir('old', 'new');
  fs.writeFileSync(`${target}.old`, 'leftovers');
  try {
    updater.swapInPlace({ target, fresh });
    assert.equal(fs.readFileSync(target, 'utf8'), 'new');
    assert.equal(fs.readFileSync(`${target}.old`, 'utf8'), 'old');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('will not swap in a file that is not there, or leave things half done', () => {
  const { dir, target, fresh } = portableDir();
  try {
    fs.rmSync(fresh);
    assert.throws(() => updater.swapInPlace({ target, fresh }), (err) => err.kind === 'install');
    assert.equal(fs.readFileSync(target, 'utf8'), 'the old version');

    // The new file can't be moved in: the old one comes back.
    fs.writeFileSync(fresh, 'the NEW version');
    let renames = 0;
    const flaky = {
      ...fs,
      renameSync: (from, to) => {
        if (++renames === 2) throw new Error('EBUSY');
        fs.renameSync(from, to);
      },
    };
    assert.throws(() => updater.swapInPlace({ target, fresh }, flaky), (err) => err.kind === 'install' && /EBUSY/.test(err.message));
    assert.equal(fs.readFileSync(target, 'utf8'), 'the old version');
    assert.equal(fs.readFileSync(fresh, 'utf8'), 'the NEW version');
    assert.deepEqual(fs.readdirSync(dir).sort(), ['Nibo AI Portable.exe', 'Nibo AI Portable.exe.new']);

    // The old one can't be moved aside: nothing changes at all.
    const stuck = {
      ...fs,
      renameSync: () => {
        throw new Error('EPERM');
      },
    };
    assert.throws(() => updater.swapInPlace({ target, fresh }, stuck), (err) => err.kind === 'install' && /EPERM/.test(err.message));
    assert.equal(fs.readFileSync(target, 'utf8'), 'the old version');
    assert.deepEqual(fs.readdirSync(dir).sort(), ['Nibo AI Portable.exe', 'Nibo AI Portable.exe.new']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('starts the new portable file on its own, as an update', async () => {
  const child = fakeChild();
  const calls = [];
  const started = updater.startPortable('C:\\Apps\\Nibo.exe', { spawnImpl: (...args) => (calls.push(args), child) });
  child.emit('spawn');
  await started;
  assert.deepEqual(calls, [['C:\\Apps\\Nibo.exe', ['--updated'], { detached: true, stdio: 'ignore', windowsHide: false }]]);
  assert.equal(child.unrefed, true);

  const broken = fakeChild();
  const b = updater.startPortable('x.exe', { spawnImpl: () => broken });
  broken.emit('error', new Error('EACCES'));
  await assert.rejects(b, (err) => err.kind === 'install' && /EACCES/.test(err.message));
  await assert.rejects(
    updater.startPortable('x.exe', {
      spawnImpl: () => {
        throw new Error('nope');
      },
    }),
    (err) => err.kind === 'install',
  );
});

test('the portable update puts the old file back if the new one will not start', async () => {
  const good = portableDir();
  const bad = portableDir();
  try {
    const child = fakeChild();
    await Promise.all([updater.replacePortable(good, { spawnImpl: () => child }), Promise.resolve().then(() => child.emit('spawn'))]);
    assert.equal(fs.readFileSync(good.target, 'utf8'), 'the NEW version');
    assert.ok(fs.existsSync(`${good.target}.old`)); // kept until the new one has been running a while

    const broken = fakeChild();
    await Promise.all([
      assert.rejects(updater.replacePortable(bad, { spawnImpl: () => broken }), (err) => err.kind === 'install'),
      Promise.resolve().then(() => broken.emit('error', new Error('blocked by antivirus'))),
    ]);
    assert.equal(fs.readFileSync(bad.target, 'utf8'), 'the old version');
    assert.equal(fs.readFileSync(bad.fresh, 'utf8'), 'the NEW version');
    assert.ok(!fs.existsSync(`${bad.target}.old`));
  } finally {
    fs.rmSync(good.dir, { recursive: true, force: true });
    fs.rmSync(bad.dir, { recursive: true, force: true });
  }
});

// What only a real Windows can say: a program that is running can still be renamed, which is
// the whole trick. (A copy of node.exe stands in for the portable Nibo.)
const onWindows = { skip: process.platform !== 'win32', timeout: 120_000 };

test('the real swap on Windows: the file of a running program can be swapped and the new one started', onWindows, async () => {
  const dir = tmpDir();
  const target = path.join(dir, "Nibo's AI Portable.exe");
  const fresh = `${target}.new`;
  fs.copyFileSync(process.execPath, target);
  fs.copyFileSync(process.execPath, fresh);
  fs.appendFileSync(fresh, Buffer.from('NEW')); // harmless after the end of an .exe, and different from the old one
  const running = spawn(target, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await sleep(1500);
  try {
    assert.equal(running.exitCode, null, 'the stand-in program is running');
    await updater.replacePortable({ target, fresh });
    assert.equal(fs.statSync(target).size, fs.statSync(`${target}.old`).size + 3, 'the new file is where the old one was');
    assert.equal(running.exitCode, null, 'the old program keeps running after its file moved');
    running.kill();
    await new Promise((resolve) => running.once('exit', resolve));
    await sleep(500);
    fs.rmSync(`${target}.old`); // ...and once it has quit, the old file can go
  } finally {
    running.kill();
    await sleep(500);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
