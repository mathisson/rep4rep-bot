const { contextBridge, ipcRenderer } = require('electron');

// The renderer gets exactly these calls and nothing else -- no Node, no fs,
// no ipcRenderer. contextIsolation stays on.
contextBridge.exposeInMainWorld('api', {
    state: () => ipcRenderer.invoke('state'),
    run: opts => ipcRenderer.invoke('run', opts),
    stop: () => ipcRenderer.invoke('stop'),
    saveToken: token => ipcRenderer.invoke('saveToken', token),
    steamLogin: account => ipcRenderer.invoke('steamLogin', account),
    removeAccount: name => ipcRenderer.invoke('removeAccount', name),
    getSettings: () => ipcRenderer.invoke('getSettings'),
    setSettings: patch => ipcRenderer.invoke('setSettings', patch),
    listStorage: () => ipcRenderer.invoke('listStorage'),
    errorLog: () => ipcRenderer.invoke('errorLog'),
    addProfile: p => ipcRenderer.invoke('addProfile', p),
    removeStorage: key => ipcRenderer.invoke('removeStorage', key),
    openConfigDir: () => ipcRenderer.invoke('openConfigDir'),
    answer: (id, value) => ipcRenderer.invoke('answer', { id, value }),
    onEvent: handler => ipcRenderer.on('event', (_e, payload) => handler(payload)),
});
