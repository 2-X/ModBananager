const { contextBridge, ipcRenderer } = require('electron');

let jobCounter = 0;

contextBridge.exposeInMainWorld('electron', {
  // dlUrl: GameBanana file download URL; gameId: GameBanana game id (looked up in games.json); fileName: archive name.
  // Returns a jobId that 'install-progress' / 'mod-installed' events carry.
  downloadAndUnzip: (dlUrl, gameId, fileName) => {
    const jobId = ++jobCounter;
    ipcRenderer.send('download-and-unzip', dlUrl, gameId, fileName, jobId);
    return jobId;
  },
  getGames: () => ipcRenderer.invoke('get-games'),
  saveGame: (id, entry) => ipcRenderer.invoke('save-game', id, entry),
  deleteGame: (id) => ipcRenderer.invoke('delete-game', id),
  pickFolder: (current) => ipcRenderer.invoke('pick-folder', current),
  openPath: (p) => ipcRenderer.invoke('open-path', p),
  openExternal: (u) => ipcRenderer.invoke('open-external', u),
  gbFetch: (u) => ipcRenderer.invoke('gb-fetch', u),
  listInstalled: (gameId) => ipcRenderer.invoke('list-installed', gameId),
  setModOrder: (gameId, order, enabled) => ipcRenderer.invoke('set-mod-order', gameId, order, enabled),
  uninstallMod: (gameId, folder) => ipcRenderer.invoke('uninstall-mod', gameId, folder),
});

contextBridge.exposeInMainWorld(
  'api', {
    send: (channel, data) => {
      let validChannels = ['add-mod'];
      if (validChannels.includes(channel)) {
        ipcRenderer.send(channel, data);
      }
    },
    receive: (channel, func) => {
      let validChannels = ['add-mod', 'mod-installed', 'install-progress'];
      if (validChannels.includes(channel)) {
        // Deliberately strip event as it includes `sender`
        ipcRenderer.on(channel, (event, ...args) => func(...args));
      }
    }
  }
);
