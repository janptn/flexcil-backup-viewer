const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('launcherApi', {
  getState: () => ipcRenderer.invoke('launcher:get-state'),
  openInterface: () => ipcRenderer.invoke('launcher:open-interface'),
  copyAddress: () => ipcRenderer.invoke('launcher:copy-address'),
  quit: () => ipcRenderer.invoke('launcher:quit'),
  onStatus: (callback) => {
    const handler = (_event, payload) => callback(payload)
    ipcRenderer.on('launcher:status', handler)
    return () => {
      ipcRenderer.removeListener('launcher:status', handler)
    }
  },
})
