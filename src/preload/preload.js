'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = new Set(['nibo:delta', 'nibo:state', 'nibo:cursor', 'nibo:hop', 'nibo:command']);

contextBridge.exposeInMainWorld('nibo', {
  getState: () => ipcRenderer.invoke('nibo:get-state'),
  getLines: () => ipcRenderer.invoke('nibo:get-lines'),
  ask: (id, text) => ipcRenderer.invoke('nibo:ask', { id, text }),
  cancel: (id) => ipcRenderer.send('nibo:cancel', id),
  preset: (name, arg) => ipcRenderer.invoke('nibo:preset', { name, arg }),
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
