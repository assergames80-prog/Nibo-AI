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
const updates = require('./updates');
const updater = require('./updater');
const repeat = require('./repeat');
const memory = require('./memory');
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
let update = null; // the newer release GitHub knows about: { version, url, assetUrl, size, sha256 }
let installing = null; // the AbortController of an update that is being downloaded, or 'handoff' once it's started
let justUpdated = null; // { version, from } when this run is the first one after an update
let notebook = null; // what Nibo remembers about the user (memory.json)
let memoryWin = null;
let lastSaved = null; // the note saved last: { id, at }, so "forget that" knows what "that" is

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

function fromMemory(event) {
  return memoryWin && !memoryWin.isDestroyed() && event.sender === memoryWin.webContents;
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
    update: visibleUpdate() ? { version: update.version, oneClick: oneClickOk(), installing: Boolean(installing) } : null,
    justUpdated,
    memoryOn: memoryOn(),
    userName: notebook && memoryOn() ? notebook.name() : '',
    appVersion: app.getVersion(),
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
  const result = await brain.ask(text, {
    signal,
    onDelta,
    status: moodStatus(),
    context: web.formatForModel(search),
    notes: memoryOn() ? notebook.forPrompt() : [],
  });
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

function trayMenu() {
  const newer = visibleUpdate();
  return Menu.buildFromTemplate([
    ...(newer
      ? [
          oneClickOk()
            ? { label: `✨ Update Nibo to v${newer.version}`, click: () => (showNibo(), send('nibo:command', 'install-update')) }
            : { label: `🎁 Download Nibo v${newer.version}`, click: () => openUpdate('download') },
          { type: 'separator' },
        ]
      : []),
    { label: 'Show Nibo', click: showNibo },
    { label: 'Hide Nibo', click: hideNibo },
    { label: 'Talk to Nibo 🎤 (Ctrl+Alt+Space)', click: () => (showNibo(), send('nibo:command', 'toggle-voice')) },
    { type: 'separator' },
    { label: 'Feed Nibo 🥕', click: () => (showNibo(), send('nibo:command', 'feed')) },
    { label: '🧠 What Nibo remembers…', click: () => openNotebook() },
    { label: 'Settings…', click: openSettings },
    { type: 'separator' },
    { label: 'Quit Nibo', click: () => app.quit() },
  ]);
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
  tray.setContextMenu(trayMenu());
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
  return {
    items: items.map(({ id, kind, text, repeat }) => ({ id, kind, text, repeating: Boolean(repeat) })),
    text: content.text,
    speech: content.speech,
  };
}

// Something is due. Nibo says it out loud. If he's hidden in the tray he hops back
// out to do it: a reminder you asked for must never go unnoticed.
function ring(items) {
  const now = Date.now();
  fired = fired.filter((f) => !items.some((item) => item.id === f.id)); // a repeating one rings again: one entry
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
      const item = book.add({ kind: intent.kind, text: intent.text, due: intent.due.getTime(), repeat: intent.repeat });
      if (!item) {
        return { text: 'My little notebook is full! 📒 Cancel a few reminders first.', actions: reminders.describeList(book.list()).actions };
      }
      broadcastState();
      return { text: reminders.confirmText(item, intent, new Date()), actions: [cancelChip(item)], reminder: true };
    }
    case 'ask-when':
      pendingWhen = { kind: intent.kind, text: intent.text, connector: intent.connector, repeatPhrase: intent.repeatPhrase, at: Date.now() };
      return { ...reminders.askWhen(intent), sticky: true };
    case 'bad-time':
      if (intent.text) pendingWhen = { kind: intent.kind, text: intent.text, connector: intent.connector, at: Date.now() };
      return { text: reminders.badTimeText(intent.reason) };
    case 'unsupported':
      return {
        text:
          intent.reason === 'repeat-timer'
            ? 'Timers only run once! ⏱️ For something that repeats, say “remind me every 25 minutes to …”.'
            : "I can repeat reminders, but I can't stop them after a while yet. 🐰 Say it without “for 5 days” or “until Friday”, and cancel it whenever you like.",
      };
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
  'needs-time': 'the time of day is missing: ask the user what time it should repeat',
  'too-often': 'repeating more often than every 5 minutes is not allowed',
  'too-far': 'that repeat is too far apart',
  end: 'stopping a repeat after a while is not supported yet',
  'repeat-timer': 'timers cannot repeat: set a repeating reminder instead (timer false)',
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
    const item = book.add({
      kind: timer ? 'timer' : 'reminder',
      text: String(what || '').replace(/\s+/g, ' ').trim(),
      due: found.due.getTime(),
      repeat: found.repeat,
    });
    if (!item) return { text: 'Nothing was set: the notebook is full (50 reminders).' };
    flags.reminder = true;
    actions.push(cancelChip(item));
    broadcastState();
    const thing = item.kind === 'timer' ? 'Timer' : 'Reminder';
    const rings = item.repeat
      ? `will go off ${repeat.describeRule(item.repeat)}, the first time ${when.describeDue(new Date(item.due), now)}`
      : `will go off ${when.describeDue(new Date(item.due), now)}`;
    return { text: `Done. ${thing}${item.text ? ` "${item.text}"` : ''} ${rings}.` };
  };
}

