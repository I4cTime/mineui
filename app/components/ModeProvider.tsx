"use client";

// Simple/Advanced mode of the server that is open (feature: persistent mode
// toggle). Mode is per server profile (contract §2.5): this provider re-reads
// it whenever <ServerProvider> switches server, and reports `loading` from
// the very render in which the server changes, so <PageBoundary> never
// mounts a page with the previous server's mode.
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
import { ServerBoundary, useServers } from "@/app/components/ServerProvider";

const DEFAULT_MODE: Mode = "simple";
const UNAVAILABLE_MESSAGE =
  "Mode switching requires the Tauri runtime. Run the app via `pnpm tauri dev`, not a plain browser.";

interface ModeContextValue {
  /** Current app-wide mode. Defaults to "simple" until the initial load resolves. */
  mode: Mode;
  /** True until get_settings() has resolved (or failed soft) for the server
   *  that is currently open. */
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
  const { activeId, ready: serversReady } = useServers();
  const [mode, setModeState] = useState<Mode>(DEFAULT_MODE);
  // Which server `mode` was read for. Derived loading (not a flag flipped in
  // an effect) so it is already true in the render where activeId changes.
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const loading = !serversReady || loadedFor !== activeId;
  const [switching, setSwitching] = useState(false);
  // Only the latest refresh() may commit — a slow read for the previous
  // server must not overwrite the current server's mode.
  const refreshId = useRef(0);
  // Guards against out-of-order resolution when setMode() is called again
  // (e.g. a fast double toggle) before the first call's round trip finishes —
  // only the most recent call is allowed to commit its result.
  const requestId = useRef(0);

  const refresh = useCallback(async () => {
    const myRefresh = ++refreshId.current;
    if (!isTauri()) {
      setModeState(DEFAULT_MODE);
      setLoadedFor(activeId);
      return;
    }
    let next: Mode | null = null;
    try {
      next = (await getSettings()).activeMode;
    } catch {
      // Fail soft: fall back to DEFAULT_MODE on a server's first read (or
      // keep the held mode on a re-read) rather than crashing the whole app
      // over a mode read.
    }
    if (refreshId.current !== myRefresh) return;
    setModeState((held) => next ?? (loadedFor === activeId ? held : DEFAULT_MODE));
    setLoadedFor(activeId);
  }, [activeId, loadedFor]);

  useEffect(() => {
    if (!serversReady || loadedFor === activeId) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- IPC fetch-on-mount / on server switch
    refresh();
  }, [serversReady, loadedFor, activeId, refresh]);

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

/** The routed page, held back until the open server and its mode are known
 *  and remounted on every server switch (see ServerBoundary). */
export function PageBoundary({ children }: { children: React.ReactNode }) {
  const { loading } = useMode();
  return <ServerBoundary isLoading={loading}>{children}</ServerBoundary>;
}

export function useMode(): ModeContextValue {
  const ctx = useContext(ModeContext);
  if (!ctx) {
    throw new Error("useMode() must be used within a <ModeProvider>");
  }
  return ctx;
}
