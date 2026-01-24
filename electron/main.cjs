const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  Notification,
} = require("electron");
const { createServer } = require("http");
const path = require("path");
const next = require("next");

const { loadWindowState, trackWindowState } = require("./windowState.cjs");
const { createAppMenu } = require("./menu.cjs");

// ============================================================================
// Configuration
// ============================================================================

const isDev = !app.isPackaged;
const DEV_SERVER_URL = process.env.ELECTRON_START_URL || "http://localhost:3000";

// Disable hardware acceleration to prevent libva errors on Linux
app.disableHardwareAcceleration();

// ============================================================================
// Single Instance Lock
// ============================================================================

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  console.log("Another instance is already running. Exiting.");
  app.quit();
} else {
  app.on("second-instance", (_event, _commandLine, _workingDirectory) => {
    // Focus the main window if user tries to open another instance
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();
    }
  });
}

// ============================================================================
// Global State
// ============================================================================

let mainWindow = null;
let serverInstance = null;
let serverPort = null;

// ============================================================================
// Next.js Server (Production)
// ============================================================================

async function startNextServer() {
  const appPath = app.getAppPath();
  const nextApp = next({ dev: false, dir: appPath });
  const handle = nextApp.getRequestHandler();

  sendStatusToWindow("Preparing Next.js application...");

  try {
    await nextApp.prepare();
    sendStatusToWindow("Starting HTTP server...");

    return new Promise((resolve, reject) => {
      const httpServer = createServer((req, res) => handle(req, res));

      httpServer.on("error", (err) => {
        console.error("HTTP server error:", err);
        reject(err);
      });

      httpServer.listen(0, "127.0.0.1", () => {
        const address = httpServer.address();
        console.log(`Next.js server running on http://127.0.0.1:${address.port}`);
        resolve({ server: httpServer, port: address.port });
      });
    });
  } catch (error) {
    console.error("Failed to start Next.js server:", error);
    throw error;
  }
}

// ============================================================================
// Window Management
// ============================================================================

function sendStatusToWindow(status) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("server:status", status);
  }
}

async function createWindow() {
  const windowState = loadWindowState();

  mainWindow = new BrowserWindow({
    width: windowState.width,
    height: windowState.height,
    x: windowState.x,
    y: windowState.y,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#0b0f0b",
    show: false, // Don't show until ready
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  // Restore maximized state
  if (windowState.isMaximized) {
    mainWindow.maximize();
  }

  // Track window state for persistence
  trackWindowState(mainWindow);

  // Create custom application menu
  createAppMenu(mainWindow);

  // Show loading screen first
  const loadingPath = isDev
    ? path.join(__dirname, "loading.html")
    : path.join(process.resourcesPath, "electron", "loading.html");
  await mainWindow.loadFile(loadingPath);
  mainWindow.show();

  // Open DevTools in development
  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }

  try {
    if (isDev) {
      // Development: load from Next.js dev server
      sendStatusToWindow("Connecting to development server...");
      await mainWindow.loadURL(DEV_SERVER_URL);
    } else {
      // Production: start embedded Next.js server
      const { server, port } = await startNextServer();
      serverInstance = server;
      serverPort = port;

      sendStatusToWindow("Loading application...");
      await mainWindow.loadURL(`http://127.0.0.1:${port}`);
    }
  } catch (error) {
    console.error("Failed to load application:", error);
    handleLoadError(error);
  }

  // Handle external links
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  // Handle navigation errors
  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription) => {
    if (errorCode !== -3) {
      // Ignore aborted navigations
      console.error(`Page load failed: ${errorDescription} (${errorCode})`);
      handleLoadError(new Error(errorDescription));
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function handleLoadError(error) {
  const errorMessage = error.message || "Unknown error";

  dialog
    .showMessageBox(mainWindow, {
      type: "error",
      title: "Failed to Load",
      message: "MineUI failed to start",
      detail: `Error: ${errorMessage}\n\nThis could be caused by:\n• Next.js server failed to start\n• Port conflict\n• Missing dependencies\n\nTry restarting the application.`,
      buttons: ["Retry", "Quit"],
      defaultId: 0,
    })
    .then(({ response }) => {
      if (response === 0) {
        // Retry
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.close();
        }
        createWindow();
      } else {
        app.quit();
      }
    });
}

// ============================================================================
// IPC Handlers
// ============================================================================

function setupIpcHandlers() {
  // App info
  ipcMain.handle("app:version", () => app.getVersion());

  // Window controls
  ipcMain.on("window:minimize", () => {
    if (mainWindow) mainWindow.minimize();
  });

  ipcMain.on("window:maximize", () => {
    if (mainWindow) {
      if (mainWindow.isMaximized()) {
        mainWindow.unmaximize();
      } else {
        mainWindow.maximize();
      }
    }
  });

  ipcMain.on("window:close", () => {
    if (mainWindow) mainWindow.close();
  });

  // Native dialogs
  ipcMain.handle("dialog:open", async (_event, options) => {
    return dialog.showOpenDialog(mainWindow, options);
  });

  ipcMain.handle("dialog:save", async (_event, options) => {
    return dialog.showSaveDialog(mainWindow, options);
  });

  ipcMain.handle("dialog:message", async (_event, options) => {
    return dialog.showMessageBox(mainWindow, options);
  });

  // Notifications
  ipcMain.on("notification:show", (_event, { title, body }) => {
    if (Notification.isSupported()) {
      new Notification({ title, body }).show();
    }
  });

  // External links
  ipcMain.on("shell:openExternal", (_event, url) => {
    shell.openExternal(url);
  });
}

// ============================================================================
// App Lifecycle
// ============================================================================

app.whenReady().then(() => {
  setupIpcHandlers();
  createWindow();

  app.on("activate", () => {
    // macOS: re-create window when dock icon is clicked
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  // Clean up server
  if (serverInstance) {
    serverInstance.close(() => {
      console.log("Next.js server closed");
    });
    serverInstance = null;
  }

  // Quit on all platforms except macOS
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  // Notify renderer of impending quit
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("app:beforeQuit");
  }
});

// Handle uncaught exceptions
process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);

  dialog.showMessageBoxSync({
    type: "error",
    title: "Unexpected Error",
    message: "An unexpected error occurred",
    detail: error.message,
    buttons: ["OK"],
  });
});
