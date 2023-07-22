const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electron', {
  downloadAndUnzip: (url, outputFolder, modFolder) => {
    ipcRenderer.send('download-and-unzip', url, outputFolder, modFolder);
  }
});
