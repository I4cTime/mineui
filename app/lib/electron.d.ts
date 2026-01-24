/**
 * Type definitions for the Electron API exposed via preload script.
 * These are available on window.electronAPI when running in Electron.
 */

export interface ElectronAPI {
  // App info
  getAppVersion: () => Promise<string>;
  getPlatform: () => string;

  // Window controls
  minimizeWindow: () => void;
  maximizeWindow: () => void;
  closeWindow: () => void;

  // Native dialogs
  showOpenDialog: (options: OpenDialogOptions) => Promise<OpenDialogReturnValue>;
  showSaveDialog: (options: SaveDialogOptions) => Promise<SaveDialogReturnValue>;
  showMessageBox: (options: MessageBoxOptions) => Promise<MessageBoxReturnValue>;

  // Notifications
  showNotification: (title: string, body: string) => void;

  // External links
  openExternal: (url: string) => void;

  // Server status updates
  onServerStatus: (callback: (status: string) => void) => () => void;

  // App lifecycle
  onBeforeQuit: (callback: () => void) => () => void;
}

interface OpenDialogOptions {
  title?: string;
  defaultPath?: string;
  buttonLabel?: string;
  filters?: FileFilter[];
  properties?: Array<
    | "openFile"
    | "openDirectory"
    | "multiSelections"
    | "showHiddenFiles"
    | "createDirectory"
    | "promptToCreate"
    | "noResolveAliases"
    | "treatPackageAsDirectory"
    | "dontAddToRecent"
  >;
  message?: string;
}

interface SaveDialogOptions {
  title?: string;
  defaultPath?: string;
  buttonLabel?: string;
  filters?: FileFilter[];
  message?: string;
  nameFieldLabel?: string;
  showsTagField?: boolean;
}

interface FileFilter {
  name: string;
  extensions: string[];
}

interface OpenDialogReturnValue {
  canceled: boolean;
  filePaths: string[];
}

interface SaveDialogReturnValue {
  canceled: boolean;
  filePath?: string;
}

interface MessageBoxOptions {
  type?: "none" | "info" | "error" | "question" | "warning";
  buttons?: string[];
  defaultId?: number;
  title?: string;
  message: string;
  detail?: string;
  checkboxLabel?: string;
  checkboxChecked?: boolean;
  cancelId?: number;
  noLink?: boolean;
}

interface MessageBoxReturnValue {
  response: number;
  checkboxChecked: boolean;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export {};
