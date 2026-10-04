'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const apps = require('../src/main/apps');

const app = (name) => ({ kind: 'app', name, id: `${name.replace(/\W/g, '')}!App` });
const INSTALLED = [
  'Google Chrome',
  'Chrome Remote Desktop',
  'Spotify',
  'Visual Studio Code',
  'Visual Studio 2022',
  'Word 2016',
  'WordPad',
  'Microsoft Edge',
  'Kalkulator',
  'Notepad',
  'Sticky Notes',
  'Google Drive',
  'YouTube Music',
  'Minecraft Launcher',
  'Settings',
].map(app);
const FOLDERS = ['Desktop', 'Downloads', 'Documents', 'Pictures', 'Music', 'Videos'].map((name) => ({
  kind: 'folder',
  name,
  path: `/home/bun/${name}`,
}));
const TIERS = [[...INSTALLED, ...FOLDERS], apps.BUILTINS, apps.WEBSITES];

function opens(phrase, tiers = TIERS) {
  const res = apps.resolve(phrase, tiers);
  return res.match ? `${res.match.kind}:${res.match.name}` : null;
}

test('normalizes names and cleans up what people say', () => {
  assert.equal(apps.normalize('Microsoft® Word™ 2016'), 'microsoft word 2016');
  assert.equal(apps.normalize('Przeglądarka Łódź'), 'przegladarka lodz');
  assert.equal(apps.normalize("Nibo's settings"), 'nibo s settings');
  assert.equal(apps.cleanQuery('the Spotify app for me'), 'spotify');
  assert.equal(apps.cleanQuery('my downloads folder please'), 'downloads');
  assert.equal(apps.cleanQuery('up chrome real quick'), 'chrome');
});

test('finds apps by their name, part of it, a nickname or with a typo', () => {
  assert.equal(opens('spotify'), 'app:Spotify');
  assert.equal(opens('Spotify app'), 'app:Spotify');
  assert.equal(opens('chrome'), 'app:Google Chrome');
  assert.equal(opens('chrom'), 'app:Google Chrome');
  assert.equal(opens('edge'), 'app:Microsoft Edge');
  assert.equal(opens('vs code'), 'app:Visual Studio Code');
  assert.equal(opens('vscode'), 'app:Visual Studio Code');
  assert.equal(opens('spotfy'), 'app:Spotify');
  assert.equal(opens('minecraft'), 'app:Minecraft Launcher');
  assert.equal(opens('settings'), 'app:Settings');
  assert.equal(opens('photo editor', [[app('Photoshop Elements Editor')], [], []]), 'app:Photoshop Elements Editor');
  // A whole word beats the start of one.
  assert.equal(opens('word'), 'app:Word 2016');
  assert.equal(opens('note'), 'app:Notepad');
});

test('knows folders, Windows built-ins and websites, and an exact name wins', () => {
  assert.equal(opens('my downloads folder'), 'folder:Downloads');
  assert.equal(opens('music'), 'folder:Music');
  assert.equal(opens('files'), 'builtin:File Explorer');
  // A Polish Windows calls it "Kalkulator": both names work.
  assert.equal(opens('calculator'), 'builtin:Calculator');
  assert.equal(opens('kalkulator'), 'app:Kalkulator');
  // "google" is the website, not Google Chrome or Google Drive.
  assert.equal(opens('google'), 'site:Google');
  assert.equal(opens('youtube'), 'site:YouTube');
  // An installed app beats the website of the same name.
  assert.equal(opens('spotify'), 'app:Spotify');
  assert.equal(opens('discord'), 'site:Discord');
});

test('opens a web address as a website, and only over https', () => {
  const res = apps.resolve('www.BBC.co.uk/news', TIERS);
  assert.deepEqual(res.match, { kind: 'site', name: 'www.bbc.co.uk', url: 'https://www.bbc.co.uk/news' });
  assert.equal(apps.resolve('https://example.com', TIERS).match.url, 'https://example.com/');
  assert.equal(apps.asDomain('notepad'), null);
  assert.equal(apps.asDomain('C:\\Windows\\system32\\cmd.exe'), null);
  assert.equal(apps.asDomain('file:///etc/passwd'), null);
  assert.equal(apps.asDomain('javascript:alert(1)'), null);
});

