'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const updates = require('../src/main/updates');

const REPO = 'assergames80-prog/Nibo-AI';
const DL = `https://github.com/${REPO}/releases/download`;

function release(version, extra = {}) {
  return {
    tag_name: `v${version}`,
    html_url: `https://github.com/${REPO}/releases/tag/v${version}`,
    draft: false,
    prerelease: false,
    assets: [
      { name: `Nibo-AI-Portable-${version}.exe`, browser_download_url: `${DL}/v${version}/Nibo-AI-Portable-${version}.exe`, size: 2222, digest: `sha256:${'b'.repeat(64)}` },
      { name: `Nibo-AI-Setup-${version}.exe`, browser_download_url: `${DL}/v${version}/Nibo-AI-Setup-${version}.exe`, size: 1111, digest: `sha256:${'A'.repeat(64)}` },
      { name: `Nibo-AI-Setup-${version}.exe.blockmap`, browser_download_url: `${DL}/v${version}/Nibo-AI-Setup-${version}.exe.blockmap` },
    ],
    ...extra,
  };
}

// A tiny stand-in for api.github.com.
function startMockGithub(respond) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, headers: req.headers });
    const { status = 200, body, raw, delayMs = 0 } = respond(req);
    setTimeout(() => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(raw ?? JSON.stringify(body));
    }, delayMs);
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ url: `http://127.0.0.1:${server.address().port}`, requests, close: () => new Promise((r) => server.close(r)) }),
    ),
  );
}

test('reads and compares versions', () => {
  assert.deepEqual(updates.parseVersion('v1.4.0'), [1, 4, 0]);
  assert.deepEqual(updates.parseVersion('1.4'), [1, 4, 0]);
  assert.deepEqual(updates.parseVersion(' V2.10.3 '), null); // capital V is not how our tags look
  assert.deepEqual(updates.parseVersion('1.5.0-beta.1'), [1, 5, 0]);
  for (const bad of ['latest', '', null, undefined, 'v1', '1.x.0', 'nightly-2026']) assert.equal(updates.parseVersion(bad), null, String(bad));

  assert.equal(updates.isNewer('v1.5.0', '1.4.0'), true);
  assert.equal(updates.isNewer('1.4.1', '1.4.0'), true);
  assert.equal(updates.isNewer('2.0.0', '1.99.99'), true);
  assert.equal(updates.isNewer('1.10.0', '1.9.0'), true); // numbers, not text
  assert.equal(updates.isNewer('1.4.0', '1.4.0'), false);
  assert.equal(updates.isNewer('1.3.9', '1.4.0'), false);
  assert.equal(updates.isNewer('garbage', '1.4.0'), false);
  assert.equal(updates.isNewer('1.5.0', 'garbage'), false);
});

test('only release pages on the Nibo repo may be opened', () => {
  assert.equal(updates.isReleaseUrl(`https://github.com/${REPO}/releases/tag/v1.5.0`), true);
  assert.equal(updates.isReleaseUrl(`${DL}/v1.5.0/Nibo-AI-Setup-1.5.0.exe`), true);
  assert.equal(updates.isReleaseUrl(`https://github.com/${REPO.toUpperCase()}/releases/latest`), true);
  for (const bad of [
    `http://github.com/${REPO}/releases/tag/v1`,
    `https://github.com.evil.example/${REPO}/releases/tag/v1`,
    `https://evil.example/${REPO}/releases/tag/v1`,
    `https://github.com/someone-else/Nibo-AI/releases/tag/v1`,
    `https://github.com/${REPO}/issues/1`,
    `https://github.com/${REPO}evil/releases/x`,
    `https://user:pass@github.com/${REPO}/releases/tag/v1`,
    'file:///C:/Windows/System32/calc.exe',
    'javascript:alert(1)',
    'C:\\Windows\\System32\\calc.exe',
    '',
    null,
  ]) {
    assert.equal(updates.isReleaseUrl(bad), false, String(bad));
  }
});

test('picks the installer or the portable file, and never trusts other addresses', () => {
  const installer = updates.parseRelease(release('1.5.0'), { platform: 'win32' });
  assert.deepEqual(installer, {
    version: '1.5.0',
    url: `https://github.com/${REPO}/releases/tag/v1.5.0`,
    assetUrl: `${DL}/v1.5.0/Nibo-AI-Setup-1.5.0.exe`,
    size: 1111,
    sha256: 'a'.repeat(64), // lower-cased
  });
  const portable = updates.parseRelease(release('1.5.0'), { platform: 'win32', portable: true });
  assert.equal(portable.assetUrl, `${DL}/v1.5.0/Nibo-AI-Portable-1.5.0.exe`);
  assert.equal(portable.size, 2222);
  assert.equal(portable.sha256, 'b'.repeat(64));
  // Elsewhere there is no .exe to offer: just the page.
  assert.equal(updates.parseRelease(release('1.5.0'), { platform: 'linux' }).assetUrl, null);

  // An asset or page address that isn't on the repo is ignored.
  const tricky = release('1.5.0', {
    html_url: 'https://evil.example/phish',
    assets: [{ name: 'Nibo-AI-Setup-1.5.0.exe', browser_download_url: 'https://evil.example/Nibo-AI-Setup-1.5.0.exe' }],
  });
  const safe = updates.parseRelease(tricky, { platform: 'win32' });
  assert.equal(safe.url, `https://github.com/${REPO}/releases/tag/v1.5.0`);
  assert.equal(safe.assetUrl, null);
  assert.equal(safe.sha256, null);
  // A file without a usable checksum or size can still be downloaded by hand, but not verified.
  for (const bad of [{ digest: undefined }, { digest: 'md5:abcd' }, { digest: `sha256:${'z'.repeat(64)}` }, { digest: `sha256:${'a'.repeat(63)}` }]) {
    const odd = release('1.5.0', { assets: [{ name: 'Nibo-AI-Setup-1.5.0.exe', browser_download_url: `${DL}/v1.5.0/Nibo-AI-Setup-1.5.0.exe`, size: 5, ...bad }] });
    const parsed = updates.parseRelease(odd, { platform: 'win32' });
    assert.equal(parsed.assetUrl, `${DL}/v1.5.0/Nibo-AI-Setup-1.5.0.exe`);
    assert.equal(parsed.sha256, null, JSON.stringify(bad));
    assert.equal(parsed.size, 5);
  }
  for (const size of [0, -1, 1.5, '1000', 10 ** 12, null]) {
    const odd = release('1.5.0', { assets: [{ name: 'Nibo-AI-Setup-1.5.0.exe', browser_download_url: `${DL}/v1.5.0/Nibo-AI-Setup-1.5.0.exe`, size, digest: `sha256:${'a'.repeat(64)}` }] });
    assert.equal(updates.parseRelease(odd, { platform: 'win32' }).size, null, String(size));
  }
  // The blockmap is not a download.
  const onlyMap = release('1.5.0', { assets: [{ name: 'Nibo-AI-Setup-1.5.0.exe.blockmap', browser_download_url: `${DL}/v1.5.0/x.blockmap` }] });
  assert.equal(updates.parseRelease(onlyMap, { platform: 'win32' }).assetUrl, null);

  assert.equal(updates.parseRelease(release('1.5.0', { draft: true })), null);
  assert.equal(updates.parseRelease(release('1.5.0', { prerelease: true })), null);
  assert.equal(updates.parseRelease({ tag_name: 'nightly' }), null);
  assert.equal(updates.parseRelease(null), null);
  assert.equal(updates.parseRelease('nope'), null);
});

