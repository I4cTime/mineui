const { Menu, shell, app, dialog } = require("electron");

/**
 * Custom application menu with relevant actions for MineUI.
 */

function createAppMenu(mainWindow) {
  const isMac = process.platform === "darwin";

  const template = [
    // App menu (macOS only)
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
        ]
      : []),

    // File menu
    {
      label: "File",
      submenu: [
        {
          label: "Settings",
          accelerator: "CmdOrCtrl+,",
          click: () => {
            mainWindow.webContents.executeJavaScript(
              'window.location.href = "/settings"'
            );
          },
        },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },

    // View menu
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        { type: "separator" },
        { role: "toggleDevTools" },
      ],
    },

    // Server menu (MineUI specific)
    {
      label: "Server",
      submenu: [
        {
          label: "Dashboard",
          accelerator: "CmdOrCtrl+1",
          click: () => {
            mainWindow.webContents.executeJavaScript(
              'window.location.href = "/"'
            );
          },
        },
        {
          label: "Status",
          accelerator: "CmdOrCtrl+2",
          click: () => {
            mainWindow.webContents.executeJavaScript(
              'window.location.href = "/status"'
            );
          },
        },
        {
          label: "Players",
          accelerator: "CmdOrCtrl+3",
          click: () => {
            mainWindow.webContents.executeJavaScript(
              'window.location.href = "/players"'
            );
          },
        },
        {
          label: "Mods",
          accelerator: "CmdOrCtrl+4",
          click: () => {
            mainWindow.webContents.executeJavaScript(
              'window.location.href = "/mods"'
            );
          },
        },
        {
          label: "Config",
          accelerator: "CmdOrCtrl+5",
          click: () => {
            mainWindow.webContents.executeJavaScript(
              'window.location.href = "/config"'
            );
          },
        },
        {
          label: "RCON",
          accelerator: "CmdOrCtrl+6",
          click: () => {
            mainWindow.webContents.executeJavaScript(
              'window.location.href = "/rcon"'
            );
          },
        },
      ],
    },

    // Window menu
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(isMac
          ? [
              { type: "separator" },
              { role: "front" },
              { type: "separator" },
              { role: "window" },
            ]
          : [{ role: "close" }]),
      ],
    },

    // Help menu
    {
      label: "Help",
      submenu: [
        {
          label: "Documentation",
          click: async () => {
            await shell.openExternal("https://github.com/i4cdeath/mineui");
          },
        },
        {
          label: "Report Issue",
          click: async () => {
            await shell.openExternal(
              "https://github.com/i4cdeath/mineui/issues"
            );
          },
        },
        { type: "separator" },
        {
          label: "Support on Ko-fi",
          click: async () => {
            await shell.openExternal("https://ko-fi.com/i4cdeath");
          },
        },
        { type: "separator" },
        {
          label: "About MineUI",
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: "info",
              title: "About MineUI",
              message: "MineUI",
              detail: `Version: ${app.getVersion()}\n\nA desktop application for managing your local Minecraft server running in Podman.\n\nMade with ❤️ by i4cdeath`,
              buttons: ["OK"],
            });
          },
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

module.exports = { createAppMenu };
