const { contextBridge, ipcRenderer } = require('electron');
const INV = ['state', 'dl', 'dl:menu', 'dl:rename', 'dl:clear', 'add', 'set', 'rule:save', 'rule:del', 'cat:save', 'cat:del',
  'ignored:clear', 'pick', 'clip', 'ext:open', 'speed:test', 'update:check', 'update:install', 'prompt:init', 'prompt:done'];
const EV = ['patch', 'full', 'rename', 'toast'];
contextBridge.exposeInMainWorld('api', {
  on: (ch, f) => { if (EV.includes(ch)) ipcRenderer.on(ch, (e, ...a) => f(...a)); },
  invoke: (ch, ...a) => { if (!INV.includes(ch)) throw new Error('blocked'); return ipcRenderer.invoke(ch, ...a); }
});
