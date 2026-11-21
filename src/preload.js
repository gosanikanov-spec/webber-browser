'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('webber', {
  cmd: (name, arg) => ipcRenderer.send('cmd', name, arg),
  on: (channel, fn) => {
    const allowed = ['state', 'focus-address', 'find-open', 'find-close', 'find-result', 'window-focus'];
    if (!allowed.includes(channel)) return;
    ipcRenderer.on(channel, (_e, data) => fn(data));
  },
});
