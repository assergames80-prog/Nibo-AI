'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('niboOrganize', {
  getPlan: () => ipcRenderer.invoke('organize:get-plan'),
  approve: (ids) => ipcRenderer.send('organize:approve', Array.from(ids, String)),
  cancel: () => ipcRenderer.send('organize:cancel'),
});
