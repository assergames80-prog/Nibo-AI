'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('niboMemory', {
  list: () => ipcRenderer.invoke('memory:list'),
  add: (text) => ipcRenderer.invoke('memory:add', String(text)),
  remove: (id) => ipcRenderer.invoke('memory:remove', String(id)),
  clear: () => ipcRenderer.invoke('memory:clear'),
  close: () => ipcRenderer.send('memory:close'),
  onChange: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('memory:changed', listener);
    return () => ipcRenderer.removeListener('memory:changed', listener);
  },
});