test('finds a newer release on GitHub', async () => {
  const mock = await startMockGithub(() => ({ body: release('1.5.0') }));
  try {
    const res = await updates.checkForUpdate({ current: '1.4.0', platform: 'win32', baseUrl: mock.url });
    assert.equal(res.status, 'newer');
    assert.equal(res.release.version, '1.5.0');
    assert.match(res.release.assetUrl, /Setup-1\.5\.0\.exe$/);
    const [req] = mock.requests;
    assert.equal(req.url, `/repos/${REPO}/releases/latest`);
    assert.equal(req.headers['user-agent'], 'Nibo-AI/1.4.0'); // GitHub insists on one
    assert.match(req.headers.accept, /github/);
    // Nothing about the user is sent.
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers.cookie, undefined);
  } finally {
    await mock.close();
  }
});

test('knows when it is up to date, or ahead', async () => {
  const mock = await startMockGithub(() => ({ body: release('1.4.0') }));
  try {
    assert.deepEqual(await updates.checkForUpdate({ current: '1.4.0', baseUrl: mock.url }), { status: 'current', latest: '1.4.0' });
    assert.deepEqual(await updates.checkForUpdate({ current: '1.5.0', baseUrl: mock.url }), { status: 'current', latest: '1.4.0' });
  } finally {
    await mock.close();
  }
});

test('GitHub trouble is reported, never thrown', async () => {
  const cases = [
    [{ status: 404, body: { message: 'Not Found' } }, /answered 404/],
    [{ status: 403, body: { message: 'rate limit exceeded' } }, /answered 403/],
    [{ status: 500, body: {} }, /answered 500/],
    [{ raw: '<html>not json</html>' }, /unreadable/],
    [{ body: { tag_name: 'nightly' } }, /no usable release/],
    [{ body: release('9.9.9', { draft: true }) }, /no usable release/],
  ];
  for (const [response, expected] of cases) {
    const mock = await startMockGithub(() => response);
    try {
      const res = await updates.checkForUpdate({ current: '1.4.0', baseUrl: mock.url });
      assert.equal(res.status, 'error');
      assert.match(res.error, expected);
    } finally {
      await mock.close();
    }
  }
  // Nobody home.
  const gone = await startMockGithub(() => ({ body: {} }));
  const url = gone.url;
  await gone.close();
  const res = await updates.checkForUpdate({ current: '1.4.0', baseUrl: url });
  assert.equal(res.status, 'error');
  assert.match(res.error, /Could not reach GitHub/);
});

test('a check can be cancelled', async () => {
  const mock = await startMockGithub(() => ({ body: release('1.5.0'), delayMs: 3000 }));
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const started = Date.now();
    const res = await updates.checkForUpdate({ current: '1.4.0', baseUrl: mock.url, signal: controller.signal });
    assert.equal(res.status, 'error');
    assert.ok(Date.now() - started < 2000, 'should stop waiting');
  } finally {
    await mock.close();
  }
});

test('understands "check for updates" and "what version are you?"', () => {
  for (const text of [
    'check for updates',
    'Check for updates!',
    'check for a new version',
    'Nibo, can you please check for updates?',
    'is there a new version?',
    'is there a newer release',
    'are there any updates?',
    'any updates',
    'any new updates?',
    'look for updates',
    'are you up to date?',
    'am I up to date',
    'update yourself',
    'hey nibo check for new releases',
  ]) {
    assert.equal(updates.detectIntent(text), 'check', text);
  }
  for (const text of ['what version are you?', 'what version am I running', 'which version is this', "what's your version", 'what version are you on']) {
    assert.equal(updates.detectIntent(text), 'version', text);
  }
  for (const text of [
    'tell me a joke',
    'open spotify',
    'how do I update windows?',
    'what is a version control system',
    'check my homework',
    'update my resume',
    'remind me to check for updates tomorrow',
    'hello',
    '',
    null,
  ]) {
    assert.equal(updates.detectIntent(text), null, String(text));
  }
});
