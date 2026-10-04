'use strict';

// Opening apps for the user. On Windows the list of apps comes from the Start
// menu (the same list as "All apps", Store apps included), so Nibo can only
// start what is installed and what the user could start from there too. He
// also knows the user's own folders and a few popular websites. He never runs
// commands or paths that someone typed: names are only ever looked up here.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const LIST_TIMEOUT_MS = 30_000;
const CACHE_MS = 10 * 60_000; // after this, refresh the list in the background
const RECHECK_MS = 30_000; // look again for a missing app if the list is older than this
const STRONG = 85; // sure enough to open it straight away
const WEAK = 70; // only good enough for "did you mean…?"
const MAX_CHOICES = 4;

// Lists the Start menu apps as base64 UTF-8 JSON, so no console code page can
// mangle names like "Przeglądarka" or "計算機".
const LIST_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$apps = @(Get-StartApps | ForEach-Object { [pscustomobject]@{ name = [string]$_.Name; id = [string]$_.AppID } })
$json = ConvertTo-Json -InputObject $apps -Compress
[Console]::Out.Write([Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($json)))
`;

// Built into Windows. These help when the Start menu names are in another
// language ("Kalkulator") or an app is missing from the list.
const BUILTINS = [
  { name: 'File Explorer', file: 'explorer.exe', aliases: ['explorer', 'windows explorer', 'files', 'file manager', 'this pc', 'my computer'] },
  { name: 'Calculator', file: 'System32\\calc.exe', aliases: ['calc'] },
  { name: 'Notepad', file: 'System32\\notepad.exe' },
  { name: 'Paint', file: 'System32\\mspaint.exe', aliases: ['ms paint', 'mspaint'] },
  { name: 'Task Manager', file: 'System32\\Taskmgr.exe', aliases: ['taskmgr'] },
  { name: 'Command Prompt', file: 'System32\\cmd.exe', aliases: ['cmd', 'command line'] },
  { name: 'Windows PowerShell', file: 'System32\\WindowsPowerShell\\v1.0\\powershell.exe', aliases: ['powershell'] },
  { name: 'Control Panel', file: 'System32\\control.exe' },
  { name: 'Settings', uri: 'ms-settings:', aliases: ['windows settings', 'pc settings', 'system settings'] },
].map((b) => ({ kind: 'builtin', ...b }));

// Popular websites, for when there's no app by that name.
const WEBSITES = [
  ['YouTube', 'https://www.youtube.com/', ['yt']],
  ['Gmail', 'https://mail.google.com/', ['google mail']],
  ['Google', 'https://www.google.com/'],
  ['Google Maps', 'https://maps.google.com/', ['maps']],
  ['Google Drive', 'https://drive.google.com/', ['drive']],
  ['Google Docs', 'https://docs.google.com/'],
  ['Netflix', 'https://www.netflix.com/'],
  ['Reddit', 'https://www.reddit.com/'],
  ['Wikipedia', 'https://www.wikipedia.org/'],
  ['GitHub', 'https://github.com/'],
  ['Twitch', 'https://www.twitch.tv/'],
  ['X', 'https://x.com/', ['twitter']],
  ['Facebook', 'https://www.facebook.com/'],
  ['Instagram', 'https://www.instagram.com/'],
  ['Amazon', 'https://www.amazon.com/'],
  ['Spotify', 'https://open.spotify.com/'],
  ['Discord', 'https://discord.com/app'],
  ['WhatsApp', 'https://web.whatsapp.com/', ['whats app']],
  ['Outlook', 'https://outlook.live.com/'],
].map(([name, url, aliases = []]) => ({ kind: 'site', name, url, aliases }));

// Other names people use for common apps.
const ALIASES = {
  'visual studio code': ['vs code', 'vscode', 'code'],
  'microsoft edge': ['edge'],
  'microsoft store': ['store', 'app store', 'windows store'],
  'windows terminal': ['terminal'],
  'microsoft teams': ['teams'],
  'mozilla firefox': ['firefox'],
  'file explorer': ['explorer', 'files', 'file manager', 'this pc', 'my computer'],
};

// Start menu entries that aren't apps you'd want to open.
const JUNK_NAME =
  /\b(?:uninstall\w*|deinstall\w*|readme|read me|release notes|licen[cs]e|documentation|manual|help|website|web site|support|faq|changelog)\b/i;
const JUNK_ID = /^(?:https?|ftp|mailto):|\.(?:txt|pdf|html?|chm|url|rtf|md|log|ini|xml)$/i;

// ---------- matching ----------

function normalize(text) {
  return String(text || '')
    .replace(/[™®©]/g, '')
    .toLowerCase()
    .replace(/ł/g, 'l')
    .replace(/ø/g, 'o')
    .replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const LEADING = /^(?:the|my|a|an|up)\s+/;
const TRAILING = /\s+(?:app|apps|application|program|programme|software|folder|for me|please|pls|now|right now|real quick|quickly)$/;

function cleanQuery(text) {
  let q = normalize(text);
  for (let prev = null; q !== prev; ) {
    prev = q;
    q = q.replace(LEADING, '').replace(TRAILING, '').trim();
  }
  return q;
}

function levenshtein(a, b, max = 3) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, next[j]);
    }
    if (best > max) return max + 1;
    row = next;
  }
  return row[b.length];
}

function aliasesOf(entry) {
  return [...(entry.aliases || []), ...(ALIASES[normalize(entry.name)] || [])].map(normalize);
}

/** How well a cleaned-up query names an entry, 0-100. */
function score(q, entry) {
  const n = normalize(entry.name);
  if (!q || !n) return 0;
  if (q === n) return 100;
  if (aliasesOf(entry).includes(q)) return 99;
  const qc = q.replace(/ /g, '');
  const nc = n.replace(/ /g, '');
  if (qc === nc) return 98;

  // Every word of the query should be (the start of) a word in the name.
  const qt = q.split(' ');
  const nt = n.split(' ');
  let total = 0;
  for (const t of qt) {
    let best = 0;
    for (const u of nt) {
      if (u === t) best = 1;
      else if (t.length >= 3 && u.startsWith(t)) best = Math.max(best, 0.6);
      else if (t.length >= 5 && levenshtein(t, u, 1) <= 1) best = Math.max(best, 0.7);
    }
    if (!best) {
      total = 0;
      break;
    }
    total += best;
  }
  if (total) return 70 + 20 * (total / qt.length) + 10 * Math.min(1, qt.length / nt.length);

  // Typos: "spotfy", "calculater".
  if (q.length >= 4 && levenshtein(q, n, 2) <= (q.length >= 8 ? 2 : 1)) return 85;
  if (qc.length >= 4 && nc.startsWith(qc)) return 75;
  return 0;
}

function rank(q, entries) {
  const seen = new Set();
  return entries
    .map((entry) => ({ entry, score: score(q, entry) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .filter((r) => {
      const key = normalize(r.entry.name);
      return !seen.has(key) && seen.add(key);
    });
}

// "youtube.com", "www.bbc.co.uk/news" -> a website to open.
function asDomain(text) {
  const t = String(text || '').trim().replace(/^https?:\/\//i, '');
  const m = t.match(/^((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24})(\/[^\s]*)?$/i);
  return m ? { kind: 'site', name: m[1].toLowerCase(), url: `https://${m[1].toLowerCase()}${m[2] || '/'}` } : null;
}

