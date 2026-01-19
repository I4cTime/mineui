"use client";

import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import { Howl } from "howler";
import {
  UISoundType,
  UI_SOUNDS,
  UI_SOUND_TYPES,
} from "@/app/lib/audio-constants";

// ═══════════════════════════════════════════════════════════════════════════
// SOUND SETTINGS STORE (localStorage-based)
// ═══════════════════════════════════════════════════════════════════════════

const STORAGE_KEY = "mineui-sound-settings";

interface SoundSettings {
  enabled: boolean;
  volume: number;
}

const defaultSettings: SoundSettings = {
  enabled: true,
  volume: 70,
};

let cachedSettings: SoundSettings | null = null;
const listeners = new Set<() => void>();

function getSettings(): SoundSettings {
  if (cachedSettings) return cachedSettings;
  if (typeof window === "undefined") return defaultSettings;

  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    cachedSettings = stored ? JSON.parse(stored) : defaultSettings;
  } catch {
    cachedSettings = defaultSettings;
  }
  return cachedSettings!;
}

function setSettings(settings: Partial<SoundSettings>) {
  const current = getSettings();
  const updated = { ...current, ...settings };
  cachedSettings = updated;

  if (typeof window !== "undefined") {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
  }

  listeners.forEach((listener) => listener());
}

function subscribe(callback: () => void) {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

function getSnapshot() {
  return getSettings();
}

function getServerSnapshot() {
  return defaultSettings;
}

export function useSoundSettings() {
  const settings = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );

  const setEnabled = useCallback((enabled: boolean) => {
    setSettings({ enabled });
  }, []);

  const setVolume = useCallback((volume: number) => {
    setSettings({ volume });
  }, []);

  return {
    ...settings,
    setEnabled,
    setVolume,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// SOUND POOL
// ═══════════════════════════════════════════════════════════════════════════

const soundPool: Map<UISoundType, Howl> = new Map();
let isPreloaded = false;
let preloadPromise: Promise<void> | null = null;

function preloadSounds(): Promise<void> {
  if (isPreloaded) return Promise.resolve();
  if (preloadPromise) return preloadPromise;

  preloadPromise = new Promise((resolve) => {
    let loadedCount = 0;
    const totalSounds = UI_SOUND_TYPES.length;

    UI_SOUND_TYPES.forEach((type) => {
      const config = UI_SOUNDS[type];

      const howl = new Howl({
        src: [config.src],
        volume: config.volume,
        loop: config.loop ?? false,
        preload: true,
        html5: false,
        onload: () => {
          loadedCount++;
          if (loadedCount === totalSounds) {
            isPreloaded = true;
            resolve();
          }
        },
        onloaderror: () => {
          loadedCount++;
          if (loadedCount === totalSounds) {
            isPreloaded = true;
            resolve();
          }
        },
      });

      soundPool.set(type, howl);
    });
  });

  return preloadPromise;
}

// ═══════════════════════════════════════════════════════════════════════════
// THROTTLE
// ═══════════════════════════════════════════════════════════════════════════

const lastPlayTime: Map<UISoundType, number> = new Map();

const THROTTLE_TIMES: Partial<Record<UISoundType, number>> = {
  hover: 100,
  slider: 50,
  click_confirm: 50,
  click_back: 50,
};

function shouldThrottle(type: UISoundType): boolean {
  const throttleTime = THROTTLE_TIMES[type];
  if (!throttleTime) return false;

  const now = Date.now();
  const lastTime = lastPlayTime.get(type) ?? 0;

  if (now - lastTime < throttleTime) {
    return true;
  }

  lastPlayTime.set(type, now);
  return false;
}

// ═══════════════════════════════════════════════════════════════════════════
// HOOK
// ═══════════════════════════════════════════════════════════════════════════

interface UseUISoundReturn {
  play: (type: UISoundType) => void;
  stop: (type: UISoundType) => void;
  stopAll: () => void;
  isEnabled: boolean;
}

export function useUISound(): UseUISoundReturn {
  const settings = useSoundSettings();
  const hasPreloadedRef = useRef(false);

  useEffect(() => {
    if (!hasPreloadedRef.current) {
      hasPreloadedRef.current = true;
      preloadSounds();
    }
  }, []);

  const play = useCallback(
    (type: UISoundType) => {
      if (!settings.enabled) return;
      if (shouldThrottle(type)) return;

      const howl = soundPool.get(type);
      if (!howl) return;

      const config = UI_SOUNDS[type];
      const finalVolume = config.volume * (settings.volume / 100);

      howl.volume(finalVolume);

      if (!config.loop) {
        howl.stop();
      }

      howl.play();
    },
    [settings.enabled, settings.volume],
  );

  const stop = useCallback((type: UISoundType) => {
    const howl = soundPool.get(type);
    if (howl) {
      howl.stop();
    }
  }, []);

  const stopAll = useCallback(() => {
    soundPool.forEach((howl) => {
      howl.stop();
    });
  }, []);

  return {
    play,
    stop,
    stopAll,
    isEnabled: settings.enabled,
  };
}

export function useUISoundPlayer() {
  const { play } = useUISound();
  return play;
}
