'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('niboSettings', {
  get: () => ipcRenderer.invoke('settings:get'),
  save: (patch) => ipcRenderer.invoke('settings:save', patch),
  testKey: (key) => ipcRenderer.invoke('settings:test-key', key),
  testTavily: (key) => ipcRenderer.invoke('settings:test-tavily', key),
  openMemory: () => ipcRenderer.send('settings:open-memory'),
  openExternal: (url) => ipcRenderer.send('settings:open-external', String(url)),
  close: () => ipcRenderer.send('settings:close'),
});
