const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktop', {
  api: (operation, args) => ipcRenderer.invoke('api', operation, args),
  chooseFiles: () => ipcRenderer.invoke('choose-files'),
  saveFile: (fileId, filename) => ipcRenderer.invoke('save-file', fileId, filename),
  copy: (text) => ipcRenderer.invoke('copy', text),
  billing: (provider) => ipcRenderer.invoke('billing', provider),
});
