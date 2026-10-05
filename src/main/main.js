'use strict';

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const {
  app,
  BrowserWindow,
  Menu,
  dialog,
  globalShortcut,
  Tray,
  ipcMain,
  nativeImage,
  powerMonitor,
  safeStorage,
  screen,
  session,
  shell,
  systemPreferences,
} = require('electron');

const { Store, MIC_SENSITIVITIES } = require('./store');
const { Brain, DEFAULT_MODEL, testKey } = require('./brain');
const pet = require('./pet');
const offline = require('./offline');
const organizer = require('./organizer');
const web = require('./websearch');
const apps = require('./apps');
const reminders = require('./reminders');
const when = require('./when');
const { WindowsVoice } = require('./tts');

const WIN_W = 360;
const WIN_H = 620;
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
// Forwarded mouse events (needed for click-through) only exist on Windows and macOS.
const CLICK_THROUGH = IS_WIN || IS_MAC;
const ASSETS = path.join(__dirname, '..', '..', 'assets');
const RENDERER = path.join(__dirname, '..', 'renderer');
const VOICE_HOTKEY = 'CommandOrControl+Alt+Space';

// Let the microphone's echo cancellation remove everything Nibo plays (his
// voice), not just WebRTC call audio, so the user can talk over him.
const enabledFeatures = app.commandLine.getSwitchValue('enable-features');
app.commandLine.appendSwitch('enable-features', [enabledFeatures, 'ChromeWideEchoCancellation'].filter(Boolean).join(','));

let win = null;
let settingsWin = null;
let organizeWin = null;
let pendingPlan = null;
let settleApproval = null; // resolves the open approval popup's promise
let canUndoOrganize = false;
let fileJob = false; // a tidy-up or undo is in progress
let hotkeyReady = false;
let tray = null;
let store = null;
let brain = null;
let petState = null;
let dragTimer = null;
let hopping = false;
const inflight = new Map();
const windowsVoice = new WindowsVoice();
const appCatalog = new apps.AppCatalog();
let book = null; // the reminders and timers (reminders.json)
let pendingWhen = null; // Nibo just asked "when?" and is waiting for a time
let fired = []; // reminders that rang lately: { ...item, firedAt, acked, snoozed }

// ---------- helpers ----------

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function fromBunny(event) {
  return win && !win.isDestroyed() && event.sender === win.webContents;
}

function fromSettings(event) {
  return settingsWin && !settingsWin.isDestroyed() && event.sender === settingsWin.webContents;
}

function fromOrganize(event) {
  return organizeWin && !organizeWin.isDestroyed() && event.sender === organizeWin.webContents;
}

const historyFile = () => path.join(app.getPath('userData'), 'organize-history.json');

const iconPath = () => path.join(ASSETS, 'icon.png');

// Keep the bunny (and his prompt bar) reachable on whatever screen he is on.
function clampToScreen(bounds) {
  const wa = screen.getDisplayMatching(bounds).workArea;
  return {
    x: Math.round(clamp(bounds.x, wa.x - 8, wa.x + wa.width - WIN_W + 8)),
    y: Math.round(clamp(bounds.y, wa.y - 120, wa.y + wa.height - WIN_H + 34)),
    width: WIN_W,
    height: WIN_H,
  };
}

function initialBounds() {
  const saved = store.get('position');
  if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    const onSomeDisplay = screen.getAllDisplays().some(({ workArea: wa }) => {
      const cx = saved.x + WIN_W / 2;
      const cy = saved.y + 380;
      return cx >= wa.x && cx <= wa.x + wa.width && cy >= wa.y && cy <= wa.y + wa.height;
    });
    if (onSomeDisplay) return clampToScreen({ ...saved, width: WIN_W, height: WIN_H });
  }
  const wa = screen.getPrimaryDisplay().workArea;
  return { x: wa.x + wa.width - WIN_W - 16, y: wa.y + wa.height - WIN_H + 20, width: WIN_W, height: WIN_H };
}

function savePosition() {
  if (!win || win.isDestroyed()) return;
  const { x, y } = win.getBounds();
  store.set({ position: { x, y } });
}

function snapshot() {
  return {
    pet: petState,
    mood: pet.moodOf(petState),
    settings: {
      voice: Boolean(store.get('voice')),
      boil: store.get('boil') !== false,
      searchEngine: store.get('searchEngine'),
      model: store.get('model') || DEFAULT_MODEL,
      hasKey: brain.hasKey(),
      hasSearch: hasSearch(),
      autoSearch: store.get('autoSearch') !== false,
      bargeIn: store.get('bargeIn') !== false,
      micSensitivity: store.get('micSensitivity'),
      hotkey: hotkeyReady ? 'Ctrl+Alt+Space' : null,
      nativeVoice: windowsVoice.available(),
      firstRun: Boolean(store.get('firstRun')),
    },
    canUndoOrganize,
    recentApps: store.get('recentApps') || [],
    reminders: book ? book.list().map(({ id, kind, text, due }) => ({ id, kind, text, due })) : [],
    platform: process.platform,
    clickThrough: CLICK_THROUGH,
  };
}

const hasSearch = () => Boolean(store.getSecret('tavily'));

function moodStatus() {
  return { mood: pet.moodOf(petState), fullness: petState.fullness, localTime: new Date().toLocaleString() };
}

// What the brain calls when the model decides to look something up.
function webSearchTool() {
  const key = store.getSecret('tavily');
  if (!key || store.get('autoSearch') === false) return undefined;
  return async (query, signal) => {
    const search = await web.tavilySearch(key, query, { signal });
    return { text: web.formatForModel(search), sources: web.sourcesOf(search) };
  };
}