// ---------- memory ----------

const SAVED_MS = 10 * 60_000; // "forget that" means a note saved in the last few minutes
const memoryFile = () => path.join(app.getPath('userData'), 'memory.json');
const memoryOn = () => store && store.get('memoryOn') !== false;
const forgetChip = (note) => ({ label: '↩️ Forget it', action: 'memory-forget', arg: note.id });
const notebookChip = { label: '🧠 Open my notebook', action: 'memory-open' };
const noteWord = (n) => `${n} ${n === 1 ? 'thing' : 'things'}`;

const NOT_SAVED = {
  secret: "I'd rather not keep passwords, card numbers or secret keys. 🔒 A password manager is the right place for those!",
  full: 'My notebook is full! 📒 Forget a few things first.',
  duplicate: 'I already know that! 🐰',
  empty: "I didn't catch what to remember. 🐰",
};

function notebookChanged() {
  broadcastState();
  if (memoryWin && !memoryWin.isDestroyed()) memoryWin.webContents.send('memory:changed');
}

function openNotebook() {
  if (memoryWin && !memoryWin.isDestroyed()) {
    memoryWin.show();
    memoryWin.focus();
    return;
  }
  memoryWin = createPopup({
    page: 'memory.html',
    preload: 'memory-preload.js',
    title: 'Nibo AI — What I remember',
    width: 540,
    height: 560,
    minWidth: 420,
    minHeight: 420,
  });
  memoryWin.on('closed', () => {
    memoryWin = null;
  });
}

function saveNote(text) {
  const res = notebook.add(text);
  if (res.ok) {
    lastSaved = { id: res.note.id, at: Date.now() };
    notebookChanged();
  }
  return res;
}

