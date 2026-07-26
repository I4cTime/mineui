"use client";

// App-wide Simple/Advanced mode state (feature: persistent mode toggle).
//
// Backs onto the same backend settings store every page used to fetch
// independently (app/lib/ipc.ts get_settings/set_settings) — this component
// is the single source of truth so every page agrees on the current mode
// without a remount, instead of each page discovering it on its own mount.
//
// Fails soft outside Tauri (`pnpm dev` browser preview, no backend): mode
// defaults to "simple" and setMode() is a no-op that surfaces the same
// "requires the Tauri runtime" messaging used elsewhere (see
// app/lib/dialog.ts, app/lib/ipc.ts `call()`).
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { toast } from "@heroui/react";
import {
  getSettings,
  isTauri,
  setSettings as saveSettingsIpc,
  IpcError,
  type Mode,
} from "@/app/lib/ipc";

const DEFAULT_MODE: Mode = "simple";
const UNAVAILABLE_MESSAGE =
  "Mode switching requires the Tauri runtime. Run the app via `pnpm tauri dev`, not a plain browser.";

interface ModeContextValue {
  /** Current app-wide mode. Defaults to "simple" until the initial load resolves. */
  mode: Mode;
  /** True until the initial get_settings() call resolves (or fails soft). */
  loading: boolean;
  /** True while a setMode() call is in flight — gate mode controls on this. */
  switching: boolean;
  /** Optimistically switches mode and persists it; reverts + toasts on failure. */
  setMode: (mode: Mode) => Promise<void>;
  /** Re-reads settings from the backend and adopts the mode it reports.
   *  Call after any other write to Settings so this provider can't go stale. */
  refresh: () => Promise<void>;
}

const ModeContext = createContext<ModeContextValue | null>(null);

export default function ModeProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [mode, setModeState] = useState<Mode>(DEFAULT_MODE);
  const [loading, setLoading] = useState(true);
  const [switching, setSwitching] = useState(false);
  // Guards against out-of-order resolution when setMode() is called again
  // (e.g. a fast double toggle) before the first call's round trip finishes —
  // only the most recent call is allowed to commit its result.
  const requestId = useRef(0);

  const refresh = useCallback(async () => {
    if (!isTauri()) {
      setModeState(DEFAULT_MODE);
      setLoading(false);
      return;
    }
    try {
      const settings = await getSettings();
      setModeState(settings.activeMode);
    } catch {
      // Fail soft: keep whatever mode is currently held (DEFAULT_MODE on
      // first load) rather than crashing the whole app over a mode read.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- IPC fetch-on-mount: the loader flips its loading flag synchronously by design
    refresh();
  }, [refresh]);

  const setMode = useCallback(
    async (next: Mode) => {
      if (!isTauri()) {
        toast.danger(UNAVAILABLE_MESSAGE);
        return;
      }
      if (next === mode) return;
      const previous = mode;
      const myRequest = ++requestId.current;
      setModeState(next); // optimistic
      setSwitching(true);
      try {
        // Re-read current settings first (not the optimistic local mode) so
        // this can't stomp an edit made elsewhere (e.g. the Settings page
        // draft) between our last read and now — only activeMode changes.
        const current = await getSettings();
        const normalized = await saveSettingsIpc({
          ...current,
          activeMode: next,
        });
        if (requestId.current !== myRequest) return; // superseded, drop it
        setModeState(normalized.activeMode);
      } catch (error) {
        if (requestId.current !== myRequest) return;
        setModeState(previous);
        toast.danger(
          error instanceof IpcError ? error.message : "Failed to switch mode",
        );
      } finally {
        if (requestId.current === myRequest) setSwitching(false);
      }
    },
    [mode],
  );

  return (
    <ModeContext.Provider value={{ mode, loading, switching, setMode, refresh }}>
      {children}
    </ModeContext.Provider>
  );
}

export function useMode(): ModeContextValue {
  const ctx = useContext(ModeContext);
  if (!ctx) {
    throw new Error("useMode() must be used within a <ModeProvider>");
  }
  return ctx;
}