// "Search for X": look it up with Tavily and answer from the results.
async function answerFromWeb(text, query, { signal, onDelta, onEvent }) {
  onEvent({ type: 'searching', query });
  let search;
  try {
    search = await web.tavilySearch(store.getSecret('tavily'), query, { signal });
  } catch (err) {
    if (signal.aborted) return { ok: false, aborted: true };
    const actions = [{ label: '🌐 Search in browser', action: 'browser-search', arg: query }];
    if (err.kind === 'auth') actions.push({ label: '⚙️ Settings', action: 'settings' });
    return { ok: false, error: web.friendlySearchError(err), actions };
  }
  const sources = web.sourcesOf(search);
  if (!brain.hasKey()) return { ok: true, text: web.formatForBubble(search), sources, searched: true };
  const result = await brain.ask(text, { signal, onDelta, status: moodStatus(), context: web.formatForModel(search) });
  return result.ok ? { ...result, sources, searched: true } : result;
}

function hideNibo() {
  if (!win) return;
  send('nibo:command', 'stop-voice');
  win.hide();
}

function broadcastState() {
  send('nibo:state', snapshot());
  if (tray && book) {
    const n = book.list().length;
    tray.setToolTip(n ? `Nibo AI · ${n} reminder${n === 1 ? '' : 's'}` : 'Nibo AI');
  }
}

function savePet() {
  store.set({ pet: petState });
}

// ---------- windows ----------

function createBunnyWindow() {
  const bounds = initialBounds();
  win = new BrowserWindow({
    ...bounds,
    transparent: true,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    title: 'Nibo AI',
    icon: iconPath(),
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });

  win.setAlwaysOnTop(true, 'floating');
  if (IS_MAC) win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  if (CLICK_THROUGH) win.setIgnoreMouseEvents(true, { forward: true });

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.once('ready-to-show', () => win.showInactive());
  win.on('closed', () => {
    win = null;
  });

  win.loadFile(path.join(RENDERER, 'index.html'));
}

function showNibo() {
  if (!win) return;
  win.showInactive();
  win.setAlwaysOnTop(true, 'floating');
}

// Small framed windows (settings, the tidy-up approval popup).
function createPopup({ page, preload, ...options }) {
  const popup = new BrowserWindow({
    useContentSize: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    icon: iconPath(),
    backgroundColor: '#FFF8EE',
    autoHideMenuBar: true,
    show: false,
    ...options,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', preload),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  popup.setMenu(null);
  popup.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  popup.webContents.on('will-navigate', (e) => e.preventDefault());
  popup.once('ready-to-show', () => {
    popup.show();
    popup.focus();
  });
  popup.loadFile(path.join(RENDERER, page));
  return popup;
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = createPopup({
    page: 'settings.html',
    preload: 'settings-preload.js',
    title: 'Nibo AI — Settings',
    width: 780,
    height: Math.min(800, screen.getPrimaryDisplay().workArea.height - 40),
    resizable: false,
  });
  settingsWin.on('closed', () => {
    settingsWin = null;
  });
}

// Shows the plan in a popup and resolves with the approved item ids, or null.
function askApproval(plan) {
  return new Promise((resolve) => {
    pendingPlan = plan;
    settleApproval = (approvedIds) => {
      settleApproval = null;
      pendingPlan = null;
      resolve(approvedIds);
      if (organizeWin && !organizeWin.isDestroyed()) organizeWin.close();
    };
    organizeWin = createPopup({
      page: 'organize.html',
      preload: 'organize-preload.js',
      title: 'Nibo wants to tidy up!',
      width: 600,
      height: 640,
      minWidth: 460,
      minHeight: 420,
      alwaysOnTop: true,
    });
    organizeWin.on('closed', () => {
      organizeWin = null;
      if (settleApproval) settleApproval(null);
    });
  });
}

function createTray() {
  try {
    // tray@2x.png / tray@3x.png are picked up automatically on high-DPI screens.
    tray = new Tray(nativeImage.createFromPath(path.join(ASSETS, 'tray.png')));
  } catch (err) {
    console.error('[nibo] tray unavailable:', err.message);
    return;
  }
  tray.setToolTip('Nibo AI');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show Nibo', click: showNibo },
      { label: 'Hide Nibo', click: hideNibo },
      { label: 'Talk to Nibo 🎤 (Ctrl+Alt+Space)', click: () => (showNibo(), send('nibo:command', 'toggle-voice')) },
      { type: 'separator' },
      { label: 'Feed Nibo 🥕', click: () => (showNibo(), send('nibo:command', 'feed')) },
      { label: 'Settings…', click: openSettings },
      { type: 'separator' },
      { label: 'Quit Nibo', click: () => app.quit() },
    ]),
  );
  tray.on('click', () => {
    if (!win) return;
    if (win.isVisible()) hideNibo();
    else showNibo();
  });
}

// ---------- movement ----------

function startDrag() {
  if (!win || hopping) return;
  const cursor = screen.getCursorScreenPoint();
  const b = win.getBounds();
  const offset = { x: cursor.x - b.x, y: cursor.y - b.y };
  clearInterval(dragTimer);
  dragTimer = setInterval(() => {
    if (!win) return stopDrag();
    const p = screen.getCursorScreenPoint();
    win.setBounds({ x: p.x - offset.x, y: p.y - offset.y, width: WIN_W, height: WIN_H });
  }, 16);
}

function stopDrag() {
  if (!dragTimer) return;
  clearInterval(dragTimer);
  dragTimer = null;
  if (!win) return;
  win.setBounds(clampToScreen(win.getBounds()));
  savePosition();
}

function glide(from, to, ms, arc) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (!win) {
        clearInterval(timer);
        return resolve();
      }
      const t = Math.min(1, (Date.now() - t0) / ms);
      const e = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
      const x = from.x + (to.x - from.x) * e;
      const y = from.y + (to.y - from.y) * e - Math.sin(Math.PI * t) * arc;
      win.setBounds({ x: Math.round(x), y: Math.round(y), width: WIN_W, height: WIN_H });
      if (t >= 1) {
        clearInterval(timer);
        resolve();
      }
    }, 16);
  });
}

