'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const organizer = require('../src/main/organizer');

const LATER = Date.now() + 10 * 60 * 1000; // pretend every file is "old"

function makeFolder(files = [], dirs = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nibo-org-'));
  for (const d of dirs) fs.mkdirSync(path.join(root, d), { recursive: true });
  for (const f of files) fs.writeFileSync(path.join(root, f), `content of ${f}`);
  return root;
}

const ls = (dir) => fs.readdirSync(dir).sort();
const allIds = (plan) => plan.piles.flatMap((p) => p.items.map((i) => i.id));

test('plans piles for loose files and skips what it should', async () => {
  const root = makeFolder(
    ['cat.jpg', 'notes.txt', 'song.mp3', 'setup.exe', 'script.py', 'Chrome.lnk', 'desktop.ini', '.hidden.png', '~$draft.docx', 'movie.mp4.crdownload', 'weird.xyz'],
    ['Projects'],
  );
  const plan = await organizer.buildPlan(root, { now: LATER, label: 'Desktop' });

  assert.equal(plan.total, 5);
  assert.deepEqual(
    plan.piles.map((p) => [p.folder, p.items.map((i) => i.name)]),
    [
      ['Pictures', ['cat.jpg']],
      ['Documents', ['notes.txt']],
      ['Music & Videos', ['song.mp3']],
      ['Archives & Installers', ['setup.exe']],
      ['Code', ['script.py']],
    ],
  );
  assert.deepEqual(plan.skipped, { folders: 1, shortcuts: 1, unknown: 1, busy: 1, hidden: 3, more: 0 });
  assert.equal(plan.piles[0].folderExists, false);
});

test('leaves recently changed files alone', async () => {
  const root = makeFolder(['fresh.png']);
  const plan = await organizer.buildPlan(root);
  assert.equal(plan.total, 0);
  assert.equal(plan.skipped.busy, 1);
  assert.match(organizer.describeEmpty({ ...plan, label: 'Desktop' }), /Desktop/);
});

test('never plans to overwrite: clashing names get a number', async () => {
  const root = makeFolder(['cat.jpg'], ['Pictures']);
  fs.writeFileSync(path.join(root, 'Pictures', 'cat.jpg'), 'the old cat');
  const plan = await organizer.buildPlan(root, { now: LATER });
  const item = plan.piles[0].items[0];
  assert.equal(plan.piles[0].folderExists, true);
  assert.equal(item.renamedTo, 'cat (2).jpg');
  assert.equal(item.to, path.join(root, 'Pictures', 'cat (2).jpg'));
});

test('a file named like a pile folder blocks that pile', async () => {
  const root = makeFolder(['cat.jpg', 'Pictures']);
  const plan = await organizer.buildPlan(root, { now: LATER });
  assert.equal(plan.total, 0);
});

test('moves only the approved files, then undo puts them back', async () => {
  const root = makeFolder(['a.jpg', 'b.jpg', 'report.pdf', 'keep.zip']);
  const plan = await organizer.buildPlan(root, { now: LATER });
  const approved = allIds(plan).filter((id) => {
    const item = plan.piles.flatMap((p) => p.items).find((i) => i.id === id);
    return item.name !== 'keep.zip';
  });

  const result = await organizer.applyPlan(plan, approved);
  assert.equal(result.moves.length, 3);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(ls(root), ['Documents', 'Pictures', 'keep.zip']);
  assert.deepEqual(ls(path.join(root, 'Pictures')), ['a.jpg', 'b.jpg']);
  assert.equal(result.createdDirs.length, 2);
  assert.match(organizer.describeResult(result), /moved 3 files into 2 folders/);

  const undo = await organizer.undoMoves(result);
  assert.equal(undo.restored, 3);
  assert.deepEqual(ls(root), ['a.jpg', 'b.jpg', 'keep.zip', 'report.pdf']);
  assert.equal(fs.readFileSync(path.join(root, 'a.jpg'), 'utf8'), 'content of a.jpg');
});

