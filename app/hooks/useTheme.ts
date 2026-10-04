"use client";

import { useCallback, useSyncExternalStore } from "react";
import { applyAccentOverride } from "./useAccentColor";

// Theme choice. Registry per docs/theme-contract.md §1; persisted in
// localStorage (appearance-local, not backend Settings). Legacy ids
// (emerald/ember/aether/void) have no CSS block anymore and resolve to
// :root = deepslate, so anything unrecognized falls back to deepslate.
export const THEMES = [
  {
    id: "deepslate",
    label: "Deepslate & Emerald",
    description: "Deepslate stone, emerald signal - the tool Mojang would ship.",
    descriptionLight: "Calcite stone, emerald signal - the same tool in daylight.",
  },
  {
    id: "phosphor",
    label: "Phosphor Amber",
    description: "Near-black ops console with an amber phosphor glow.",
    descriptionLight: "Paper console: warm off-white, amber ink, no shadows.",
  },
  {
    id: "quantum",
    label: "Quantum Fluidity",
    description: "Deep-space black, cyan signal, violet glow - the I4C look.",
    descriptionLight: "Daybreak white, deep cyan signal, a trace of violet glow.",
  },
  {
    id: "softglass",
    label: "Soft Glass",
    description: "Calm, rounded, native-grade - one warm apricot accent.",
    descriptionLight: "Calm, rounded, native-grade - warm paper and terracotta.",
  },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];

const STORAGE_KEY = "mineui-theme";
export const DEFAULT_THEME: ThemeId = "deepslate";
const THEME_IDS: readonly string[] = THEMES.map((t) => t.id);

const isThemeId = (value: string | null): value is ThemeId =>
  value !== null && THEME_IDS.includes(value);

let cached: ThemeId | undefined;
const listeners = new Set<() => void>();

export function getStoredTheme(): ThemeId {
  if (cached !== undefined) return cached;
  if (typeof window === "undefined") return DEFAULT_THEME;
  const stored = window.localStorage.getItem(STORAGE_KEY);
  cached = isThemeId(stored) ? stored : DEFAULT_THEME;
  return cached;
}

/** Stamp `data-theme` on <html> and re-derive the accent override, whose
 *  foreground pick depends on the theme's bg/fg tokens. */
export function applyTheme(theme: ThemeId) {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = theme;
  applyAccentOverride();
}

function setStoredTheme(theme: ThemeId) {
  cached = theme;
  if (typeof window !== "undefined") {
    window.localStorage.setItem(STORAGE_KEY, theme);
  }
  applyTheme(theme);
  listeners.forEach((listener) => listener());
}

function subscribe(callback: () => void) {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

function getServerSnapshot(): ThemeId {
  // The server-rendered value stays deepslate to avoid a hydration mismatch;
  // the stored theme is applied after hydration (see useTheme).
  return DEFAULT_THEME;
}

export function useTheme() {
  const theme = useSyncExternalStore(subscribe, getStoredTheme, getServerSnapshot);
  const setTheme = useCallback((next: ThemeId) => {
    setStoredTheme(next);
  }, []);
  return { theme, setTheme };
}
