'use strict';

// Real file tidying: plan -> the user approves it in a popup -> move -> undo.
// Safety rules: only loose files directly inside the chosen folder are moved,
// nothing is ever deleted or overwritten, and every move is recorded for undo.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PILES = [
  {
    key: 'pictures',
    label: '🖼️ Pretty pictures',
    folder: 'Pictures',
    exts: ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.heic', '.ico', '.tif', '.tiff', '.avif', '.psd'],
  },
  {
    key: 'documents',
    label: '📄 Paper stuff',
    folder: 'Documents',
    exts: ['.pdf', '.doc', '.docx', '.txt', '.md', '.rtf', '.odt', '.xls', '.xlsx', '.csv', '.ods', '.ppt', '.pptx', '.odp', '.pages', '.key', '.numbers', '.epub'],
  },
  {
    key: 'media',
    label: '🎵 Noisy things',
    folder: 'Music & Videos',
    exts: ['.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aac', '.wma', '.mp4', '.mov', '.mkv', '.avi', '.webm', '.wmv', '.m4v'],
  },
  {
    key: 'archives',
    label: '📦 Mystery boxes',
    folder: 'Archives & Installers',
    exts: ['.zip', '.rar', '.7z', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.iso', '.msi', '.exe', '.msix', '.dmg', '.pkg', '.appimage', '.deb', '.rpm'],
  },
  {
    key: 'code',
    label: '🧪 Nerdy stuff',
    folder: 'Code',
    exts: ['.js', '.ts', '.py', '.json', '.html', '.css', '.java', '.c', '.cpp', '.h', '.cs', '.go', '.rs', '.rb', '.php', '.sh', '.bat', '.ps1', '.ipynb', '.sql', '.xml', '.yml', '.yaml'],
  },
];

const SHORTCUTS = new Set(['.lnk', '.url', '.desktop', '.website', '.appref-ms']);
const PARTIAL_DOWNLOADS = new Set(['.crdownload', '.part', '.partial', '.download', '.opdownload', '.tmp']);
const SYSTEM_NAMES = new Set(['desktop.ini', 'thumbs.db', 'iconcache.db', '.ds_store', '.localized']);
const RECENT_MS = 2 * 60 * 1000; // files touched this recently may still be in use
const MAX_ITEMS = 1000;

async function kindOf(p) {
  try {
    const st = await fs.promises.lstat(p);
    if (st.isDirectory()) return 'dir';
    if (st.isFile()) return 'file';
    return 'other';
  } catch {
    return null;
  }
}

function splitName(name) {
  const ext = path.extname(name);
  return { base: name.slice(0, name.length - ext.length), ext };
}

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Which folders Nibo may tidy: the user's well-known folders (Desktop,
 * Downloads, ...) and anything inside the home folder, except the home folder
 * itself, hidden folders and app data.
 */
function isAllowedFolder(folder, { home, known = [] }) {
  const abs = path.resolve(folder);
  if (known.some((k) => k && (path.relative(k, abs) === '' || isInside(k, abs)))) return true;
  if (!home || !isInside(home, abs)) return false;
  const parts = path.relative(home, abs).split(path.sep);
  return !parts.some((p) => p.startsWith('.') || /^(appdata|application data|library)$/i.test(p));
}