test('applying never overwrites a file that appeared after planning', async () => {
  const root = makeFolder(['cat.jpg'], ['Pictures']);
  const plan = await organizer.buildPlan(root, { now: LATER });
  fs.writeFileSync(path.join(root, 'Pictures', 'cat.jpg'), 'surprise cat');

  const result = await organizer.applyPlan(plan, allIds(plan));
  assert.deepEqual(ls(path.join(root, 'Pictures')), ['cat (2).jpg', 'cat.jpg']);
  assert.equal(fs.readFileSync(path.join(root, 'Pictures', 'cat.jpg'), 'utf8'), 'surprise cat');
  assert.equal(result.moves[0].to, path.join(root, 'Pictures', 'cat (2).jpg'));
});

test('reports files that vanished before approval', async () => {
  const root = makeFolder(['gone.png', 'here.png']);
  const plan = await organizer.buildPlan(root, { now: LATER });
  fs.unlinkSync(path.join(root, 'gone.png'));
  const result = await organizer.applyPlan(plan, allIds(plan));
  assert.equal(result.moves.length, 1);
  assert.deepEqual(result.failed, [{ name: 'gone.png', reason: 'not there anymore' }]);
  assert.match(organizer.describeResult(result), /left 1 file alone: gone\.png/);
});

test('ignores tampered plan items outside the chosen folder', async () => {
  const root = makeFolder(['cat.png']);
  const outside = makeFolder(['secret.png']);
  const plan = await organizer.buildPlan(root, { now: LATER });
  plan.piles[0].items[0].from = path.join(outside, 'secret.png');
  const result = await organizer.applyPlan(plan, allIds(plan));
  assert.equal(result.moves.length, 0);
  assert.deepEqual(ls(outside), ['secret.png']);
});

test('undo keeps folders that still have files and skips taken spots', async () => {
  const root = makeFolder(['a.png', 'b.png']);
  const plan = await organizer.buildPlan(root, { now: LATER });
  const result = await organizer.applyPlan(plan, allIds(plan));
  fs.writeFileSync(path.join(root, 'b.png'), 'a new b');
  fs.writeFileSync(path.join(root, 'Pictures', 'mine.png'), 'added later');

  const undo = await organizer.undoMoves(result);
  assert.equal(undo.restored, 1);
  assert.equal(undo.failed.length, 1);
  assert.equal(fs.readFileSync(path.join(root, 'b.png'), 'utf8'), 'a new b');
  assert.deepEqual(ls(path.join(root, 'Pictures')), ['b.png', 'mine.png']);
  assert.match(organizer.describeUndo(undo), /put 1 file back/);
});

test('only tidies folders inside the user folder', () => {
  const home = path.join(path.sep, 'home', 'bun');
  const known = [path.join(home, 'Desktop'), path.join(path.sep, 'mnt', 'd', 'Downloads')];
  const ok = (p) => organizer.isAllowedFolder(p, { home, known });
  assert.equal(ok(path.join(home, 'Desktop')), true);
  assert.equal(ok(path.join(home, 'Documents', 'School')), true);
  assert.equal(ok(path.join(path.sep, 'mnt', 'd', 'Downloads')), true);
  assert.equal(ok(home), false);
  assert.equal(ok(path.join(home, 'AppData', 'Roaming')), false);
  assert.equal(ok(path.join(home, '.config')), false);
  assert.equal(ok(path.join(path.sep, 'etc')), false);
  assert.equal(ok(path.sep), false);
});

test('remembers the last tidy-up for undo', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nibo-hist-')), 'history.json');
  assert.equal(organizer.loadHistory(file), null);
  organizer.saveHistory(file, { at: 1, root: '/x', moves: [{ from: '/x/a', to: '/x/P/a' }], createdDirs: [] });
  assert.equal(organizer.loadHistory(file).moves.length, 1);
  organizer.clearHistory(file);
  assert.equal(organizer.loadHistory(file), null);
});

test('the popup only gets what it needs', async () => {
  const root = makeFolder(['cat.png']);
  const plan = await organizer.buildPlan(root, { now: LATER });
  const pub = organizer.publicPlan(plan);
  assert.deepEqual(Object.keys(pub.piles[0].items[0]).sort(), ['id', 'name', 'renamedTo', 'size']);
});
