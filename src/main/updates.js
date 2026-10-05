'use strict';

// Is there a newer Nibo? Asks GitHub for the latest release and compares versions.
// Nibo never downloads or installs anything himself: the button opens the release
// in the user's browser, so they stay in charge. Only github.com/<repo>/releases
// addresses are ever opened.

const REPO = 'assergames80-prog/Nibo-AI';
const DEFAULT_API = 'https://api.github.com';
const TIMEOUT_MS = 15_000;

/** "v1.4.0" / "1.4" -> [1, 4, 0], or null when it isn't a version. */
function parseVersion(text) {
  const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?(?:[-+].*)?$/.exec(String(text ?? '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : null;
}

function isNewer(candidate, current) {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/** Only https://github.com/<repo>/releases/… may be opened. */
function isReleaseUrl(url, repo = REPO) {
  try {
    const u = new URL(String(url));
    return (
      u.protocol === 'https:' &&
      u.hostname === 'github.com' &&
      !u.username &&
      !u.password &&
      u.pathname.toLowerCase().startsWith(`/${repo.toLowerCase()}/releases/`)
    );
  } catch {
    return false;
  }
}

/**
 * GitHub's release JSON -> { version, url, assetUrl } for the page and (on Windows)
 * the installer or portable file that fits the user, or null if it isn't usable.
 */
function parseRelease(json, { portable = false, platform = process.platform, repo = REPO } = {}) {
  if (!json || typeof json !== 'object' || json.draft || json.prerelease) return null;
  const parts = parseVersion(typeof json.tag_name === 'string' ? json.tag_name : '');
  if (!parts) return null;
  const version = parts.join('.');
  const url = isReleaseUrl(json.html_url, repo) ? json.html_url : `https://github.com/${repo}/releases/tag/v${version}`;

  let assetUrl = null;
  if (platform === 'win32' && Array.isArray(json.assets)) {
    const wanted = portable ? /portable/i : /setup/i;
    const asset = json.assets.find(
      (a) =>
        a &&
        typeof a.name === 'string' &&
        /\.exe$/i.test(a.name) &&
        wanted.test(a.name) &&
        isReleaseUrl(a.browser_download_url, repo) &&
        a.browser_download_url.includes('/releases/download/'),
    );
    if (asset) assetUrl = asset.browser_download_url;
  }
  return { version, url, assetUrl };
}

/**
 * Asks GitHub. Resolves with one of
 *   { status: 'newer', release: { version, url, assetUrl } }
 *   { status: 'current', latest }
 *   { status: 'error', error }
 */
async function checkForUpdate({ current, portable = false, platform = process.platform, baseUrl, repo = REPO, fetchImpl = fetch, signal } = {}) {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  let res;
  try {
    res = await fetchImpl(`${baseUrl || DEFAULT_API}/repos/${repo}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Nibo-AI/${current}`, 'X-GitHub-Api-Version': '2022-11-28' },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  } catch (err) {
    return { status: 'error', error: `Could not reach GitHub: ${err.message}` };
  }
  if (!res.ok) return { status: 'error', error: `GitHub answered ${res.status}` };
  let json = null;
  try {
    json = await res.json();
  } catch {
    return { status: 'error', error: 'GitHub sent something unreadable' };
  }
  const release = parseRelease(json, { portable, platform, repo });
  if (!release) return { status: 'error', error: 'no usable release found' };
  return isNewer(release.version, current) ? { status: 'newer', release } : { status: 'current', latest: release.version };
}

const PREFIX = /^(?:(?:hey|hi|ok|okay)\s+)?(?:nibo\s*[,!:]?\s+)?(?:(?:please|pls|can you|could you|would you)\s+)*/i;
const THING = '(?:an?\\s+)?(?:new\\s+|newer\\s+)?(?:updates?|versions?|releases?)';
const CHECK = new RegExp(
  `^(?:check\\s+(?:for\\s+)?${THING}|look\\s+for\\s+${THING}|is\\s+there\\s+${THING}|are\\s+there\\s+(?:any\\s+)?(?:new\\s+)?updates?|any\\s+(?:new\\s+)?updates?|(?:am\\s+i|are\\s+you)\\s+up\\s*to\\s*date|update\\s+(?:yourself|nibo|check))\\b`,
  'i',
);
const VERSION = /^(?:what|which)\s+(?:version|release)\s+(?:are\s+you|am\s+i\s+(?:on|running|using)|is\s+this|do\s+you\s+(?:have|run))\b|^what(?:'s|\s+is)\s+your\s+version\b/i;

/** 'check' for "check for updates", 'version' for "what version are you?", else null. */
function detectIntent(text) {
  const body = String(text ?? '')
    .replace(/[’‘]/g, "'")
    .trim()
    .replace(/[\s.!?…]+$/, '')
    .replace(PREFIX, '');
  if (!body || body.length > 80) return null;
  if (CHECK.test(body)) return 'check';
  if (VERSION.test(body)) return 'version';
  return null;
}

module.exports = { DEFAULT_API, REPO, checkForUpdate, detectIntent, isNewer, isReleaseUrl, parseRelease, parseVersion };
