// Thin wrapper around the Tauri dialog plugin (contract §3.5: upload_mod takes
// a host filesystem path obtained via the dialog plugin — no multipart upload
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
