const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('launcherApi', {
  getState: () => ipcRenderer.invoke('launcher:get-state'),
  openInterface: () => ipcRenderer.invoke('launcher:open-interface'),
  copyAddress: () => ipcRenderer.invoke('launcher:copy-address'),
  quit: () => ipcRenderer.invoke('launcher:quit'),
  checkUpdates: () => ipcRenderer.invoke('launcher:check-updates'),
  installUpdate: () => ipcRenderer.invoke('launcher:install-update'),
  onStatus: (callback) => {
    const handler = (_event, payload) => callback(payload)
    ipcRenderer.on('launcher:status', handler)
    return () => {
      ipcRenderer.removeListener('launcher:status', handler)
    }
  },
  onUpdate: (callback) => {
    const handler = (_event, payload) => callback(payload)
    ipcRenderer.on('launcher:update', handler)
    return () => {
      ipcRenderer.removeListener('launcher:update', handler)
    }
  },
})
