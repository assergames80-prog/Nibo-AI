'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = new Set(['nibo:delta', 'nibo:search-status', 'nibo:state', 'nibo:cursor', 'nibo:hop', 'nibo:command', 'nibo:reminder', 'nibo:update']);

contextBridge.exposeInMainWorld('nibo', {
  getState: () => ipcRenderer.invoke('nibo:get-state'),
  getLines: () => ipcRenderer.invoke('nibo:get-lines'),
  ask: (id, text, opts = {}) => ipcRenderer.invoke('nibo:ask', { id, text, search: Boolean(opts.search), remind: Boolean(opts.remind) }),
  transcribe: (wav) => ipcRenderer.invoke('nibo:transcribe', wav instanceof Uint8Array ? wav : new Uint8Array(wav)),
  micAccess: () => ipcRenderer.invoke('nibo:mic-access'),
  tts: (text) => ipcRenderer.invoke('nibo:tts', String(text)),
  cancel: (id) => ipcRenderer.send('nibo:cancel', id),
  preset: (name, arg) => ipcRenderer.invoke('nibo:preset', { name, arg }),
  openApp: (name) => ipcRenderer.invoke('nibo:open-app', String(name)),
  update: (action) => ipcRenderer.invoke('nibo:update', { action: String(action) }),
  reminders: (action, arg) => ipcRenderer.invoke('nibo:reminders', { action: String(action), arg }),
  organize: (target) => ipcRenderer.invoke('nibo:organize', String(target)),
  organizeUndo: () => ipcRenderer.invoke('nibo:organize-undo'),
  openOrganized: () => ipcRenderer.send('nibo:open-organized'),
  feed: () => ipcRenderer.invoke('nibo:feed'),
  pat: () => ipcRenderer.invoke('nibo:pat'),
  setVoice: (on) => ipcRenderer.invoke('nibo:set-voice', Boolean(on)),
  setIgnoreMouse: (ignore) => ipcRenderer.send('nibo:set-ignore-mouse', Boolean(ignore)),
  dragStart: () => ipcRenderer.send('nibo:drag-start'),
  dragEnd: () => ipcRenderer.send('nibo:drag-end'),
  clearChat: () => ipcRenderer.send('nibo:clear-chat'),
  firstRunDone: () => ipcRenderer.send('nibo:first-run-done'),
  openSettings: () => ipcRenderer.send('nibo:open-settings'),
  openExternal: (url) => ipcRenderer.send('nibo:open-external', String(url)),
  hide: () => ipcRenderer.send('nibo:hide'),
  quit: () => ipcRenderer.send('nibo:quit'),
  on: (channel, callback) => {
    if (!EVENTS.has(channel)) throw new Error(`Unknown channel ${channel}`);
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});