/**
 * Finds what the user means by `phrase`. `tiers` is a list of entry lists,
 * best first (installed apps and folders, then Windows built-ins, then websites).
 * An exact name wins in any tier; otherwise a later tier only counts when an
 * earlier one has no strong match.
 * Returns { match, choices, query }: a match to open right away, or choices to
 * ask about (several equally good matches, or "did you mean…?" suggestions).
 */
function resolve(phrase, tiers) {
  const site = asDomain(phrase);
  if (site) return { match: site, choices: [], query: site.name };
  const q = cleanQuery(phrase);
  if (!q) return { match: null, choices: [], query: q };

  const rankedTiers = tiers.map((tier) => rank(q, tier || []));
  // A spot-on name anywhere beats a partial one: "google" is google.com, not Google Chrome.
  for (const ranked of rankedTiers) {
    const best = ranked[0];
    if (!best || best.score < 98) continue;
    const tied = ranked.filter((r) => r.score === best.score);
    if (tied.length > 1) return { match: null, choices: tied.slice(0, MAX_CHOICES).map((r) => r.entry), query: q, ambiguous: true };
    return { match: best.entry, choices: [], query: q };
  }
  const maybe = [];
  for (const ranked of rankedTiers) {
    const best = ranked[0];
    if (best && best.score >= STRONG) {
      const tied = ranked.filter((r) => r.score >= best.score - 1);
      if (tied.length > 1) return { match: null, choices: tied.slice(0, MAX_CHOICES).map((r) => r.entry), query: q, ambiguous: true };
      return { match: best.entry, choices: [], query: q };
    }
    maybe.push(...ranked.filter((r) => r.score >= WEAK));
  }
  const seen = new Set();
  const choices = maybe
    .sort((a, b) => b.score - a.score)
    .filter((r) => !seen.has(r.entry.name) && seen.add(r.entry.name))
    .slice(0, 3)
    .map((r) => r.entry);
  return { match: null, choices, query: q };
}

/** "spotify and discord" -> ['spotify', 'discord'] (at most 3), or [] if it's just one name. */
function splitNames(phrase) {
  const parts = String(phrase || '')
    .split(/\s*(?:,|\band\b|&|\+)\s*/i)
    .map((p) => p.trim())
    .filter(Boolean);
  return parts.length > 1 && parts.length <= 3 ? parts : [];
}

// ---------- the list of installed apps ----------

function isJunk(name, id = '') {
  return !name || JUNK_NAME.test(name) || JUNK_ID.test(id);
}

