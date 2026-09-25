const { contextBridge, ipcRenderer } = require('electron');

// The renderer gets exactly these calls and nothing else -- no Node, no fs,
// no ipcRenderer. contextIsolation stays on.
contextBridge.exposeInMainWorld('api', {
    state: () => ipcRenderer.invoke('state'),
    run: opts => ipcRenderer.invoke('run', opts),
    stop: () => ipcRenderer.invoke('stop'),
    saveToken: token => ipcRenderer.invoke('saveToken', token),
    steamLogin: account => ipcRenderer.invoke('steamLogin', account),
    answer: (id, value) => ipcRenderer.invoke('answer', { id, value }),
    onEvent: handler => ipcRenderer.on('event', (_e, payload) => handler(payload)),
});
