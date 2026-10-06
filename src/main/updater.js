'use strict';

// One-click updates. Nibo downloads the new version from the project's GitHub release
// page, checks it is exactly the file GitHub says it is (its size and SHA-256), and then
// either runs the installer silently (installed version) or swaps the file in place
// (portable version). Anything unexpected stops the update and leaves everything as it was.
// Plain logic with injectable pieces, so it can be tested without Electron.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { once } = require('events');
const { finished } = require('stream/promises');
const { spawn } = require('child_process');
const updates = require('./updates');

// GitHub serves release files from github.com and then from githubusercontent.com.
const HOSTS = ['github.com', 'githubusercontent.com'];

class UpdateError extends Error {
  constructor(message, kind) {
    super(message);
    this.name = 'UpdateError';
    this.kind = kind; // 'network' | 'verify' | 'install' | 'cancelled'
  }
}

function hostAllowed(url, hosts = HOSTS, { requireHttps = true } = {}) {
  try {
    const { hostname, protocol } = new URL(String(url));
    return (protocol === 'https:' || !requireHttps) && hosts.some((h) => hostname === h || hostname.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

/** Can this copy of Nibo update itself, and if not, why not? */
function supported({ update, packaged, platform, portableFile, writable = (dir) => canWrite(dir) }) {
  if (!update) return { ok: false, reason: 'no update' };
  if (!packaged) return { ok: false, reason: 'not an installed copy' };
  if (platform !== 'win32') return { ok: false, reason: 'one-click updates are for Windows' };
  if (!update.assetUrl) return { ok: false, reason: 'no file to download' };
  if (!update.sha256 || !update.size) return { ok: false, reason: "GitHub didn't say how to check the file" };
  if (portableFile && !writable(path.dirname(portableFile))) return { ok: false, reason: "I can't write to the folder I live in" };
  return { ok: true };
}

function canWrite(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Downloads `url` to `to`, but only keeps it if it is exactly `size` bytes with the
 * SHA-256 `sha256`. Throws UpdateError and leaves nothing behind otherwise.
 * onProgress({ received, total, percent }) is called a few times a second.
 */
async function download({ url, to, size, sha256, repo, fetchImpl = fetch, allowHosts = HOSTS, requireHttps = true, onProgress, signal }) {
  if (!updates.isReleaseUrl(url, repo)) throw new UpdateError('not a release address', 'verify');
  if (!Number.isSafeInteger(size) || size <= 0 || size > updates.MAX_ASSET_BYTES) throw new UpdateError('unknown file size', 'verify');
  if (!/^[0-9a-f]{64}$/.test(String(sha256))) throw new UpdateError('unknown checksum', 'verify');

  const part = `${to}.part`;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  let out = null; // only opened once GitHub has answered with something worth keeping
  const cleanup = async () => {
    if (out && !out.destroyed) {
      const closed = once(out, 'close').catch(() => {});
      out.destroy();
      await closed;
    }
    try {
      fs.rmSync(part, { force: true });
    } catch {
      // nothing to clean
    }
  };
  const cancelled = () => new UpdateError('cancelled', 'cancelled');

  try {
    let res;
    try {
      res = await fetchImpl(url, { redirect: 'follow', headers: { 'User-Agent': 'Nibo-AI' }, signal });
    } catch (err) {
      if (signal && signal.aborted) throw cancelled();
      throw new UpdateError(`could not reach GitHub: ${err.message}`, 'network');
    }
    if (!res.ok) throw new UpdateError(`GitHub answered ${res.status}`, 'network');
    if (res.url && !hostAllowed(res.url, allowHosts, { requireHttps })) throw new UpdateError('the download came from somewhere unexpected', 'verify');
    const announced = Number(res.headers.get('content-length'));
    if (announced && announced !== size) throw new UpdateError(`the file is ${announced} bytes, not ${size}`, 'verify');
    if (!res.body) throw new UpdateError('nothing to download', 'network');

    out = fs.createWriteStream(part);
    out.on('error', () => {}); // surfaced through write/finished below
    const hash = crypto.createHash('sha256');
    let received = 0;
    let lastReport = 0;
    try {
      for await (const chunk of res.body) {
        if (signal && signal.aborted) throw cancelled();
        received += chunk.length;
        if (received > size) throw new UpdateError('the download is bigger than it should be', 'verify');
        hash.update(chunk);
        if (!out.write(chunk)) await once(out, 'drain');
        const now = Date.now();
        if (onProgress && now - lastReport > 150) {
          lastReport = now;
          onProgress({ received, total: size, percent: Math.min(99, Math.floor((received / size) * 100)) });
        }
      }
    } catch (err) {
      if (err instanceof UpdateError) throw err;
      if (signal && signal.aborted) throw cancelled();
      throw new UpdateError(`the download broke off: ${err.message}`, 'network');
    }
    if (signal && signal.aborted) throw cancelled();
    out.end();
    await finished(out);

    if (received !== size) throw new UpdateError(`got ${received} bytes instead of ${size}`, 'verify');
    if (hash.digest('hex') !== sha256) throw new UpdateError("the file doesn't match its checksum", 'verify');
    fs.renameSync(part, to);
    if (onProgress) onProgress({ received, total: size, percent: 100 });
    return { path: to, bytes: received };
  } catch (err) {
    await cleanup();
    throw err;
  }
}

// ---------- installed version: run the installer ----------

/** The flags electron-builder's installer understands: quiet, "this is an update", start Nibo again after. */
const installerArgs = () => ['--updated', '/S', '--force-run'];

/**
 * Starts the installer and gives it a moment. Resolves once it is running; rejects if it
 * couldn't start or stopped with an error straight away. The caller then quits Nibo so
 * the installer can replace his files (it also closes him itself if need be).
 */
function launchInstaller(file, { spawnImpl = spawn, graceMs = 2500 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(file, installerArgs(), { detached: true, stdio: 'ignore', windowsHide: true });
    } catch (err) {
      reject(new UpdateError(`the installer wouldn't start: ${err.message}`, 'install'));
      return;
    }
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    child.once('error', (err) => settle(reject, new UpdateError(`the installer wouldn't start: ${err.message}`, 'install')));
    child.once('exit', (code) => {
      // (An installer that asks Windows for permission starts a second copy and ends: fine.)
      if (code) settle(reject, new UpdateError(`the installer stopped (code ${code})`, 'install'));
      else settle(resolve);
    });
    const timer = setTimeout(() => {
      if (child.unref) child.unref();
      settle(resolve);
    }, graceMs);
  });
}

// ---------- portable version: swap the file ----------

/**
 * Puts the new portable file where the old one is, keeping the old one as ".old" until
 * the new one has started. Windows lets a running program be renamed (just not replaced
 * or deleted), so Nibo can do this himself while he is still running.
 * Returns { old, undo() }; undo() puts everything back the way it was.
 */
function swapInPlace({ target, fresh }, fsImpl = fs) {
  const old = `${target}.old`;
  if (!fsImpl.existsSync(fresh)) throw new UpdateError('the new file is missing', 'install');
  try {
    fsImpl.rmSync(old, { force: true }); // a leftover from an earlier update
  } catch (err) {
    throw new UpdateError(`couldn't clear the way for the swap: ${err.message}`, 'install');
  }
  try {
    fsImpl.renameSync(target, old);
  } catch (err) {
    throw new UpdateError(`couldn't move the old file aside: ${err.message}`, 'install');
  }
  try {
    fsImpl.renameSync(fresh, target);
  } catch (err) {
    try {
      fsImpl.renameSync(old, target); // put the old one back
    } catch {
      // (nothing more can be done; the next start-up looks for ".old")
    }
    throw new UpdateError(`couldn't put the new file in place: ${err.message}`, 'install');
  }
  return {
    old,
    undo() {
      try {
        fsImpl.renameSync(target, fresh);
        fsImpl.renameSync(old, target);
      } catch {
        // best effort
      }
    },
  };
}

/**
 * Starts the (new) portable file on its own and resolves once it is running. It is
 * started with --updated, so it knows to wait for this Nibo to finish quitting.
 */
function startPortable(file, { spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(file, ['--updated'], { detached: true, stdio: 'ignore', windowsHide: false });
    } catch (err) {
      reject(new UpdateError(`the new Nibo wouldn't start: ${err.message}`, 'install'));
      return;
    }
    child.once('error', (err) => reject(new UpdateError(`the new Nibo wouldn't start: ${err.message}`, 'install')));
    child.once('spawn', () => {
      if (child.unref) child.unref();
      resolve();
    });
  });
}

/** The portable update: swap the file, start the new one, and undo the swap if that fails. */
async function replacePortable({ target, fresh }, { fsImpl = fs, spawnImpl = spawn } = {}) {
  const swap = swapInPlace({ target, fresh }, fsImpl);
  try {
    await startPortable(target, { spawnImpl });
  } catch (err) {
    swap.undo();
    throw err;
  }
  return swap;
}

module.exports = {
  HOSTS,
  UpdateError,
  download,
  hostAllowed,
  installerArgs,
  launchInstaller,
  replacePortable,
  startPortable,
  supported,
  swapInPlace,
};
