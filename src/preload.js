const { contextBridge, ipcRenderer } = require('electron');

// ipc bridge
contextBridge.exposeInMainWorld('electronAPI', {
  getState: () => ipcRenderer.invoke('get-state'),
  upgradeToPro: () => ipcRenderer.invoke('upgrade-to-pro'),
  confirmPremiumPayment: (paymentDetails) => ipcRenderer.invoke('confirm-premium-payment', paymentDetails),
  activateLicenseKey: (rawKey) => ipcRenderer.invoke('activate-license-key', rawKey),
  deactivateLicense: () => ipcRenderer.invoke('deactivate-license'),
  resetState: () => ipcRenderer.invoke('reset-state'),

  // paywall events
  onPaywallBlocked: (callback) => {
    const subscription = (event, data) => callback(data);
    ipcRenderer.on('paywall-blocked', subscription);
    return () => ipcRenderer.removeListener('paywall-blocked', subscription);
  },

  // drive operations
  getDrivesStatus: () => ipcRenderer.invoke('get-drives-status'),
  mountDrive: (driveId) => ipcRenderer.invoke('mount-drive', driveId),
  unmountDrive: (driveId) => ipcRenderer.invoke('unmount-drive', driveId),
  openDriveInExplorer: (driveId) => ipcRenderer.invoke('open-drive-in-explorer', driveId),
  onDriveReady: (callback) => {
    const subscription = (event, data) => callback(data);
    ipcRenderer.on('drive-ready', subscription);
    return () => ipcRenderer.removeListener('drive-ready', subscription);
  },

  // search operations
  searchFiles: (query) => ipcRenderer.invoke('search-files', query),
  revealFile: (filePath) => ipcRenderer.invoke('reveal-file', filePath)
});
