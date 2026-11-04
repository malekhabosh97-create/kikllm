const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("electronAPI", {
  onStatusUpdate(callback) { const handler = (_event, value) => callback(value); ipcRenderer.on("status-update", handler); return () => ipcRenderer.removeListener("status-update", handler); }
});
contextBridge.exposeInMainWorld("freellmDesktop", {
  embedded: true,
  setBrowserBounds: bounds => ipcRenderer.invoke("freellm:browser-bounds", bounds),
  hideBrowser: () => ipcRenderer.invoke("freellm:browser-hide"),
  selectFolder: () => ipcRenderer.invoke("freellm:select-folder"),
  onTabSelected(callback) { const handler = (_event, value) => callback(value); ipcRenderer.on("freellm:tab-selected", handler); return () => ipcRenderer.removeListener("freellm:tab-selected", handler); }
});
