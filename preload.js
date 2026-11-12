const { contextBridge, ipcRenderer } = require('electron');
const OK = ['state', 'dl', 'add', 'set', 'rule:set', 'rule:del', 'ignored:clear', 'pick', 'ext:open', 'update:check', 'update:install'];
contextBridge.exposeInMainWorld('api', {
  onState: f => ipcRenderer.on('state', (e, s) => f(s)),
  state: () => ipcRenderer.invoke('state'),
  invoke: (ch, ...a) => { if (!OK.includes(ch)) throw new Error('blocked'); return ipcRenderer.invoke(ch, ...a); }
});