/** Parses the helper's output into app entries. */
function parseStartApps(output) {
  let list;
  try {
    list = JSON.parse(Buffer.from(String(output).trim(), 'base64').toString('utf8'));
  } catch {
    throw new Error('could not read the app list');
  }
  if (list && !Array.isArray(list)) list = [list];
  return (list || [])
    .filter((a) => a && typeof a.name === 'string' && typeof a.id === 'string' && a.id.trim())
    .filter((a) => !isJunk(a.name.trim(), a.id))
    .map((a) => ({ kind: 'app', name: a.name.trim(), id: a.id.trim() }));
}

function loadStartApps({ run = execFile } = {}) {
  const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'];
  args.push(Buffer.from(LIST_SCRIPT, 'utf16le').toString('base64'));
  return new Promise((resolve, reject) => {
    run('powershell.exe', args, { windowsHide: true, timeout: LIST_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${err.message} ${String(stderr || '').trim().slice(-300)}`.trim()));
      try {
        resolve(parseStartApps(stdout));
      } catch (parseErr) {
        reject(parseErr);
      }
    });
  });
}

function startMenuFolders(env = process.env) {
  return [env.ProgramData, env.APPDATA]
    .filter(Boolean)
    .map((base) => path.join(base, 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
}

/** Plan B: the shortcuts in the Start menu folders. */
async function scanShortcuts(folders = startMenuFolders(), depth = 4) {
  const found = [];
  async function walk(dir, level) {
    let items;
    try {
      items = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) {
        if (level < depth) await walk(full, level + 1);
      } else if (/\.(?:lnk|appref-ms)$/i.test(item.name)) {
        const name = item.name.replace(/\.(?:lnk|appref-ms)$/i, '').trim();
        if (!isJunk(name)) found.push({ kind: 'shortcut', name, path: full });
      }
    }
  }
  for (const folder of folders) await walk(folder, 0);
  return found;
}

class AppCatalog {
  /**
   * opts.platform                  defaults to process.platform
   * opts.loadStartApps()           -> entries (injectable for tests)
   * opts.scanShortcuts()           -> entries, used when the first one fails
   * opts.now()                     clock, for tests
   */
  constructor(opts = {}) {
    this.platform = opts.platform || process.platform;
    this.loadStartApps = opts.loadStartApps || (() => loadStartApps());
    this.scanShortcuts = opts.scanShortcuts || (() => scanShortcuts());
    this.now = opts.now || Date.now;
    this.apps = null;
    this.loadedAt = 0;
    this.loading = null;
    this.source = null;
  }

  supported() {
    return this.platform === 'win32';
  }

  load() {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      let apps;
      try {
        apps = await this.loadStartApps();
        this.source = 'start-apps';
        if (!apps.length) throw new Error('empty list');
      } catch (err) {
        console.error('[nibo] Start menu app list failed, scanning shortcuts instead:', err.message);
        apps = await this.scanShortcuts().catch(() => []);
        this.source = 'shortcuts';
      }
      this.apps = apps;
      this.loadedAt = this.now();
      return apps;
    })().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  /** Starts loading the list early, so the first "open …" is quick. */
  warm() {
    if (this.supported() && !this.apps) this.load().catch(() => {});
  }

  /** The installed apps. A stale list is used as is and refreshed in the background. */
  async installed({ fresh = false } = {}) {
    if (!this.supported()) return [];
    if (!this.apps || fresh) return this.load();
    if (this.now() - this.loadedAt > CACHE_MS) this.load().catch(() => {});
    return this.apps;
  }

  /** True when an app may have been installed since the list was made. */
  mayBeStale() {
    return this.supported() && this.now() - this.loadedAt > RECHECK_MS;
  }
}

// ---------- opening ----------

/**
 * Opens an entry. Returns null when it worked, or an error message.
 * deps: { openPath(path) -> Promise<string>, openExternal(url), spawnDetached(file, args), systemRoot }
 */
async function launch(entry, deps) {
  try {
    switch (entry.kind) {
      case 'app':
        // Works for Store apps and regular ones: the same as clicking it in the Start menu.
        deps.spawnDetached('explorer.exe', [`shell:AppsFolder\\${entry.id}`]);
        return null;
      case 'shortcut':
      case 'folder':
        return (await deps.openPath(entry.path)) || null;
      case 'builtin':
        if (entry.uri) {
          await deps.openExternal(entry.uri);
          return null;
        }
        return (await deps.openPath(path.win32.join(deps.systemRoot || 'C:\\Windows', entry.file))) || null;
      case 'site':
        await deps.openExternal(entry.url);
        return null;
      default:
        return 'unknown kind of thing to open';
    }
  } catch (err) {
    return err.message || String(err);
  }
}

module.exports = {
  AppCatalog,
  BUILTINS,
  WEBSITES,
  LIST_SCRIPT,
  STRONG,
  WEAK,
  asDomain,
  cleanQuery,
  launch,
  levenshtein,
  loadStartApps,
  normalize,
  parseStartApps,
  rank,
  resolve,
  scanShortcuts,
  score,
  splitNames,
  startMenuFolders,
};
