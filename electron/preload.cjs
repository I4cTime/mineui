const { contextBridge, ipcRenderer } = require("electron");

/**
 * Preload script for secure IPC communication between renderer and main process.
 * Exposes a limited API to the renderer through contextBridge.
 */

contextBridge.exposeInMainWorld("electronAPI", {
  // App info
  getAppVersion: () => ipcRenderer.invoke("app:version"),
  getPlatform: () => process.platform,

  // Window controls
  minimizeWindow: () => ipcRenderer.send("window:minimize"),
  maximizeWindow: () => ipcRenderer.send("window:maximize"),
  closeWindow: () => ipcRenderer.send("window:close"),

  // Native dialogs
  showOpenDialog: (options) => ipcRenderer.invoke("dialog:open", options),
  showSaveDialog: (options) => ipcRenderer.invoke("dialog:save", options),
  showMessageBox: (options) => ipcRenderer.invoke("dialog:message", options),

  // Notifications
  showNotification: (title, body) =>
    ipcRenderer.send("notification:show", { title, body }),

  // External links
  openExternal: (url) => ipcRenderer.send("shell:openExternal", url),

  // Server status updates from main process
  onServerStatus: (callback) => {
    ipcRenderer.on("server:status", (_event, status) => callback(status));
    return () => ipcRenderer.removeAllListeners("server:status");
  },

  // App lifecycle
  onBeforeQuit: (callback) => {
    ipcRenderer.on("app:beforeQuit", () => callback());
    return () => ipcRenderer.removeAllListeners("app:beforeQuit");
  },
});
