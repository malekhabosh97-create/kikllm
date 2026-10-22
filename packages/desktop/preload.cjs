const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  onStatusUpdate: (callback) => ipcRenderer.on("status-update", (_event, value) => callback(value)),
});