/** Look through `root` and plan where each loose file should go. */
async function buildPlan(folder, { now = Date.now(), label } = {}) {
  const root = path.resolve(folder);
  const dirents = await fs.promises.readdir(root, { withFileTypes: true });
  dirents.sort((a, b) => a.name.localeCompare(b.name));

  const skipped = { folders: 0, shortcuts: 0, unknown: 0, busy: 0, hidden: 0, more: 0 };
  const piles = new Map();
  const folderKinds = new Map();
  const takenNames = new Map(); // pile key -> Set of lower-case names already used
  let total = 0;

  for (const d of dirents) {
    const name = d.name;
    const lower = name.toLowerCase();
    if (lower.startsWith('.') || lower.startsWith('~$') || SYSTEM_NAMES.has(lower)) {
      skipped.hidden++;
      continue;
    }
    if (d.isDirectory()) {
      skipped.folders++;
      continue;
    }
    if (!d.isFile()) {
      skipped.hidden++;
      continue;
    }
    const ext = path.extname(lower);
    if (SHORTCUTS.has(ext)) {
      skipped.shortcuts++;
      continue;
    }
    if (PARTIAL_DOWNLOADS.has(ext)) {
      skipped.busy++;
      continue;
    }
    const pile = PILES.find((p) => p.exts.includes(ext));
    if (!pile) {
      skipped.unknown++;
      continue;
    }
    if (total >= MAX_ITEMS) {
      skipped.more++;
      continue;
    }

    const from = path.join(root, name);
    let st;
    try {
      st = await fs.promises.stat(from);
    } catch {
      skipped.busy++;
      continue;
    }
    if (now - st.mtimeMs < RECENT_MS) {
      skipped.busy++;
      continue;
    }

    const folderPath = path.join(root, pile.folder);
    if (!folderKinds.has(pile.key)) folderKinds.set(pile.key, await kindOf(folderPath));
    const folderKind = folderKinds.get(pile.key);
    if (folderKind && folderKind !== 'dir') {
      // A file with the folder's name is in the way: leave this pile alone.
      skipped.unknown++;
      continue;
    }

    if (!takenNames.has(pile.key)) takenNames.set(pile.key, new Set());
    const taken = takenNames.get(pile.key);
    const { base, ext: origExt } = splitName(name);
    let target = name;
    for (let n = 2; taken.has(target.toLowerCase()) || (folderKind && (await kindOf(path.join(folderPath, target)))); n++) {
      target = `${base} (${n})${origExt}`;
    }
    taken.add(target.toLowerCase());

    if (!piles.has(pile.key)) {
      piles.set(pile.key, { key: pile.key, label: pile.label, folder: pile.folder, folderExists: folderKind === 'dir', items: [] });
    }
    piles.get(pile.key).items.push({
      id: `f${total}`,
      name,
      size: st.size,
      from,
      to: path.join(folderPath, target),
      renamedTo: target === name ? null : target,
    });
    total++;
  }

  return {
    id: crypto.randomUUID(),
    root,
    label: label || path.basename(root) || root,
    piles: PILES.map((p) => piles.get(p.key)).filter(Boolean),
    skipped,
    total,
    createdAt: now,
  };
}

// Pick a name in `dir` that doesn't exist yet: "cat.jpg", "cat (2).jpg", ...
async function freeName(dir, name) {
  const { base, ext } = splitName(name);
  let candidate = name;
  for (let n = 2; await kindOf(path.join(dir, candidate)); n++) candidate = `${base} (${n})${ext}`;
  return path.join(dir, candidate);
}

function reasonOf(err) {
  const code = err && err.code;
  if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') return 'in use or protected';
  if (code === 'ENOENT') return 'not there anymore';
  if (code === 'EEXIST') return 'something else is in its spot';
  return (err && err.message) || 'unknown problem';
}

/** Move the approved items. Returns { moves, failed, createdDirs }. */
async function applyPlan(plan, approvedIds) {
  const approved = new Set(approvedIds);
  const moves = [];
  const failed = [];
  const createdDirs = [];

  for (const pile of plan.piles) {
    const items = pile.items.filter((i) => approved.has(i.id));
    if (items.length === 0) continue;

    const dir = path.join(plan.root, pile.folder);
    try {
      const kind = await kindOf(dir);
      if (kind && kind !== 'dir') throw Object.assign(new Error('a file is in the way'), { code: 'EEXIST' });
      if (!kind) {
        await fs.promises.mkdir(dir);
        createdDirs.push(dir);
      }
    } catch (err) {
      for (const item of items) failed.push({ name: item.name, reason: reasonOf(err) });
      continue;
    }

    for (const item of items) {
      try {
        // Only ever move a file that sits directly in the chosen folder.
        if (path.dirname(item.from) !== plan.root) throw new Error('outside the chosen folder');
        if ((await kindOf(item.from)) !== 'file') throw Object.assign(new Error('gone'), { code: 'ENOENT' });
        const dest = await freeName(dir, path.basename(item.to));
        await fs.promises.rename(item.from, dest);
        moves.push({ from: item.from, to: dest });
      } catch (err) {
        failed.push({ name: item.name, reason: reasonOf(err) });
      }
    }
  }
  return { moves, failed, createdDirs };
}

