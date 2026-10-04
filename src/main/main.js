'use strict';

const path = require('path');
const fs = require('fs');
const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  ipcMain,
  nativeImage,
  safeStorage,
  screen,
  shell,
} = require('electron');

const { Store } = require('./store');
const { Brain, DEFAULT_MODEL, testKey } = require('./brain');
const pet = require('./pet');
const offline = require('./offline');

const WIN_W = 360;
const WIN_H = 620;
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
// Forwarded mouse events (needed for click-through) only exist on Windows and macOS.
const CLICK_THROUGH = IS_WIN || IS_MAC;
const ASSETS = path.join(__dirname, '..', '..', 'assets');
const RENDERER = path.join(__dirname, '..', 'renderer');

let win = null;
let settingsWin = null;
let tray = null;
let store = null;
let brain = null;
let petState = null;
let dragTimer = null;
let hopping = false;
const inflight = new Map();

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
      firstRun: Boolean(store.get('firstRun')),
    },
    platform: process.platform,
    clickThrough: CLICK_THROUGH,
  };
}

function broadcastState() {
  send('nibo:state', snapshot());
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

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 760,
    height: 560,
    useContentSize: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'Nibo AI — Settings',
    icon: iconPath(),
    backgroundColor: '#FFF8EE',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'settings-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  settingsWin.setMenu(null);
  settingsWin.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  settingsWin.webContents.on('will-navigate', (e) => e.preventDefault());
  settingsWin.once('ready-to-show', () => settingsWin.show());
  settingsWin.on('closed', () => {
    settingsWin = null;
  });
  settingsWin.loadFile(path.join(RENDERER, 'settings.html'));
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
      { label: 'Hide Nibo', click: () => win && win.hide() },
      { type: 'separator' },
      { label: 'Feed Nibo 🥕', click: () => (showNibo(), send('nibo:command', 'feed')) },
      { label: 'Settings…', click: openSettings },
      { type: 'separator' },
      { label: 'Quit Nibo', click: () => app.quit() },
    ]),
  );
  tray.on('click', () => {
    if (!win) return;
    if (win.isVisible()) win.hide();
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

async function listDesktop() {
  const dirs = [app.getPath('desktop')];
  if (IS_WIN && process.env.PUBLIC) dirs.push(path.join(process.env.PUBLIC, 'Desktop'));
  const entries = [];
  for (const dir of dirs) {
    try {
      const items = await fs.promises.readdir(dir, { withFileTypes: true });
      for (const item of items.slice(0, 500)) entries.push({ name: item.name, isDir: item.isDirectory() });
    } catch {
      // folder missing or unreadable: skip it
    }
  }
  return entries;
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

    const query = offline.detectSearch(text);
    if (query) return { ok: true, text: await openSearch(query), searched: true };

    if (!brain.hasKey()) {
      const local = offline.answer(text, { mood: pet.moodOf(petState) });
      return { ok: true, offline: true, text: local.text, actions: local.actions };
    }

    const controller = new AbortController();
    inflight.set(id, controller);
    try {
      const result = await brain.ask(text, {
        signal: controller.signal,
        status: {
          mood: pet.moodOf(petState),
          fullness: petState.fullness,
          localTime: new Date().toLocaleString(),
        },
        onDelta: (delta) => {
          if (!e.sender.isDestroyed()) e.sender.send('nibo:delta', { id, delta });
        },
      });
      if (result.ok) {
        petState = pet.cheer(petState, 1);
        savePet();
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

  ipcMain.on('nibo:cancel', (e, id) => {
    if (!fromBunny(e)) return;
    const controller = inflight.get(String(id));
    if (controller) controller.abort();
  });

  ipcMain.handle('nibo:preset', async (e, payload) => {
    if (!fromBunny(e)) return { ok: false };
    const name = String(payload?.name ?? '');
    if (name === 'organize') {
      const report = offline.organize(await listDesktop());
      return { ok: true, text: report.text, total: report.total };
    }
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
  ipcMain.on('nibo:hide', (e) => fromBunny(e) && win.hide());
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

    const next = {};
    if (typeof patch.model === 'string' && /^[\w.\-/:]{1,120}$/.test(patch.model.trim())) next.model = patch.model.trim();
    if (Object.hasOwn(offline.SEARCH_ENGINES, patch.searchEngine)) next.searchEngine = patch.searchEngine;
    if (typeof patch.voice === 'boolean') next.voice = patch.voice;
    if (typeof patch.boil === 'boolean') next.boil = patch.boil;
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

  brain = new Brain({
    getApiKey: () => store.getApiKey(),
    getModel: () => store.get('model'),
    setModel: (model) => store.set({ model }),
  });

  registerIpc();
  createBunnyWindow();
  createTray();

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
  app.on('before-quit', () => {
    for (const controller of inflight.values()) controller.abort();
    if (store) {
      savePet();
      savePosition();
    }
  });
}
