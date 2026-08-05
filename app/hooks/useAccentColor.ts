"use client";

import { useCallback, useSyncExternalStore } from "react";

// User accent override. Persists in localStorage alongside the theme choice
// (both are appearance-local, not backend Settings — docs/v2-contract.md is
// untouched). The override is applied as inline custom properties on <html>,
// which win over every theme block; HeroUI's derived vars (--accent-hover,
// --accent-soft, ...) are color-mix()ed from --accent and follow for free,
// as do --focus/--link (defined as var(--accent) in all four themes).

const STORAGE_KEY = "mineui-accent-override";
const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

// Preset swatches offered in Settings → Appearance. These are user-pickable
// *data values* (any color is reachable through the custom picker), not UI
// styling — the chrome around them still renders from theme tokens. The
// first four are the shipped themes' own accents.
export const ACCENT_PRESETS = [
  { id: "emerald", label: "Emerald", value: "#3ddc84" },
  { id: "cyan", label: "Quantum cyan", value: "#00d1ff" },
  { id: "amber", label: "Phosphor amber", value: "#ffb224" },
  { id: "apricot", label: "Apricot", value: "#f5a97f" },
  { id: "violet", label: "Violet", value: "#a082ff" },
  { id: "rose", label: "Rose", value: "#ff6b9c" },
  { id: "red", label: "Redstone", value: "#ff5d5d" },
  { id: "sky", label: "Sky", value: "#4c8dff" },
] as const;

let cached: string | null | undefined;
const listeners = new Set<() => void>();

export function getAccentOverride(): string | null {
  if (cached !== undefined) return cached;
  if (typeof window === "undefined") return null;
  const stored = window.localStorage.getItem(STORAGE_KEY);
  cached = stored !== null && HEX_RE.test(stored) ? stored : null;
  return cached;
}

function relativeLuminance(hex: string): number {
  const full =
    hex.length === 4
      ? `#${[...hex.slice(1)].map((c) => c + c).join("")}`
      : hex;
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(full.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(l1: number, l2: number): number {
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Apply (or clear) the stored override on <html>. --accent-foreground is
 * not a fixed black/white: it's whichever of the current theme's own
 * --background / --foreground tokens contrasts better with the chosen
 * accent, so text on accent fills stays tokenized and theme-consistent.
 * Call again after a theme switch — the bg/fg tokens it reads change.
 */
export function applyAccentOverride() {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const value = getAccentOverride();
  if (value === null) {
    root.style.removeProperty("--accent");
    root.style.removeProperty("--accent-foreground");
    return;
  }
  const styles = getComputedStyle(root);
  const bg = styles.getPropertyValue("--background").trim();
  const fg = styles.getPropertyValue("--foreground").trim();
  const accentL = relativeLuminance(value);
  const score = (candidate: string) =>
    HEX_RE.test(candidate)
      ? contrastRatio(accentL, relativeLuminance(candidate))
      : 0;
  const bgScore = score(bg);
  const fgScore = score(fg);
  const foreground =
    bgScore === 0 && fgScore === 0
      ? "var(--background)"
      : bgScore >= fgScore
        ? bg
        : fg;
  root.style.setProperty("--accent", value);
  root.style.setProperty("--accent-foreground", foreground);
}

function setAccentOverride(value: string | null) {
  cached = value !== null && HEX_RE.test(value) ? value.toLowerCase() : null;
  if (typeof window !== "undefined") {
    if (cached === null) {
      window.localStorage.removeItem(STORAGE_KEY);
    } else {
      window.localStorage.setItem(STORAGE_KEY, cached);
    }
  }
  applyAccentOverride();
  listeners.forEach((listener) => listener());
}

function subscribe(callback: () => void) {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

function getServerSnapshot(): string | null {
  return null;
}

export function useAccentColor() {
  const accent = useSyncExternalStore(
    subscribe,
    getAccentOverride,
    getServerSnapshot,
  );

  const setAccent = useCallback((value: string | null) => {
    setAccentOverride(value);
  }, []);

  return { accent, setAccent };
}