/** Put files back where they were and remove folders Nibo created (if empty). */
async function undoMoves(history) {
  let restored = 0;
  const failed = [];
  for (const move of [...(history.moves || [])].reverse()) {
    try {
      if (await kindOf(move.from)) throw Object.assign(new Error('taken'), { code: 'EEXIST' });
      if ((await kindOf(move.to)) !== 'file') throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      await fs.promises.rename(move.to, move.from);
      restored++;
    } catch (err) {
      failed.push({ name: path.basename(move.from), reason: reasonOf(err) });
    }
  }
  for (const dir of history.createdDirs || []) {
    try {
      await fs.promises.rmdir(dir); // only succeeds when empty
    } catch {
      // still has files in it: leave it
    }
  }
  return { restored, failed };
}

// ---------- undo history (last tidy-up only) ----------

function saveHistory(file, entry) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(entry, null, 2));
}

function loadHistory(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && Array.isArray(data.moves) && data.moves.length ? data : null;
  } catch {
    return null;
  }
}

function clearHistory(file) {
  try {
    fs.unlinkSync(file);
  } catch {
    // nothing to clear
  }
}

// ---------- what Nibo says ----------

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// The plan as the approval popup sees it (no absolute paths needed there).
function publicPlan(plan) {
  return {
    root: plan.root,
    label: plan.label,
    total: plan.total,
    skipped: plan.skipped,
    piles: plan.piles.map((p) => ({
      key: p.key,
      label: p.label,
      folder: p.folder,
      folderExists: p.folderExists,
      items: p.items.map((i) => ({ id: i.id, name: i.name, size: i.size, renamedTo: i.renamedTo })),
    })),
  };
}

function describeEmpty(plan) {
  const left = plan.skipped.shortcuts + plan.skipped.folders + plan.skipped.unknown;
  return left
    ? `Your ${plan.label} is already pretty tidy! ✨ I only see shortcuts, folders and things I'm not sure about, so I'll leave them be.`
    : `Your ${plan.label} is spotless! ✨ Nothing for me to tidy.`;
}

function describeResult(result) {
  const folders = new Set(result.moves.map((m) => path.dirname(m.to))).size;
  let text = result.moves.length
    ? `All done! 🧹✨ I moved ${plural(result.moves.length, 'file')} into ${plural(folders, 'folder')}.`
    : "Hmm, I couldn't move anything. 😿";
  if (result.failed.length) {
    const sample = result.failed
      .slice(0, 3)
      .map((f) => `${f.name} (${f.reason})`)
      .join(', ');
    text += `\nI left ${plural(result.failed.length, 'file')} alone: ${sample}${result.failed.length > 3 ? ', …' : ''}`;
  }
  return text;
}

function describeUndo(res) {
  let text = res.restored ? `Okay! I put ${plural(res.restored, 'file')} back where they were. ↩️` : "Hmm, I couldn't put anything back. 😿";
  if (res.failed.length) text += `\n${plural(res.failed.length, 'file')} stayed put (moved or renamed since).`;
  return text;
}

module.exports = {
  PILES,
  isAllowedFolder,
  buildPlan,
  applyPlan,
  undoMoves,
  saveHistory,
  loadHistory,
  clearHistory,
  publicPlan,
  describeEmpty,
  describeResult,
  describeUndo,
};
