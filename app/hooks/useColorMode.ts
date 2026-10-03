"use client";

import { useCallback, useSyncExternalStore } from "react";
import { applyAccentOverride } from "./useAccentColor";

// Color mode (docs/theme-contract.md §10): every style has a dark and a
// light palette; `data-mode` on <html> picks one. The preference is
// appearance-local like the style and the accent (localStorage, not backend
// Settings). "system" follows the OS and keeps following it while the app
// is open. Default stays dark: that is what every install had before 2.9.
export type ColorModePreference = "dark" | "light" | "system";
export type ColorMode = "dark" | "light";

export const COLOR_MODES: { id: ColorModePreference; label: string }[] = [
  { id: "dark", label: "Dark" },
  { id: "light", label: "Light" },
  { id: "system", label: "Match system" },
];

const STORAGE_KEY = "mineui-color-mode";
export const DEFAULT_COLOR_MODE: ColorModePreference = "dark";
const LIGHT_QUERY = "(prefers-color-scheme: light)";

const isPreference = (value: string | null): value is ColorModePreference =>
  value === "dark" || value === "light" || value === "system";

let cached: ColorModePreference | undefined;
const listeners = new Set<() => void>();

export function getStoredColorMode(): ColorModePreference {
  if (cached !== undefined) return cached;
  if (typeof window === "undefined") return DEFAULT_COLOR_MODE;
  const stored = window.localStorage.getItem(STORAGE_KEY);
  cached = isPreference(stored) ? stored : DEFAULT_COLOR_MODE;
  return cached;
}

const systemIsLight = () =>
  typeof window !== "undefined" && window.matchMedia(LIGHT_QUERY).matches;

/** What the preference means right now. */
export function resolveColorMode(preference: ColorModePreference): ColorMode {
  if (preference === "system") return systemIsLight() ? "light" : "dark";
  return preference;
}

/** Stamp `data-mode` on <html> and re-derive the accent override, whose
 *  shade and foreground both depend on the palette in force. */
export function applyColorMode(preference: ColorModePreference) {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.mode = resolveColorMode(preference);
  applyAccentOverride();
}

function setStoredColorMode(preference: ColorModePreference) {
  cached = preference;
  if (typeof window !== "undefined") {
    window.localStorage.setItem(STORAGE_KEY, preference);
  }
  applyColorMode(preference);
  listeners.forEach((listener) => listener());
}

function subscribe(callback: () => void) {
  listeners.add(callback);
  // The OS flipping light/dark matters only under "system", but the
  // resolved value is recomputed either way — cheap, and always right.
  const media = typeof window !== "undefined" ? window.matchMedia(LIGHT_QUERY) : null;
  const onSystemChange = () => {
    applyColorMode(getStoredColorMode());
    callback();
  };
  media?.addEventListener("change", onSystemChange);
  return () => {
    listeners.delete(callback);
    media?.removeEventListener("change", onSystemChange);
  };
}

const getResolvedSnapshot = (): ColorMode => resolveColorMode(getStoredColorMode());
// Server render stays dark (the default); the stored mode is stamped by
// public/theme-init.js before paint and re-applied after hydration.
const getServerPreference = (): ColorModePreference => DEFAULT_COLOR_MODE;
const getServerResolved = (): ColorMode => "dark";

export function useColorMode() {
  const preference = useSyncExternalStore(subscribe, getStoredColorMode, getServerPreference);
  const mode = useSyncExternalStore(subscribe, getResolvedSnapshot, getServerResolved);
  const setPreference = useCallback((next: ColorModePreference) => {
    setStoredColorMode(next);
  }, []);
  return { preference, mode, setPreference };
}