async function hopAround(hops = 3) {
  if (!win || hopping || dragTimer) return;
  hopping = true;
  try {
    for (let i = 0; i < hops && win; i++) {
      const from = win.getBounds();
      const wa = screen.getDisplayMatching(from).workArea;
      const dir = Math.random() < 0.5 ? -1 : 1;
      const dist = 110 + Math.random() * 170;
      let target = clampToScreen({ x: from.x + dir * dist, y: from.y + (Math.random() * 60 - 30), width: WIN_W, height: WIN_H });
      if (Math.abs(target.x - from.x) < 50) {
        target = clampToScreen({ ...target, x: from.x - dir * dist });
      }
      send('nibo:hop', 'jump');
      await glide(from, target, 560, Math.min(90, Math.max(40, (from.y - wa.y) / 3)));
      send('nibo:hop', 'land');
      await sleep(260);
    }
  } finally {
    hopping = false;
    savePosition();
  }
}

// ---------- abilities ----------

const KNOWN_FOLDERS = ['desktop', 'downloads', 'documents', 'pictures', 'music', 'videos'];

function knownFolders() {
  return KNOWN_FOLDERS.map((name) => {
    try {
      return app.getPath(name);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

async function chooseFolder(target) {
  if (target === 'desktop' || target === 'downloads') return app.getPath(target);
  if (target !== 'pick') return null;
  const res = await dialog.showOpenDialog({
    title: 'Which folder should Nibo tidy up?',
    defaultPath: app.getPath('home'),
    properties: ['openDirectory'],
  });
  return res.canceled || !res.filePaths.length ? null : res.filePaths[0];
}

// One tidy-up (or undo) at a time.
async function exclusive(job) {
  if (fileJob) {
    if (organizeWin) organizeWin.focus();
    return { ok: false, text: "One thing at a time! I'm still busy with the last tidy-up. 👀" };
  }
  fileJob = true;
  try {
    return await job();
  } finally {
    fileJob = false;
  }
}

// Plan -> approval popup -> move. Nothing is touched without a yes.
async function organizeFolder(target) {
  const folder = await chooseFolder(target);
  if (!folder) return { ok: false, cancelled: true };
  if (!organizer.isAllowedFolder(folder, { home: app.getPath('home'), known: knownFolders() })) {
    return {
      ok: false,
      text: "Eek, that looks like an important system folder, so I'd better not touch it. 🙈 Try one inside your user folder, like Desktop or Downloads.",
    };
  }

  let plan;
  try {
    plan = await organizer.buildPlan(folder);
  } catch {
    return { ok: false, text: "Hmm, I couldn't look inside that folder. 😿" };
  }
  if (!plan.total) return { ok: true, empty: true, text: organizer.describeEmpty(plan) };

  send('nibo:command', 'organize-review');
  const approved = await askApproval(plan);
  if (!approved || !approved.length) return { ok: false, cancelled: true, text: "Okay! I won't touch a thing. 🐰" };

  const result = await organizer.applyPlan(plan, approved);
  if (result.moves.length) {
    organizer.saveHistory(historyFile(), { at: Date.now(), root: plan.root, ...result });
    canUndoOrganize = true;
    broadcastState();
  }
  return { ok: true, moved: result.moves.length, text: organizer.describeResult(result) };
}

async function undoOrganize() {
  const history = organizer.loadHistory(historyFile());
  if (!history) {
    canUndoOrganize = false;
    broadcastState();
    return { ok: false, text: "There's nothing to undo! Everything is where you left it. ✨" };
  }
  const n = history.moves.length;
  const { response } = await dialog.showMessageBox({
    type: 'question',
    title: 'Undo tidy-up',
    message: `Put ${n} file${n === 1 ? '' : 's'} back where ${n === 1 ? 'it was' : 'they were'}?`,
    detail: `Folder: ${history.root}\nNibo will move the files back and remove the folders he made, if they're empty.`,
    buttons: ['Put them back', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
    icon: nativeImage.createFromPath(iconPath()),
  });
  if (response !== 0) return { ok: false, cancelled: true, text: 'Okay, everything stays tidy! 🧹' };

  const res = await organizer.undoMoves(history);
  organizer.clearHistory(historyFile());
  canUndoOrganize = false;
  broadcastState();
  return { ok: true, text: organizer.describeUndo(res) };
}

// Opens the search in the browser and returns what Nibo should say.
async function openSearch(query) {
  try {
    await shell.openExternal(offline.searchUrl(query, store.get('searchEngine')));
    return `Hopping over to the web to sniff out “${query}”! 🔎🐰`;
  } catch (err) {
    console.error('[nibo] could not open the browser:', err.message);
    return "Hmm, I couldn't open your web browser. 😿";
  }
}

function isWebUrl(url) {
  try {
    const u = new URL(String(url));
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

// ---------- opening apps ----------

const FOLDERS = { desktop: 'Desktop', downloads: 'Downloads', documents: 'Documents', pictures: 'Pictures', music: 'Music', videos: 'Videos' };
const NIBO_SETTINGS = { kind: 'nibo', name: "Nibo's settings", aliases: ['your settings', 'nibo settings', 'nibos settings'] };
const KIND_ICON = { folder: '📂', site: '🌐', nibo: '⚙️' };

function folderEntries() {
  return Object.entries(FOLDERS).flatMap(([key, name]) => {
    try {
      return [{ kind: 'folder', name, path: app.getPath(key) }];
    } catch {
      return [];
    }
  });
}

// Best first: installed apps and folders, then Windows' own apps, then websites.
async function appTiers({ fresh = false } = {}) {
  const installed = await appCatalog.installed({ fresh }).catch(() => []);
  return [[...installed, ...folderEntries(), NIBO_SETTINGS], IS_WIN ? apps.BUILTINS : [], apps.WEBSITES];
}

async function findApp(phrase) {
  const res = apps.resolve(phrase, await appTiers());
  if (res.match || res.ambiguous || !appCatalog.mayBeStale()) return res;
  return apps.resolve(phrase, await appTiers({ fresh: true })); // maybe it was just installed
}

const launchDeps = {
  openPath: (target) => shell.openPath(target),
  openExternal: (url) => shell.openExternal(url),
  spawnDetached: (file, args) => {
    const child = spawn(file, args, { detached: true, stdio: 'ignore' });
    child.on('error', (err) => console.error(`[nibo] could not start ${file}:`, err.message));
    child.unref();
  },
  systemRoot: process.env.SystemRoot || process.env.windir || 'C:\\Windows',
};

function rememberApp(name) {
  const recent = (store.get('recentApps') || []).filter((n) => n !== name);
  store.set({ recentApps: [name, ...recent].slice(0, 6) });
  broadcastState();
}

// Returns null when it worked, or what went wrong.
async function openEntry(entry) {
  if (entry.kind === 'nibo') {
    openSettings();
    return null;
  }
  const error = await apps.launch(entry, launchDeps);
  if (error) console.error(`[nibo] could not open ${entry.name}:`, error);
  else if (entry.kind !== 'folder') rememberApp(entry.name);
  return error;
}

function openedLine(entry) {
  if (entry.kind === 'folder') return `Opening your ${entry.name} folder! 📂`;
  if (entry.kind === 'site') return `Opening ${entry.name} in your browser! 🌐`;
  if (entry.kind === 'nibo') return 'Here are my settings! ⚙️';
  return offline.pick([`Opening ${entry.name}! 🚀`, `${entry.name}, coming right up! 🐰`, `Here comes ${entry.name}! ✨`]);
}

function toolLine(entry) {
  if (entry.kind === 'folder') return `Opened the ${entry.name} folder.`;
  if (entry.kind === 'site') return `Opened ${entry.name} in the web browser.`;
  return `Opened ${entry.name}.`;
}

const listOf = (names) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

/**
 * Opens what the user named ("spotify", "my downloads", "chrome and discord").
 * Returns { found, text, toolText, opened?, actions? }: `text` is for the bubble,
 * `toolText` for the AI, and `found` says whether the name meant anything.
 */
async function openApps(phrase) {
  const res = await findApp(phrase);
  let entries = res.match ? [res.match] : [];
  if (!entries.length && !res.ambiguous) {
    const parts = apps.splitNames(phrase);
    const each = [];
    for (const part of parts) each.push(await findApp(part));
    if (each.length && each.every((r) => r.match)) entries = each.map((r) => r.match);
  }

  if (entries.length) {
    const opened = [];
    const failed = [];
    for (const entry of entries) ((await openEntry(entry)) ? failed : opened).push(entry);
    let text = opened.length === 1 ? openedLine(opened[0]) : opened.length ? `Opening ${listOf(opened.map((e) => e.name))}! 🚀` : '';
    if (failed.length) text += `${text ? ' ' : ''}Oops, ${listOf(failed.map((e) => e.name))} didn't want to open. 😿`;
    const toolText = [...opened.map(toolLine), ...failed.map((e) => `Opening ${e.name} failed.`)].join(' ');
    return { found: true, text, toolText, opened: opened.map((e) => e.name) };
  }

  const said = String(phrase).trim();
  if (res.choices.length) {
    const names = res.choices.map((c) => c.name);
    return {
      found: Boolean(res.ambiguous),
      text: res.ambiguous
        ? 'Ooh, I found a few! Which one should I open? 🤔'
        : `Hmm, I couldn't find “${said}”. Did you mean one of these? 🤔`,
      toolText: res.ambiguous
        ? `Nothing was opened: several things match "${said}": ${names.join(', ')}. Ask the user which one (buttons for them are shown).`
        : `Nothing was opened: nothing called "${said}" was found. Similar names: ${names.join(', ')} (buttons for them are shown).`,
      actions: res.choices.map((c) => ({ label: `${KIND_ICON[c.kind] || '🚀'} ${c.name}`, action: 'open-app', arg: c.name })),
    };
  }
  return {
    found: false,
    text: `I sniffed around everywhere, but I couldn't find an app called “${said}”. 🥺`,
    toolText: `Nothing was opened: no app, folder or website called "${said}" was found on this computer.`,
  };
}

// The open_app tool for the AI. Choices it finds become buttons under the answer.
function appTool(actions) {
  return async (name) => {
    const res = await openApps(name);
    for (const a of res.actions || []) if (!actions.some((b) => b.arg === a.arg)) actions.push(a);
    return { text: res.toolText, opened: res.opened };
  };
}

// ---------- reminders and timers ----------

const FIRED_MS = 30 * 60_000; // how long a ring can still be snoozed
const PENDING_MS = 2 * 60_000; // how long Nibo waits for the answer to "when?"
const SNOOZE_MS = 5 * 60_000;

const reminderFile = () => path.join(app.getPath('userData'), 'reminders.json');
const cancelChip = (item) => ({ label: '✖️ Cancel it', action: 'reminder-cancel', arg: item.id });
const nameOf = (item) => (item.text ? `the “${reminders.shorten(item.text, 30)}” ${item.kind}` : `the ${item.kind}`);

function pendingReminder() {
  if (pendingWhen && Date.now() - pendingWhen.at > PENDING_MS) pendingWhen = null;
  return pendingWhen;
}

function recentFired() {
  const cutoff = Date.now() - FIRED_MS;
  fired = fired.filter((f) => f.firedAt > cutoff);
  return fired;
}

const unackedItems = () => recentFired().filter((f) => !f.acked);

function ack(ids) {
  for (const f of fired) if (ids.includes(f.id)) f.acked = true;
}

// What can be snoozed: whatever is still ringing, or else the latest ring
// (unless the user said "Done" to it).
function snoozeCandidates() {
  const live = recentFired().filter((f) => !f.snoozed && !f.done);
  const open = live.filter((f) => !f.acked);
  if (open.length) return open;
  const latest = Math.max(0, ...live.map((f) => f.firedAt));
  return live.filter((f) => f.firedAt === latest);
}

function alertPayload(items) {
  const content = reminders.alertContent(items, Date.now());
  return { items: items.map(({ id, kind, text }) => ({ id, kind, text })), text: content.text, speech: content.speech };
}

// Something is due. Nibo says it out loud. If he's hidden in the tray he hops back
// out to do it: a reminder you asked for must never go unnoticed.
function ring(items) {
  const now = Date.now();
  for (const item of items) fired.push({ ...item, firedAt: now, acked: false, snoozed: false });
  if (!win || win.isDestroyed()) return;
  if (!win.isVisible()) showNibo();
  send('nibo:reminder', alertPayload(unackedItems())); // everything not yet answered, so nothing gets lost
}

function tickReminders() {
  if (!book) return;
  const due = book.takeDue(Date.now());
  if (!due.length) return;
  ring(due);
  broadcastState();
}

function snooze(candidates, ms) {
  if (!candidates.length) {
    return { text: "Nothing's ringing right now, so there's nothing to snooze! 🐰 Say “remind me in 10 minutes” for a new one." };
  }
  for (const f of candidates) {
    book.add({ kind: f.kind, text: f.text, due: Date.now() + ms });
    f.snoozed = true;
    f.acked = true;
  }
  broadcastState();
  return { text: `Okay, I'll nudge you again in ${when.formatDuration(ms)}. 💤`, reminder: true };
}

function cancelReminders({ kind, all, text }) {
  const label = kind === 'timer' ? 'timer' : 'reminder';
  const ringing = unackedItems().filter((f) => f.kind === kind && reminders.matchItems([f], { text }).length);
  if (all) {
    const gone = book.clear(kind);
    ack(unackedItems().filter((f) => f.kind === kind).map((f) => f.id));
    broadcastState();
    if (!gone.length) return { text: `I don't have any ${label}s to cancel. 🐰` };
    return { text: gone.length === 1 ? `Poof! That ${label} is gone. 🧹` : `Poof! All ${gone.length} ${label}s are gone. 🧹` };
  }
  if (ringing.length) {
    ack(ringing.map((f) => f.id)); // "stop the timer" while it's ringing
    return { text: 'Okay, all quiet! 🔕' };
  }
  const matches = reminders.matchItems(book.list(), { kind, text });
  if (matches.length === 1) {
    book.remove(matches[0].id);
    broadcastState();
    return { text: `Okay, I cancelled ${nameOf(matches[0])}. ✅` };
  }
  if (!matches.length) {
    return {
      text: text ? `I couldn't find a ${label} about “${text}”. 🤔` : `I don't have any ${label}s right now. 🐰`,
      actions: reminders.describeList(book.list()).actions,
    };
  }
  return {
    text: `Which ${label} should I cancel? 🤔`,
    actions: matches.slice(0, 4).map((i) => ({ label: `✖️ ${reminders.chipLabel(i)}`, action: 'reminder-cancel', arg: i.id })),
  };
}

// Turns what reminders.detect found into what Nibo says (and does).
function reminderReply(intent) {
  if (intent.type !== 'ask-when' && intent.type !== 'bad-time') pendingWhen = null;
  switch (intent.type) {
    case 'set': {
      const item = book.add({ kind: intent.kind, text: intent.text, due: intent.due.getTime() });
      if (!item) {
        return { text: 'My little notebook is full! 📒 Cancel a few reminders first.', actions: reminders.describeList(book.list()).actions };
      }
      broadcastState();
      return { text: reminders.confirmText(item, intent, new Date()), actions: [cancelChip(item)], reminder: true };
    }
    case 'ask-when':
      pendingWhen = { kind: intent.kind, text: intent.text, connector: intent.connector, at: Date.now() };
      return { ...reminders.askWhen(intent), sticky: true };
    case 'bad-time':
      if (intent.text) pendingWhen = { kind: intent.kind, text: intent.text, connector: intent.connector, at: Date.now() };
      return { text: reminders.badTimeText(intent.reason) };
    case 'unsupported':
      return { text: "I can only remind you once for now, repeating reminders aren't my thing yet. 🐰 Tell me the next time, and I'll do that one!" };
    case 'list': {
      const list = reminders.describeList(book.list(), Date.now());
      return { ...list, sticky: list.actions.length > 0 };
    }
    case 'cancel': {
      const reply = cancelReminders(intent);
      return { ...reply, sticky: Boolean(reply.actions && reply.actions.length) };
    }
    case 'snooze':
      return snooze(snoozeCandidates(), intent.ms);
    default:
      return null;
  }
}

const TOOL_BAD_TIME = {
  past: 'that time has already passed',
  far: 'that is too far away (about a year is the limit)',
  zero: 'that is right now',
  baddate: 'that date does not exist',
};

// The set_reminder tool for the AI. The cancel buttons go under its answer.
function reminderTool(actions, flags) {
  return async ({ what, when: phrase, timer }) => {
    const now = new Date();
    const found = reminders.parsePhrase(phrase, { now, timer });
    if (!found) {
      return { text: `Nothing was set: I couldn't understand the time "${phrase}". Ask the user when, like "in 20 minutes", "at 6pm" or "tomorrow at 9am".` };
    }
    if (!found.ok) return { text: `Nothing was set: ${TOOL_BAD_TIME[found.reason] || 'that time cannot be used'}.` };
    const item = book.add({ kind: timer ? 'timer' : 'reminder', text: String(what || '').replace(/\s+/g, ' ').trim(), due: found.due.getTime() });
    if (!item) return { text: 'Nothing was set: the notebook is full (50 reminders).' };
    flags.reminder = true;
    actions.push(cancelChip(item));
    broadcastState();
    const thing = item.kind === 'timer' ? 'Timer' : 'Reminder';
    return { text: `Done. ${thing}${item.text ? ` "${item.text}"` : ''} will go off ${when.describeDue(new Date(item.due), now)}.` };
  };
}

// ---------- IPC ----------

function registerIpc() {
  ipcMain.handle('nibo:get-state', (e) => (fromBunny(e) ? snapshot() : null));
  ipcMain.handle('nibo:get-lines', (e) =>
    fromBunny(e)
      ? {
          greetings: offline.GREETINGS,
          hungry: offline.HUNGRY_LINES,
          fed: offline.FED_LINES,
          stuffed: offline.STUFFED_LINES,
          poke: offline.POKE_LINES,
        }
      : null,
  );

  ipcMain.on('nibo:set-ignore-mouse', (e, ignore) => {
    if (!fromBunny(e) || !CLICK_THROUGH) return;
    if (ignore) win.setIgnoreMouseEvents(true, { forward: true });
    else win.setIgnoreMouseEvents(false);
  });

  ipcMain.on('nibo:drag-start', (e) => fromBunny(e) && startDrag());
  ipcMain.on('nibo:drag-end', (e) => fromBunny(e) && stopDrag());

  ipcMain.handle('nibo:ask', async (e, payload) => {
    if (!fromBunny(e)) return { ok: false };
    const id = String(payload?.id ?? '');
    const text = String(payload?.text ?? '').trim().slice(0, 4000);
    if (!text) return { ok: false };

    // "search for X" (or the menu's search) looks it up for real when Tavily is set up.
    const query = payload?.search ? text.slice(0, 400) : offline.detectSearch(text);
    if (query && !hasSearch()) return { ok: true, text: await openSearch(query), searched: true };

    if (!query) {
      // "remind me to call mum in 20 minutes", "set a timer for 5 minutes", "cancel the timer"…
      const detect = payload?.remind ? reminders.detectFromPrompt : reminders.detect;
      // (The "Remind me…" prompt always starts something new, so a waiting "when?" doesn't apply.)
      const intent = book && detect(text, { now: new Date(), pending: payload?.remind ? null : pendingReminder() });
      // With the AI available, a time Nibo can't read himself ("it takes 3 minutes") is left to it.
      const reply = intent && !(intent.timey && brain.hasKey()) && reminderReply(intent);
      if (reply) return { ok: true, ...reply };
      pendingWhen = null;

      const organizeTarget = offline.detectOrganize(text);
      if (organizeTarget) return { ok: true, organize: organizeTarget };
      // "open spotify": quick, no AI needed when the name means something.
      const request = offline.detectOpenApp(text);
      if (request) {
        const res = await openApps(request.name);
        if (res.found || (request.sure && !brain.hasKey())) {
          return { ok: true, text: res.text, opened: res.opened, actions: res.actions };
        }
      }
      if (!brain.hasKey()) {
        const local = offline.answer(text, { mood: pet.moodOf(petState) });
        return { ok: true, offline: true, text: local.text, actions: local.actions };
      }
    }

    const controller = new AbortController();
    inflight.set(id, controller);
    const live = (channel, data) => {
      if (!e.sender.isDestroyed()) e.sender.send(channel, { id, ...data });
    };
    const onDelta = (delta) => live('nibo:delta', { delta });
    const onEvent = (ev) => ev.type === 'searching' && live('nibo:search-status', { query: ev.query });
    const toolActions = [];
    const toolFlags = { reminder: false };
    try {
      const result = query
        ? await answerFromWeb(text, query, { signal: controller.signal, onDelta, onEvent })
        : await brain.ask(text, {
            signal: controller.signal,
            status: moodStatus(),
            onDelta,
            onEvent,
            search: webSearchTool(),
            openApp: appTool(toolActions),
            setReminder: reminderTool(toolActions, toolFlags),
          });
      if (result.ok) {
        petState = pet.cheer(petState, 1);
        savePet();
        if (toolActions.length) result.actions = toolActions;
        if (toolFlags.reminder) result.reminder = true;
      } else if (result.kind === 'auth') {
        result.actions = [{ label: '⚙️ Open Settings', action: 'settings' }];
      } else if (result.kind === 'network') {
        result.actions = [{ label: '🔁 Try again', action: 'retry', arg: text }];
      }
      return result;
    } finally {
      inflight.delete(id);
    }
  });

  ipcMain.handle('nibo:open-app', async (e, name) => {
    if (!fromBunny(e)) return { ok: false };
    const phrase = String(name ?? '').trim().slice(0, 100);
    if (!phrase) return { ok: false };
    const res = await openApps(phrase);
    return { ok: true, text: res.text, opened: res.opened, actions: res.actions };
  });

  // Buttons and menus: list / cancel / cancel-all / snooze / done.
  ipcMain.handle('nibo:reminders', (e, payload) => {
    if (!fromBunny(e) || !book) return { ok: false };
    const action = String(payload?.action ?? '');
    const arg = payload?.arg;
    const ids = (Array.isArray(arg) ? arg : [arg]).filter((x) => typeof x === 'string').slice(0, 20);
    switch (action) {
      case 'list':
        return { ok: true, ...reminders.describeList(book.list(), Date.now()) };
      case 'cancel': {
        const item = book.remove(ids[0]);
        if (item) broadcastState();
        return { ok: true, text: item ? `Okay, I cancelled ${nameOf(item)}. ✅` : 'That one is already gone. 🐰' };
      }
      case 'cancel-all': {
        const gone = book.clear();
        broadcastState();
        return { ok: true, text: gone.length ? `Poof! ${gone.length === 1 ? 'It is' : `All ${gone.length} are`} gone. 🧹` : 'There was nothing to cancel. 🐰' };
      }
      case 'snooze':
        return { ok: true, ...snooze(recentFired().filter((f) => ids.includes(f.id) && !f.snoozed), SNOOZE_MS) };
      case 'done': // the ✅ Done button
        ack(ids);
        for (const f of fired) if (ids.includes(f.id)) f.done = true;
        return { ok: true };
      case 'seen': // the bubble was just closed
        ack(ids);
        return { ok: true };
      default:
        return { ok: false };
    }
  });

  ipcMain.handle('nibo:transcribe', async (e, audio) => {
    if (!fromBunny(e)) return { ok: false };
    if (!(audio instanceof Uint8Array) || audio.length < 44 || audio.length > 10 * 1024 * 1024) {
      return { ok: false, error: "Hmm, that recording didn't work. 🎤 Try again?" };
    }
    if (!brain.hasKey()) {
      return {
        ok: false,
        error: 'I need a Groq key to understand speech! 🎤 Add one in Settings.',
        actions: [{ label: '⚙️ Settings', action: 'settings' }],
      };
    }
    const result = await brain.transcribe(Buffer.from(audio));
    if (!result.ok && result.kind === 'auth') result.actions = [{ label: '⚙️ Open Settings', action: 'settings' }];
    return result;
  });

  // Render a sentence with the Windows voice; the renderer plays it.
  ipcMain.handle('nibo:tts', async (e, text) => {
    if (!fromBunny(e) || !windowsVoice.available()) return { ok: false };
    // Never make Nibo wait for a slow-starting helper: speak the old way until it's up.
    if (!windowsVoice.started()) {
      windowsVoice.start().catch(() => broadcastState());
      return { ok: false };
    }
    try {
      const { sampleRate, pcm } = await windowsVoice.synthesize(String(text || '').slice(0, 1000));
      return { ok: true, sampleRate, pcm: new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength) };
    } catch (err) {
      console.error('[nibo] Windows voice failed:', err.message);
      if (!windowsVoice.available()) broadcastState();
      return { ok: false };
    }
  });

  ipcMain.handle('nibo:mic-access', async (e) => {
    if (!fromBunny(e)) return false;
    if (IS_MAC) return systemPreferences.askForMediaAccess('microphone');
    return true;
  });

  ipcMain.on('nibo:cancel', (e, id) => {
    if (!fromBunny(e)) return;
    const controller = inflight.get(String(id));
    if (controller) controller.abort();
  });

  ipcMain.handle('nibo:preset', async (e, payload) => {
    if (!fromBunny(e)) return { ok: false };
    const name = String(payload?.name ?? '');
    if (name === 'search') {
      const query = String(payload?.arg ?? '').trim().slice(0, 500);
      if (!query) return { ok: false };
      return { ok: true, text: await openSearch(query) };
    }
    if (name === 'hop') {
      await hopAround(3);
      return { ok: true };
    }
    return { ok: false };
  });

  ipcMain.handle('nibo:organize', (e, target) =>
    fromBunny(e) ? exclusive(() => organizeFolder(String(target))) : { ok: false },
  );
  ipcMain.handle('nibo:organize-undo', (e) => (fromBunny(e) ? exclusive(undoOrganize) : { ok: false }));
  ipcMain.on('nibo:open-organized', (e) => {
    if (!fromBunny(e)) return;
    const history = organizer.loadHistory(historyFile());
    if (history) shell.openPath(history.root);
  });

  // ----- tidy-up approval popup -----

  ipcMain.handle('organize:get-plan', (e) => (fromOrganize(e) && pendingPlan ? organizer.publicPlan(pendingPlan) : null));
  ipcMain.on('organize:approve', (e, ids) => {
    if (!fromOrganize(e) || !settleApproval || !Array.isArray(ids)) return;
    settleApproval(ids.filter((id) => typeof id === 'string'));
  });
  ipcMain.on('organize:cancel', (e) => fromOrganize(e) && settleApproval && settleApproval(null));

  ipcMain.handle('nibo:feed', (e) => {
    if (!fromBunny(e)) return null;
    const { pet: next, result } = pet.feed(petState);
    petState = next;
    savePet();
    return { result, state: snapshot() };
  });

  ipcMain.handle('nibo:pat', (e) => {
    if (!fromBunny(e)) return null;
    petState = pet.cheer(petState, 3);
    savePet();
    return snapshot();
  });

  ipcMain.handle('nibo:set-voice', (e, on) => {
    if (!fromBunny(e)) return null;
    store.set({ voice: Boolean(on) });
    return snapshot();
  });

  ipcMain.on('nibo:clear-chat', (e) => fromBunny(e) && brain.reset());
  ipcMain.on('nibo:first-run-done', (e) => fromBunny(e) && store.set({ firstRun: false }));
  ipcMain.on('nibo:open-settings', (e) => fromBunny(e) && openSettings());
  ipcMain.on('nibo:hide', (e) => fromBunny(e) && hideNibo());
  ipcMain.on('nibo:quit', (e) => fromBunny(e) && app.quit());
  ipcMain.on('nibo:open-external', (e, url) => {
    if (fromBunny(e) && isWebUrl(url)) shell.openExternal(String(url));
  });

  // ----- settings window -----

  ipcMain.handle('settings:get', (e) => {
    if (!fromSettings(e)) return null;
    return {
      hasKey: brain.hasKey(),
      keyHint: store.keyHint(),
      keySource: store.keySource(),
      hasTavily: hasSearch(),
      tavilyHint: store.secretHint('tavily'),
      tavilySource: store.secretSource('tavily'),
      autoSearch: store.get('autoSearch') !== false,
      bargeIn: store.get('bargeIn') !== false,
      micSensitivity: store.get('micSensitivity'),
      hotkey: hotkeyReady ? 'Ctrl+Alt+Space' : null,
      model: store.get('model') || DEFAULT_MODEL,
      defaultModel: DEFAULT_MODEL,
      searchEngine: store.get('searchEngine'),
      searchEngines: Object.keys(offline.SEARCH_ENGINES),
      voice: Boolean(store.get('voice')),
      boil: store.get('boil') !== false,
      canStartWithSystem: IS_WIN || IS_MAC,
      startWithSystem: IS_WIN || IS_MAC ? app.getLoginItemSettings().openAtLogin : false,
      encrypted: safeStorage.isEncryptionAvailable(),
      version: app.getVersion(),
    };
  });

  ipcMain.handle('settings:save', (e, patch) => {
    if (!fromSettings(e) || !patch || typeof patch !== 'object') return { ok: false };
    if (patch.removeKey === true) store.setApiKey('');
    else if (typeof patch.apiKey === 'string' && patch.apiKey.trim()) store.setApiKey(patch.apiKey);
    if (patch.removeTavilyKey === true) store.setSecret('tavily', '');
    else if (typeof patch.tavilyKey === 'string' && patch.tavilyKey.trim()) store.setSecret('tavily', patch.tavilyKey);

    const next = {};
    if (typeof patch.model === 'string' && /^[\w.\-/:]{1,120}$/.test(patch.model.trim())) next.model = patch.model.trim();
    if (Object.hasOwn(offline.SEARCH_ENGINES, patch.searchEngine)) next.searchEngine = patch.searchEngine;
    if (typeof patch.voice === 'boolean') next.voice = patch.voice;
    if (typeof patch.boil === 'boolean') next.boil = patch.boil;
    if (typeof patch.autoSearch === 'boolean') next.autoSearch = patch.autoSearch;
    if (typeof patch.bargeIn === 'boolean') next.bargeIn = patch.bargeIn;
    if (MIC_SENSITIVITIES.includes(patch.micSensitivity)) next.micSensitivity = patch.micSensitivity;
    store.set(next);

    if ((IS_WIN || IS_MAC) && typeof patch.startWithSystem === 'boolean') {
      app.setLoginItemSettings({ openAtLogin: patch.startWithSystem });
    }
    if (next.model) brain.reset();
    broadcastState();
    return { ok: true };
  });

  ipcMain.handle('settings:test-key', async (e, key) => {
    if (!fromSettings(e)) return { ok: false };
    const candidate = typeof key === 'string' && key.trim() ? key.trim() : store.getApiKey();
    if (!candidate) return { ok: false, error: 'Paste a Groq API key first! 🔑' };
    return testKey(candidate);
  });

  ipcMain.handle('settings:test-tavily', async (e, key) => {
    if (!fromSettings(e)) return { ok: false };
    const candidate = typeof key === 'string' && key.trim() ? key.trim() : store.getSecret('tavily');
    if (!candidate) return { ok: false, error: 'Paste a Tavily API key first! 🔑' };
    return web.testTavilyKey(candidate);
  });

  ipcMain.on('settings:open-external', (e, url) => {
    if (fromSettings(e) && isWebUrl(url)) shell.openExternal(String(url));
  });

  ipcMain.on('settings:close', (e) => fromSettings(e) && settingsWin.close());
}

// ---------- lifecycle ----------

function init() {
  if (IS_WIN) app.setAppUserModelId('ai.nibo.desktop');

  store = new Store(path.join(app.getPath('userData'), 'nibo-settings.json'), {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (s) => safeStorage.encryptString(s),
    decrypt: (b) => safeStorage.decryptString(b),
  });
  petState = pet.tick(store.get('pet'));
  savePet();
  canUndoOrganize = Boolean(organizer.loadHistory(historyFile()));
  book = new reminders.ReminderBook(reminderFile());

  brain = new Brain({
    getApiKey: () => store.getApiKey(),
    getModel: () => store.get('model'),
    setModel: (model) => store.set({ model }),
  });

  // Only Nibo's own window may use the microphone, and only for audio.
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    const audioOnly = permission === 'media' && (details.mediaTypes || []).every((t) => t === 'audio');
    callback(Boolean(win && wc === win.webContents && audioOnly));
  });
  session.defaultSession.setPermissionCheckHandler(
    (wc, permission, origin, details) =>
      permission === 'media' && Boolean(win && wc === win.webContents) && (!details.mediaType || details.mediaType === 'audio'),
  );

  registerIpc();
  createBunnyWindow();
  createTray();

  // Warm up the Windows voice so Nibo's first sentence isn't slow.
  if (windowsVoice.available()) windowsVoice.start().catch(() => broadcastState());
  // Get the list of apps ready (after the voice helper) so "open …" is quick.
  setTimeout(() => appCatalog.warm(), 5000).unref();

  // Reminders: check every second (dates are compared, not counted, so a sleeping
  // computer rings straight away when it wakes up). Whatever came due while Nibo
  // wasn't running is announced shortly after he's up.
  setInterval(tickReminders, 1000);
  powerMonitor.on('resume', tickReminders);
  const missed = book.takeDue(Date.now());
  if (missed.length) setTimeout(() => (ring(missed), broadcastState()), 5000);

  // Talk to Nibo from anywhere.
  try {
    hotkeyReady = globalShortcut.register(VOICE_HOTKEY, () => {
      showNibo();
      send('nibo:command', 'toggle-voice');
    });
  } catch (err) {
    console.error('[nibo] could not register the voice hotkey:', err.message);
  }

  // Feed the cursor position to the renderer so Nibo's eyes can follow it
  // and hover works even while the window is click-through.
  let last = { x: NaN, y: NaN };
  setInterval(() => {
    if (!win || !win.isVisible()) return;
    const p = screen.getCursorScreenPoint();
    const b = win.getBounds();
    const x = p.x - b.x;
    const y = p.y - b.y;
    if (x === last.x && y === last.y) return;
    last = { x, y };
    send('nibo:cursor', { x, y, inside: x >= 0 && y >= 0 && x < b.width && y < b.height });
  }, 50);

  // Nibo gets hungry over time.
  setInterval(() => {
    petState = pet.tick(petState);
    savePet();
    broadcastState();
  }, 60 * 1000);

  const keepOnScreen = () => {
    if (win) win.setBounds(clampToScreen(win.getBounds()));
  };
  screen.on('display-removed', keepOnScreen);
  screen.on('display-metrics-changed', keepOnScreen);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showNibo);
  app.whenReady().then(init);
  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => globalShortcut.unregisterAll());
  app.on('before-quit', () => {
    windowsVoice.stop();
    for (const controller of inflight.values()) controller.abort();
    if (store) {
      savePet();
      savePosition();
    }
  });
}
