// Thin wrapper around the Tauri dialog plugin (contract §3.5: upload_mod takes
// a host filesystem path obtained via the dialog plugin - no multipart upload
// in v2). Kept out of ipc.ts so that file stays verbatim to the contract spec.
import { open } from "@tauri-apps/plugin-dialog";
import { isTauri, IpcError } from "@/app/lib/ipc";

/**
 * Opens a native file picker for a mod/plugin archive.
 * Resolves with the absolute host path, or null when the user cancels.
 */
export async function pickModFile(): Promise<string | null> {
  if (!isTauri()) {
    throw new IpcError(
      "INTERNAL",
      "File picker requires the Tauri runtime. Run the app via `pnpm tauri dev`.",
    );
  }
  const selected = await open({
    multiple: false,
    directory: false,
    title: "Select a mod or plugin (.jar / .zip)",
    filters: [{ name: "Mod archives", extensions: ["jar", "zip"] }],
  });
  return typeof selected === "string" ? selected : null;
}

/**
 * Opens a native file picker for a CurseForge app export (profile → Export),
 * a .zip with manifest.json and overrides/ (contract §3.13, 2.8.0).
 */
export async function pickModpackZip(): Promise<string | null> {
  if (!isTauri()) {
    throw new IpcError(
      "INTERNAL",
      "File picker requires the Tauri runtime. Run the app via `pnpm tauri dev`.",
    );
  }
  const selected = await open({
    multiple: false,
    directory: false,
    title: "Select a CurseForge modpack export (.zip)",
    filters: [{ name: "CurseForge modpack export", extensions: ["zip"] }],
  });
  return typeof selected === "string" ? selected : null;
}

/**
 * Opens a native folder picker. Resolves with the absolute host path, or
 * null when the user cancels. Used for the backup copy folder.
 */
export async function pickFolder(title: string): Promise<string | null> {
  if (!isTauri()) {
    throw new IpcError(
      "INTERNAL",
      "Folder picker requires the Tauri runtime. Run the app via `pnpm tauri dev`.",
    );
  }
  const selected = await open({ multiple: false, directory: true, title });
  return typeof selected === "string" ? selected : null;
}

/**
 * Opens a native file picker for any single file (e.g. the java program).
 */
export async function pickFile(title: string): Promise<string | null> {
  if (!isTauri()) {
    throw new IpcError(
      "INTERNAL",
      "File picker requires the Tauri runtime. Run the app via `pnpm tauri dev`.",
    );
  }
  const selected = await open({ multiple: false, directory: false, title });
  return typeof selected === "string" ? selected : null;
}