async function forgetEverything(parent) {
  const n = notebook.count;
  const { response } = await dialog.showMessageBox(parent || undefined, {
    type: 'question',
    title: 'Forget everything?',
    message: `Forget all ${noteWord(n)} Nibo remembers about you?`,
    detail: "This can't be undone.",
    buttons: ['Forget everything', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    icon: nativeImage.createFromPath(iconPath()),
  });
  if (response !== 0) return false;
  notebook.clear();
  lastSaved = null;
  notebookChanged();
  return true;
}

async function forgetReply(intent) {
  if (intent.all) {
    if (!notebook.count) return { text: "There's nothing to forget! 🐰" };
    const n = notebook.count;
    return (await forgetEverything()) ? { text: `Poof! I forgot everything. 🧹 (${noteWord(n)})` } : { text: 'Okay, I still remember everything! 🧠' };
  }
  if (intent.last) {
    if (!lastSaved || Date.now() - lastSaved.at > SAVED_MS) return null; // "forget it" was just a figure of speech
    const note = notebook.remove(lastSaved.id);
    lastSaved = null;
    if (!note) return null;
    notebookChanged();
    return { text: `Okay, I forgot that. 🧹 “${reminders.shorten(note.text, 80)}”` };
  }
  const matches = notebook.find(intent.text);
  if (matches.length === 1) {
    notebook.remove(matches[0].id);
    notebookChanged();
    return { text: `Okay, I forgot “${reminders.shorten(matches[0].text, 80)}”. 🧹` };
  }
  if (matches.length > 1) {
    return {
      text: 'Which one should I forget? 🤔',
      actions: matches.slice(0, 4).map((n) => ({ label: `✖️ ${reminders.shorten(n.text, 22)}`, action: 'memory-forget', arg: n.id })),
      sticky: true,
    };
  }
  // Only answer when it was clearly about the user ("forget my dog"), not "forget the meeting".
  if (/\b(?:my|me|i)\b/i.test(intent.text)) {
    return { text: `I couldn't find a note about “${reminders.shorten(intent.text, 40)}”. 🤔`, actions: notebook.count ? [notebookChip] : [] };
  }
  return null;
}

// What Nibo says (and does) about "remember that…", "call me Sam", "what do you remember?", "forget…".
async function memoryReply(intent) {
  if (!memoryOn()) {
    return { text: 'My memory is switched off. 🧠 You can turn it on in Settings.', actions: [{ label: '⚙️ Settings', action: 'settings' }] };
  }
  switch (intent.type) {
    case 'name': {
      const res = notebook.setName(intent.name);
      if (res.reason === 'duplicate') return { text: `I already know you're ${intent.name}! 😄` };
      if (!res.ok) return { text: NOT_SAVED[res.reason] || NOT_SAVED.empty, actions: res.reason === 'full' ? [notebookChip] : [] };
      lastSaved = { id: res.note.id, at: Date.now() };
      notebookChanged();
      return { text: `Nice to meet you, ${intent.name}! 🐰 I'll remember that.`, actions: [forgetChip(res.note)], remembered: true };
    }
    case 'remember': {
      const res = saveNote(intent.text);
      if (res.ok) return { text: `Okay, I'll remember that! 🧠 “${reminders.shorten(res.note.text, 80)}”`, actions: [forgetChip(res.note)], remembered: true };
      if (res.reason === 'empty') return null;
      return { text: NOT_SAVED[res.reason], actions: res.reason === 'full' ? [notebookChip] : [] };
    }
    case 'show':
      if (!notebook.count) {
        return { text: "I don't remember anything about you yet! 🐰 Tell me something, like “remember that I love cats” or “call me Sam”." };
      }
      openNotebook();
      return { text: `Here's my notebook! 🧠 I remember ${noteWord(notebook.count)} about you.` };
    case 'forget':
      return forgetReply(intent);
    default:
      return null;
  }
}

// The remember tool for the AI. A ↩️ Forget it button goes under its answer.
function rememberTool(actions, flags) {
  return async (note) => {
    const res = saveNote(note);
    if (res.ok) {
      flags.remembered = true;
      actions.push(forgetChip(res.note));
      return { text: 'Saved. The user can see and delete it in your notebook.' };
    }
    const why = {
      duplicate: 'you already have that note',
      secret: 'it looks like a password, card number or key, which you must never keep: tell the user you would rather not',
      full: 'the notebook is full (60 notes): tell the user to forget a few',
    }[res.reason];
    return { text: `Nothing was saved${why ? `: ${why}` : ''}.` };
  };
}

// ---------- updates ----------

const UPDATE_EVERY_MS = 6 * 60 * 60 * 1000;
const IS_PORTABLE = Boolean(process.env.PORTABLE_EXECUTABLE_FILE);

// The newer release, unless the user turned the checks off or hid this one.
function visibleUpdate() {
  if (!update || !store || store.get('checkUpdates') === false) return null;
  return store.get('dismissedUpdate') === update.version ? null : update;
}

// Can Nibo fetch and install this update himself (and if not, he offers the browser download)?
function oneClickOk() {
  return Boolean(
    update &&
      updater.supported({
        update,
        packaged: app.isPackaged,
        platform: process.platform,
        portableFile: process.env.PORTABLE_EXECUTABLE_FILE,
      }).ok,
  );
}

function updateChips() {
  return [
    oneClickOk() ? { label: '✨ Update now', action: 'update-install' } : { label: '⬇️ Download', action: 'update-download' },
    { label: "📝 What's new", action: 'update-notes' },
    { label: '🙈 Hide this', action: 'update-dismiss' },
  ];
}

function updateChanged() {
  broadcastState();
  if (tray) tray.setContextMenu(trayMenu());
}

// Asks GitHub. `manual` checks (the user asked) ignore the settings and the "hide this".
async function checkForUpdates({ manual = false } = {}) {
  if (!manual && (store.get('checkUpdates') === false || process.env.NIBO_NO_UPDATE_CHECK)) return null;
  const res = await updates.checkForUpdate({
    current: app.getVersion(),
    portable: IS_PORTABLE,
    platform: process.platform,
    baseUrl: process.env.UPDATE_API_BASE,
  });
  if (res.status === 'error') {
    console.error('[nibo] update check failed:', res.error);
    return res;
  }
  if (res.status === 'newer') {
    update = res.release;
    if (manual) store.set({ dismissedUpdate: '' });
    // Say so once per version; after that the 🎁 button waits quietly. (Nibo tells us
    // when he has really said it, so a busy moment just means we try again later.)
    if (!manual && store.get('lastAnnouncedUpdate') !== update.version && visibleUpdate()) {
      send('nibo:update', { version: update.version, current: app.getVersion() });
    }
  } else {
    update = null;
  }
  updateChanged();
  return res;
}

const newerReply = () => ({
  text: `A new version of me is out! 🎁 v${update.version} (I'm v${app.getVersion()}.)`,
  actions: updateChips(),
  sticky: true,
});

// What Nibo says when asked about updates, by chat or by the button.
async function updateReply() {
  const res = await checkForUpdates({ manual: true });
  if (res && res.status === 'newer') return newerReply();
  if (res && res.status === 'current') return { text: `I'm up to date! 🐰 v${app.getVersion()} is the newest version.` };
  return { text: "I couldn't reach GitHub to check for updates. 🌐 Try again in a bit?" };
}

// Opens the download (or the release notes) in the browser; Nibo installs nothing himself.
async function openUpdate(which) {
  if (!update) return { text: "I don't know of a newer version right now. 🐰" };
  const direct = which !== 'notes' && update.assetUrl;
  const url = direct ? update.assetUrl : update.url;
  if (!updates.isReleaseUrl(url)) return { text: "Hmm, that address doesn't look right, so I won't open it. 🙈" };
  try {
    await shell.openExternal(url);
  } catch (err) {
    console.error('[nibo] could not open the browser:', err.message);
    return { text: `Hmm, I couldn't open your web browser. 😿 You can get v${update.version} at github.com/${updates.REPO}/releases` };
  }
  if (which === 'notes') return { text: `Here's what's new in v${update.version}! 📝` };
  if (!update.assetUrl) return { text: `Opening the release page in your browser! 🎁 v${update.version} is waiting there.` };
  return {
    text: IS_PORTABLE
      ? `Downloading v${update.version} in your browser! ⬇️ It's a new portable file: use it instead of this one.`
      : `Downloading v${update.version} in your browser! ⬇️ Run it when it finishes (it'll ask you to close me first).`,
  };
}

// Where the new file goes while it downloads, and what it's called. (Fixed names:
// the version is digits only, so nothing from the network ends up in a path.)
const updateFolder = () => path.join(app.getPath('temp'), 'nibo-update');
const portableTarget = () => process.env.PORTABLE_EXECUTABLE_FILE;
const freshFile = (version) => (IS_PORTABLE ? `${portableTarget()}.new` : path.join(updateFolder(), `Nibo-AI-Setup-${version}.exe`));

const downloadChip = [{ label: '⬇️ Download in browser', action: 'update-download' }];

function updateTrouble(err) {
  console.error('[nibo] one-click update failed:', err.message);
  const why = {
    network: "I couldn't get the file from GitHub. 🌐",
    verify: "The file didn't look right (it didn't match what GitHub published), so I threw it away. 🛡️",
    install: "I couldn't start the installer. 😿",
  }[err.kind];
  return {
    text: `${why || 'Something went wrong while updating. 😿'} Nothing was changed. You can get it in your browser instead!`,
    actions: [...downloadChip, { label: "📝 What's new", action: 'update-notes' }],
    sticky: true,
  };
}

// "Update now": download the new version (checking it is exactly what GitHub published),
// then install it quietly and start again. Anything odd stops it with nothing changed.
async function installUpdate() {
  if (!update) return { text: "I don't know of a newer version right now. 🐰" };
  if (installing) return { text: "I'm already on it! ✨ Give me a moment.", sticky: false };
  const plan = updater.supported({
    update,
    packaged: app.isPackaged,
    platform: process.platform,
    portableFile: process.env.PORTABLE_EXECUTABLE_FILE,
  });
  if (!plan.ok) return { text: `I can't update myself here (${plan.reason}), but you can download it! ⬇️`, actions: downloadChip, sticky: true };

  const release = update;
  const to = freshFile(release.version);
  const controller = new AbortController();
  installing = controller;
  broadcastState();
  const progress = (p) => send('nibo:update-progress', { percent: p.percent, version: release.version });
  try {
    progress({ percent: 0 });
    await updater.download({ url: release.assetUrl, to, size: release.size, sha256: release.sha256, onProgress: progress, signal: controller.signal });
    if (IS_PORTABLE) await updater.replacePortable({ target: portableTarget(), fresh: to });
    else await updater.launchInstaller(to);
  } catch (err) {
    installing = null;
    broadcastState();
    try {
      fs.rmSync(to, { force: true });
    } catch {
      // already gone
    }
    if (err instanceof updater.UpdateError && err.kind === 'cancelled') return { text: "Okay, I stopped. Nothing was changed! 🐰" };
    return updateTrouble(err instanceof updater.UpdateError ? err : new updater.UpdateError(err.message, 'network'));
  }
  // The installer (or the swap) is running on its own now. Say goodbye, then get out of its way.
  installing = 'handoff';
  setTimeout(() => app.quit(), 1800);
  return { text: `Got v${release.version}! ✨ Updating now, I'll be right back! 👋`, handoff: true };
}

function cancelInstall() {
  if (installing && installing !== 'handoff') installing.abort();
}

// Tidy up what a finished (or abandoned) update left lying around.
function cleanUpdateLeftovers() {
  if (installing) return; // an update is being fetched right now
  const gone = (p) => {
    try {
      fs.rmSync(p, { recursive: true, force: true });
    } catch {
      // still in use: next time
    }
  };
  gone(updateFolder());
  const target = portableTarget();
  // (Never the ".old" file if the new one isn't there: that would be the only copy.)
  if (target && fs.existsSync(target)) for (const suffix of ['.old', '.new', '.new.part']) gone(`${target}${suffix}`);
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

    if (!query && !payload?.remind) {
      const askedAbout = updates.detectIntent(text);
      if (askedAbout === 'check') return { ok: true, ...(await updateReply()) };
      if (askedAbout === 'version') {
        const newer = visibleUpdate();
        return {
          ok: true,
          text: `I'm Nibo AI v${app.getVersion()}! 🐰${newer ? ` A newer one, v${newer.version}, is out though! 🎁` : ''}`,
          actions: newer ? updateChips() : [],
          sticky: Boolean(newer),
        };
      }
    }

    if (!query) {
      // "remind me to call mum in 20 minutes", "set a timer for 5 minutes", "cancel the timer"…
      const detect = payload?.remind ? reminders.detectFromPrompt : reminders.detect;
      // (The "Remind me…" prompt always starts something new, so a waiting "when?" doesn't apply.)
      const intent = book && detect(text, { now: new Date(), pending: payload?.remind ? null : pendingReminder() });
      // With the AI available, a time Nibo can't read himself ("it takes 3 minutes") is left to it.
      const reply = intent && !(intent.timey && brain.hasKey()) && reminderReply(intent);
      if (reply) return { ok: true, ...reply };
      pendingWhen = null;

      // "remember that I love cats", "call me Sam", "what do you remember?", "forget my name"
      const noteIntent = !payload?.remind && notebook && memory.detect(text);
      const noteReply = noteIntent && (await memoryReply(noteIntent));
      if (noteReply) return { ok: true, ...noteReply };

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
    const toolFlags = { reminder: false, remembered: false };
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
            remember: memoryOn() ? rememberTool(toolActions, toolFlags) : undefined,
            notes: memoryOn() ? notebook.forPrompt() : [],
          });
      if (result.ok) {
        petState = pet.cheer(petState, 1);
        savePet();
        if (toolActions.length) result.actions = toolActions;
        if (toolFlags.reminder) result.reminder = true;
        if (toolFlags.remembered) result.remembered = true;
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

  // Buttons under an answer: forget one note, open the notebook.
  ipcMain.handle('nibo:memory', (e, payload) => {
    if (!fromBunny(e) || !notebook) return { ok: false };
    const action = String(payload?.action ?? '');
    if (action === 'open') {
      openNotebook();
      return { ok: true };
    }
    if (action === 'forget') {
      const id = typeof payload?.arg === 'string' ? payload.arg : '';
      const note = notebook.remove(id);
      if (note) {
        if (lastSaved && lastSaved.id === id) lastSaved = null;
        notebookChanged();
      }
      return { ok: true, text: note ? 'Okay, I forgot that. 🧹' : 'That one is already gone. 🐰' };
    }
    return { ok: false };
  });

  // The notebook window.
  ipcMain.handle('memory:list', (e) =>
    fromMemory(e) ? { notes: notebook.list().map(({ id, text, at }) => ({ id, text, at })), on: memoryOn() } : null,
  );
  ipcMain.handle('memory:add', (e, text) => {
    if (!fromMemory(e)) return { ok: false };
    const res = saveNote(String(text ?? '').slice(0, memory.MAX_INPUT));
    return res.ok ? { ok: true } : { ok: false, message: NOT_SAVED[res.reason] || NOT_SAVED.empty };
  });
  ipcMain.handle('memory:remove', (e, id) => {
    if (!fromMemory(e)) return { ok: false };
    const note = notebook.remove(String(id));
    if (note) {
      if (lastSaved && lastSaved.id === note.id) lastSaved = null;
      notebookChanged();
    }
    return { ok: Boolean(note) };
  });
  ipcMain.handle('memory:clear', async (e) => {
    if (!fromMemory(e) || !notebook.count) return { cleared: false };
    return { cleared: await forgetEverything(memoryWin) };
  });
  ipcMain.on('memory:close', (e) => fromMemory(e) && memoryWin.close());

  // The 🎁 button: download / notes / dismiss / check.
  ipcMain.handle('nibo:update', async (e, payload) => {
    if (!fromBunny(e)) return { ok: false };
    const action = String(payload?.action ?? '');
    if (action === 'check') return { ok: true, ...(await updateReply()) };
    if (action === 'info') return { ok: true, ...(update ? newerReply() : await updateReply()) };
    if (action === 'announced') {
      if (update) store.set({ lastAnnouncedUpdate: update.version });
      return { ok: true };
    }
    if (action === 'dismiss') {
      if (update) store.set({ dismissedUpdate: update.version });
      updateChanged();
      return { ok: true, text: "Okay, I'll stay quiet about it! 🤫 Say “check for updates” whenever you like." };
    }
    if (action === 'install') return { ok: true, ...(await installUpdate()) };
    if (action === 'cancel') {
      cancelInstall();
      return { ok: true };
    }
    if (action === 'welcomed') {
      justUpdated = null;
      return { ok: true };
    }
    if (action === 'download' || action === 'notes') return { ok: true, ...(await openUpdate(action)) };
    return { ok: false };
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
      case 'stop-repeat': { // the 🔕 button on a repeating alert
        const stopped = ids.map((id) => book.remove(id)).filter(Boolean);
        ack(ids);
        broadcastState();
        if (!stopped.length) return { ok: true, text: 'That one has stopped already. 🐰' };
        return { ok: true, text: `Okay, I'll stop reminding you ${stopped.length === 1 && stopped[0].text ? `about “${reminders.shorten(stopped[0].text, 30)}”` : 'about those'}. 🔕` };
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
      checkUpdates: store.get('checkUpdates') !== false,
      memoryOn: memoryOn(),
      memoryCount: notebook ? notebook.count : 0,
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
    if (typeof patch.checkUpdates === 'boolean') next.checkUpdates = patch.checkUpdates;
    if (typeof patch.memoryOn === 'boolean') next.memoryOn = patch.memoryOn;
    if (MIC_SENSITIVITIES.includes(patch.micSensitivity)) next.micSensitivity = patch.micSensitivity;
    store.set(next);

    if ((IS_WIN || IS_MAC) && typeof patch.startWithSystem === 'boolean') {
      app.setLoginItemSettings({ openAtLogin: patch.startWithSystem });
    }
    if (next.model) brain.reset();
    if (next.checkUpdates) checkForUpdates();
    updateChanged();
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

  ipcMain.on('settings:open-memory', (e) => fromSettings(e) && openNotebook());

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
  notebook = new memory.Memory(memoryFile());

  // The first run after an update (by Nibo or by hand) gets a "ta-da".
  const lastRun = store.get('lastRunVersion');
  if (lastRun && updates.isNewer(app.getVersion(), lastRun)) justUpdated = { version: app.getVersion(), from: lastRun };
  if (lastRun !== app.getVersion()) store.set({ lastRunVersion: app.getVersion() });
  // Whatever the installer or the swap left behind is cleared out once things have settled.
  setTimeout(cleanUpdateLeftovers, 30_000).unref();

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

  // Is there a newer Nibo? Look shortly after start-up, then now and then.
  setTimeout(() => checkForUpdates(), process.env.UPDATE_API_BASE ? 1500 : 20_000).unref();
  setInterval(() => checkForUpdates(), UPDATE_EVERY_MS).unref();

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

// Nibo is a single-instance app. A copy started by an update (--updated) starts while the old
// one is still on its way out, so it waits a little for the old one to let go.
async function takeSingleInstanceLock() {
  if (app.requestSingleInstanceLock()) return true;
  if (!process.argv.includes('--updated')) return false;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    if (app.requestSingleInstanceLock()) return true;
  }
  return false;
}

takeSingleInstanceLock().then((got) => {
  if (!got) return app.quit();
  app.on('second-instance', () => {
    if (installing !== 'handoff') showNibo();
  });
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
});
