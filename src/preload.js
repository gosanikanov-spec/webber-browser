'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const CHANNELS = ['state', 'theme', 'omnibox-open', 'find-open', 'find-close', 'find-result', 'window-focus'];

contextBridge.exposeInMainWorld('webber', {
  cmd: (name, arg) => ipcRenderer.send('cmd', name, arg),
  suggest: (query) => ipcRenderer.invoke('suggest', query),
  on: (channel, fn) => {
    if (CHANNELS.includes(channel)) ipcRenderer.on(channel, (_e, data) => fn(data));
  },
});
