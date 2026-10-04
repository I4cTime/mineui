"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { Howl } from "howler";
import {
  DEFAULT_SOUND_SET,
  SoundSetId,
  UISoundType,
  UI_SOUNDS,
  UI_SOUND_TYPES,
  isSoundSetId,
  soundSrc,
} from "@/app/lib/audio-constants";

// ═══════════════════════════════════════════════════════════════════════════
// SOUND SETTINGS STORE (localStorage-based)
// ═══════════════════════════════════════════════════════════════════════════

const STORAGE_KEY = "mineui-sound-settings";

interface SoundSettings {
  enabled: boolean;
  /** 0–100. */
  volume: number;
  /** Which sound set plays (app/lib/audio-constants.ts SOUND_SETS). */
  set: SoundSetId;
}

const defaultSettings: SoundSettings = {
  enabled: true,
  volume: 70,
  set: DEFAULT_SOUND_SET,
};

/** Whatever was stored (older versions had no `set`; a set can be retired)
 *  becomes a complete, valid settings object. */
function normalize(stored: Partial<SoundSettings> | null): SoundSettings {
  const volume = Number(stored?.volume);
  return {
    enabled: typeof stored?.enabled === "boolean" ? stored.enabled : defaultSettings.enabled,
    volume: Number.isFinite(volume) ? Math.min(100, Math.max(0, Math.round(volume))) : defaultSettings.volume,
    set: isSoundSetId(stored?.set) ? stored.set : DEFAULT_SOUND_SET,
  };
}

let cachedSettings: SoundSettings | null = null;
const listeners = new Set<() => void>();

function getSettings(): SoundSettings {
  if (cachedSettings) return cachedSettings;
  if (typeof window === "undefined") return defaultSettings;

  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    cachedSettings = stored ? normalize(JSON.parse(stored)) : defaultSettings;
  } catch {
    cachedSettings = defaultSettings;
  }
  return cachedSettings!;
}

function setSettings(settings: Partial<SoundSettings>) {
  const current = getSettings();
  const updated = normalize({ ...current, ...settings });
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

  const setSet = useCallback((set: SoundSetId) => {
    setSettings({ set });
  }, []);

  return {
    ...settings,
    setEnabled,
    setVolume,
    setSet,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// SOUND POOL
// ═══════════════════════════════════════════════════════════════════════════

// One pool per sound set, loaded the first time the set is needed (the
// active set at startup; another when the user previews or picks it).
const soundPools: Map<SoundSetId, Map<UISoundType, Howl>> = new Map();
const preloads: Map<SoundSetId, Promise<void>> = new Map();

function preloadSounds(set: SoundSetId): Promise<void> {
  const pending = preloads.get(set);
  if (pending) return pending;

  const pool: Map<UISoundType, Howl> = new Map();
  soundPools.set(set, pool);
  const promise = new Promise<void>((resolve) => {
    let loadedCount = 0;
    const totalSounds = UI_SOUND_TYPES.length;
    const settle = () => {
      loadedCount++;
      if (loadedCount === totalSounds) resolve();
    };

    UI_SOUND_TYPES.forEach((type) => {
      const config = UI_SOUNDS[type];
      pool.set(
        type,
        new Howl({
          src: [soundSrc(set, type)],
          volume: config.volume,
          loop: config.loop ?? false,
          preload: true,
          html5: false,
          onload: settle,
          onloaderror: settle,
        }),
      );
    });
  });
  preloads.set(set, promise);
  return promise;
}

/** Play one sound of one set at the given 0–100 volume (used by play() and
 *  by the set preview in App Settings, which must work for any set). */
function playFrom(set: SoundSetId, type: UISoundType, volume: number) {
  const howl = soundPools.get(set)?.get(type);
  if (!howl) return;
  const config = UI_SOUNDS[type];
  howl.volume(config.volume * (volume / 100));
  if (!config.loop) howl.stop();
  howl.play();
}

/** Audition a set regardless of the mute switch: a click, then the success
 *  chime - the two sounds heard most. */
export function previewSoundSet(set: SoundSetId, volume: number) {
  void preloadSounds(set).then(() => {
    playFrom(set, "click_confirm", volume);
    window.setTimeout(() => playFrom(set, "success", volume), 260);
  });
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
  const { enabled, volume, set } = settings;

  // Load the active set on mount and whenever the user picks another.
  useEffect(() => {
    void preloadSounds(set);
  }, [set]);

  const play = useCallback(
    (type: UISoundType) => {
      if (!enabled) return;
      if (shouldThrottle(type)) return;
      playFrom(set, type, volume);
    },
    [enabled, volume, set],
  );

  const stop = useCallback(
    (type: UISoundType) => {
      soundPools.get(set)?.get(type)?.stop();
    },
    [set],
  );

  const stopAll = useCallback(() => {
    soundPools.forEach((pool) => pool.forEach((howl) => howl.stop()));
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
