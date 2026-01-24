const { app, screen } = require("electron");
const fs = require("fs");
const path = require("path");

/**
 * Window state manager - persists window size and position between sessions.
 */

const STATE_FILE = "window-state.json";

function getStateFilePath() {
  return path.join(app.getPath("userData"), STATE_FILE);
}

function getDefaultState() {
  return {
    width: 1280,
    height: 900,
    x: undefined,
    y: undefined,
    isMaximized: false,
  };
}

function validateState(state, displays) {
  // Check if the window is visible on any display
  const isVisible = displays.some((display) => {
    const { x, y, width, height } = display.bounds;
    return (
      state.x >= x &&
      state.x < x + width &&
      state.y >= y &&
      state.y < y + height
    );
  });

  return isVisible;
}

function loadWindowState() {
  try {
    const filePath = getStateFilePath();

    if (!fs.existsSync(filePath)) {
      return getDefaultState();
    }

    const data = fs.readFileSync(filePath, "utf-8");
    const state = JSON.parse(data);

    // Validate saved position is still visible (user may have changed monitors)
    if (state.x !== undefined && state.y !== undefined) {
      const displays = screen.getAllDisplays();
      if (!validateState(state, displays)) {
        // Reset position if window would be off-screen
        state.x = undefined;
        state.y = undefined;
      }
    }

    return {
      ...getDefaultState(),
      ...state,
    };
  } catch (error) {
    console.error("Failed to load window state:", error);
    return getDefaultState();
  }
}

function saveWindowState(window) {
  try {
    const filePath = getStateFilePath();
    const isMaximized = window.isMaximized();
    const bounds = window.getBounds();

    const state = {
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      isMaximized,
    };

    fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
  } catch (error) {
    console.error("Failed to save window state:", error);
  }
}

function trackWindowState(window) {
  let saveTimeout = null;

  const debouncedSave = () => {
    if (saveTimeout) {
      clearTimeout(saveTimeout);
    }
    saveTimeout = setTimeout(() => {
      if (!window.isDestroyed()) {
        saveWindowState(window);
      }
    }, 500);
  };

  window.on("resize", debouncedSave);
  window.on("move", debouncedSave);
  window.on("maximize", debouncedSave);
  window.on("unmaximize", debouncedSave);

  // Save immediately before close
  window.on("close", () => {
    if (saveTimeout) {
      clearTimeout(saveTimeout);
    }
    saveWindowState(window);
  });
}

module.exports = {
  loadWindowState,
  saveWindowState,
  trackWindowState,
};
