"use client";

import { useEffect, useState } from "react";
import type { ElectronAPI } from "@/app/lib/electron.d";

/**
 * Hook to access Electron API when running in Electron context.
 * Returns null when running in browser.
 */
export function useElectron(): ElectronAPI | null {
  const [electronAPI, setElectronAPI] = useState<ElectronAPI | null>(null);

  useEffect(() => {
    if (typeof window !== "undefined" && window.electronAPI) {
      setElectronAPI(window.electronAPI);
    }
  }, []);

  return electronAPI;
}

/**
 * Check if running in Electron environment.
 */
export function isElectron(): boolean {
  if (typeof window === "undefined") return false;
  return !!window.electronAPI;
}

/**
 * Hook to get app version when running in Electron.
 */
export function useAppVersion(): string | null {
  const [version, setVersion] = useState<string | null>(null);
  const electron = useElectron();

  useEffect(() => {
    if (electron) {
      electron.getAppVersion().then(setVersion);
    }
  }, [electron]);

  return version;
}