test('asks when several apps fit equally well, and suggests close names', () => {
  const both = apps.resolve('visual studio', TIERS);
  assert.equal(both.match, null);
  assert.equal(both.ambiguous, true);
  assert.deepEqual(both.choices.map((c) => c.name).sort(), ['Visual Studio 2022', 'Visual Studio Code']);

  const nothing = apps.resolve('the pod bay doors', TIERS);
  assert.equal(nothing.match, null);
  assert.deepEqual(nothing.choices, []);

  // Not sure enough to open it, but worth asking about.
  const maybe = apps.resolve('visualstu', TIERS);
  assert.equal(maybe.match, null);
  assert.ok(!maybe.ambiguous);
  assert.deepEqual(maybe.choices.map((c) => c.name).sort(), ['Visual Studio 2022', 'Visual Studio Code']);
});

test('splits "this and that" into separate names', () => {
  assert.deepEqual(apps.splitNames('Spotify and Discord'), ['Spotify', 'Discord']);
  assert.deepEqual(apps.splitNames('chrome, notepad & paint'), ['chrome', 'notepad', 'paint']);
  assert.deepEqual(apps.splitNames('spotify'), []);
  assert.deepEqual(apps.splitNames('a, b, c, d'), []);
});

test('reads the Start menu list, skipping uninstallers and documents', () => {
  const encode = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
  const list = apps.parseStartApps(
    encode([
      { name: 'Spotify', id: 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify' },
      { name: 'Przeglądarka', id: '{6D809377-6AF0-444B-8957-A3773F02200E}\\Browser\\browser.exe' },
      { name: 'Uninstall Spotify', id: '{7C5A40EF}\\Spotify\\uninstall.exe' },
      { name: 'Read me', id: '{7C5A40EF}\\Thing\\readme.txt' },
      { name: 'Vendor site', id: 'https://example.com/' },
      { name: 'Broken', id: '' },
      'nonsense',
    ]),
  );
  assert.deepEqual(list, [
    { kind: 'app', name: 'Spotify', id: 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify' },
    { kind: 'app', name: 'Przeglądarka', id: '{6D809377-6AF0-444B-8957-A3773F02200E}\\Browser\\browser.exe' },
  ]);
  // PowerShell writes a single app as an object instead of a list.
  assert.equal(apps.parseStartApps(encode({ name: 'Notepad', id: 'Microsoft.WindowsNotepad!App' })).length, 1);
  assert.deepEqual(apps.parseStartApps(encode([])), []);
  assert.throws(() => apps.parseStartApps('not base64 json'), /could not read/);
});

test('asks PowerShell for the Start menu apps without a shell', async () => {
  let call;
  const out = Buffer.from(JSON.stringify([{ name: 'Notepad', id: 'Notepad!App' }])).toString('base64');
  const list = await apps.loadStartApps({
    run: (file, args, opts, done) => {
      call = { file, args, opts };
      done(null, out, '');
    },
  });
  assert.deepEqual(list, [{ kind: 'app', name: 'Notepad', id: 'Notepad!App' }]);
  assert.equal(call.file, 'powershell.exe');
  assert.equal(call.opts.windowsHide, true);
  const script = Buffer.from(call.args.at(-1), 'base64').toString('utf16le');
  assert.match(script, /Get-StartApps/);
  assert.equal(call.args.at(-2), '-EncodedCommand');

  await assert.rejects(
    apps.loadStartApps({ run: (f, a, o, done) => done(new Error('exit 1'), '', 'Get-StartApps : not recognized') }),
    /not recognized/,
  );
});

test('plan B: finds the shortcuts in the Start menu folders', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nibo-start-'));
  const programs = path.join(root, 'Programs');
  fs.mkdirSync(path.join(programs, 'Games', 'Deep', 'Deeper', 'Deepest', 'Too deep'), { recursive: true });
  fs.writeFileSync(path.join(programs, 'Spotify.lnk'), '');
  fs.writeFileSync(path.join(programs, 'Games', 'Minecraft Launcher.lnk'), '');
  fs.writeFileSync(path.join(programs, 'Games', 'Uninstall Minecraft.lnk'), '');
  fs.writeFileSync(path.join(programs, 'Games', 'Manual.pdf'), '');
  fs.writeFileSync(path.join(programs, 'Games', 'Tool.appref-ms'), '');
  fs.writeFileSync(path.join(programs, 'desktop.ini'), '');
  fs.writeFileSync(path.join(programs, 'Games', 'Deep', 'Deeper', 'Deepest', 'Too deep', 'Lost.lnk'), '');
  try {
    const found = await apps.scanShortcuts([programs, path.join(root, 'missing')]);
    assert.deepEqual(found.map((f) => f.name).sort(), ['Minecraft Launcher', 'Spotify', 'Tool']);
    assert.ok(found.every((f) => f.kind === 'shortcut' && path.isAbsolute(f.path)));
    assert.deepEqual(apps.startMenuFolders({ ProgramData: 'C:\\ProgramData', APPDATA: 'C:\\Users\\Bun\\AppData\\Roaming' }).length, 2);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the catalog loads once, falls back to shortcuts, and refreshes when stale', async () => {
  let clock = 1_000_000;
  let loads = 0;
  const catalog = new apps.AppCatalog({
    platform: 'win32',
    now: () => clock,
    loadStartApps: async () => {
      loads++;
      await new Promise((r) => setTimeout(r, 10));
      return [app(`Spotify ${loads}`)];
    },
    scanShortcuts: async () => [],
  });
  const [a, b] = await Promise.all([catalog.installed(), catalog.installed()]);
  assert.equal(loads, 1);
  assert.equal(a, b);
  assert.equal(catalog.source, 'start-apps');
  assert.equal(catalog.mayBeStale(), false);

  clock += 60_000;
  assert.equal(catalog.mayBeStale(), true);
  assert.equal((await catalog.installed()).at(0).name, 'Spotify 1'); // fresh enough to use
  assert.equal((await catalog.installed({ fresh: true })).at(0).name, 'Spotify 2');

  clock += 11 * 60_000; // old: used once more while a new list loads in the background
  assert.equal((await catalog.installed()).at(0).name, 'Spotify 2');
  await catalog.loading;
  assert.equal((await catalog.installed()).at(0).name, 'Spotify 3');

  const fallback = new apps.AppCatalog({
    platform: 'win32',
    loadStartApps: async () => {
      throw new Error('Get-StartApps is not recognized');
    },
    scanShortcuts: async () => [{ kind: 'shortcut', name: 'Spotify', path: 'C:\\Spotify.lnk' }],
  });
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.equal((await fallback.installed())[0].kind, 'shortcut');
    assert.equal(fallback.source, 'shortcuts');
  } finally {
    console.error = originalError;
  }

  const elsewhere = new apps.AppCatalog({ platform: 'linux', loadStartApps: async () => assert.fail('only on Windows') });
  assert.deepEqual(await elsewhere.installed(), []);
  elsewhere.warm();
});

test('opens each kind of thing the right way', async () => {
  const calls = [];
  const deps = {
    openPath: async (p) => (calls.push(['openPath', p]), p.includes('broken') ? 'The file is missing' : ''),
    openExternal: async (url) => calls.push(['openExternal', url]),
    spawnDetached: (file, args) => calls.push(['spawn', file, ...args]),
    systemRoot: 'C:\\Windows',
  };
  assert.equal(await apps.launch(app('Spotify'), deps), null);
  assert.equal(await apps.launch({ kind: 'shortcut', name: 'Tool', path: 'C:\\Start\\Tool.lnk' }, deps), null);
  assert.equal(await apps.launch({ kind: 'shortcut', name: 'Gone', path: 'C:\\broken.lnk' }, deps), 'The file is missing');
  assert.equal(await apps.launch(FOLDERS[1], deps), null);
  assert.equal(await apps.launch(apps.BUILTINS.find((b) => b.name === 'Calculator'), deps), null);
  assert.equal(await apps.launch(apps.BUILTINS.find((b) => b.name === 'Settings'), deps), null);
  assert.equal(await apps.launch(apps.WEBSITES[0], deps), null);
  assert.deepEqual(calls, [
    ['spawn', 'explorer.exe', 'shell:AppsFolder\\Spotify!App'],
    ['openPath', 'C:\\Start\\Tool.lnk'],
    ['openPath', 'C:\\broken.lnk'],
    ['openPath', '/home/bun/Downloads'],
    ['openPath', 'C:\\Windows\\System32\\calc.exe'],
    ['openExternal', 'ms-settings:'],
    ['openExternal', 'https://www.youtube.com/'],
  ]);
  const failing = { ...deps, openExternal: async () => Promise.reject(new Error('no browser')) };
  assert.equal(await apps.launch(apps.WEBSITES[0], failing), 'no browser');
  assert.equal(await apps.launch({ kind: 'mystery', name: '?' }, deps), 'unknown kind of thing to open');
});

test('the real Windows Start menu list', { skip: process.platform !== 'win32', timeout: 90_000 }, async (t) => {
  let begin = Date.now();
  let list = [];
  try {
    list = await apps.loadStartApps();
    t.diagnostic(`Get-StartApps: ${list.length} apps in ${Date.now() - begin} ms, e.g. ${list.slice(0, 8).map((a) => a.name).join(', ')}`);
  } catch (err) {
    t.diagnostic(`Get-StartApps failed: ${err.message}`);
  }
  begin = Date.now();
  const shortcuts = await apps.scanShortcuts();
  t.diagnostic(`Start menu shortcuts: ${shortcuts.length} in ${Date.now() - begin} ms, e.g. ${shortcuts.slice(0, 8).map((a) => a.name).join(', ')}`);
  assert.ok(list.length + shortcuts.length > 0, 'found no apps at all');
  assert.ok(list.every((a) => a.kind === 'app' && a.name && a.id));

  const catalog = new apps.AppCatalog();
  const installed = await catalog.installed();
  t.diagnostic(`catalog source: ${catalog.source}, ${installed.length} apps`);
  const res = apps.resolve('notepad', [installed, apps.BUILTINS, apps.WEBSITES]);
  assert.ok(res.match, 'notepad not found');
  t.diagnostic(`"notepad" -> ${res.match.kind}: ${res.match.name} ${res.match.id || res.match.path || res.match.file || ''}`);

  // Open it the way Nibo does, check that it runs, and close it again.
  const { spawn, execFileSync } = require('child_process');
  const running = () => /notepad\.exe/i.test(execFileSync('tasklist', ['/FI', 'IMAGENAME eq notepad.exe'], { encoding: 'utf8' }));
  const error = await apps.launch(res.match, {
    openPath: async (p) => (spawn('cmd.exe', ['/c', 'start', '', p], { detached: true, stdio: 'ignore' }).unref(), ''),
    openExternal: async () => {},
    spawnDetached: (file, args) => spawn(file, args, { detached: true, stdio: 'ignore' }).unref(),
    systemRoot: process.env.SystemRoot,
  });
  assert.equal(error, null);
  let started = false;
  for (let i = 0; i < 40 && !started; i++) {
    await new Promise((r) => setTimeout(r, 250));
    started = running();
  }
  t.diagnostic(`notepad ${started ? 'started' : 'did NOT start'} after opening it like Nibo does`);
  try {
    execFileSync('taskkill', ['/IM', 'notepad.exe', '/F'], { stdio: 'ignore' });
  } catch {
    // not running
  }
});
