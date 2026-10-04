// app/lib/audio-constants.ts
// Centralized audio configuration for MineUI

export type UISoundType =
  | "hover"
  | "click_confirm"
  | "click_back"
  | "toggle_on"
  | "toggle_off"
  | "slider"
  | "success"
  | "error"
  | "processing"
  | "notification";

export interface UISoundConfig {
  /** File name inside a sound set's folder. */
  file: string;
  volume: number;
  loop?: boolean;
}

// Sound sets (App Settings → Sounds). Every set ships the same ten files
// under public/sounds/<dir>/, at matched loudness, so the per-sound volumes
// below hold for all of them. "classic" is the original hand-made set; the
// others are synthesized by scripts/gen-ui-sounds.py.
export const SOUND_SETS = [
  {
    id: "classic",
    dir: "/sounds/ui",
    label: "Classic",
    description: "The original MineUI clicks and chimes.",
  },
  {
    id: "blocks",
    dir: "/sounds/blocks",
    label: "Blocks",
    description: "Chiptune blips with stepped pitches.",
  },
  {
    id: "glass",
    dir: "/sounds/glass",
    label: "Glass",
    description: "Soft bells with gentle tails.",
  },
  {
    id: "terminal",
    dir: "/sounds/terminal",
    label: "Terminal",
    description: "Relay ticks and terse beeps.",
  },
] as const;

export type SoundSetId = (typeof SOUND_SETS)[number]["id"];
export const DEFAULT_SOUND_SET: SoundSetId = "classic";

export const isSoundSetId = (value: unknown): value is SoundSetId =>
  typeof value === "string" && SOUND_SETS.some((set) => set.id === value);

/** URL of one sound in one set. */
export const soundSrc = (set: SoundSetId, type: UISoundType): string =>
  `${SOUND_SETS.find((item) => item.id === set)?.dir ?? "/sounds/ui"}/${UI_SOUNDS[type].file}`;

export const UI_SOUNDS: Record<UISoundType, UISoundConfig> = {
  hover: {
    file: "ui_hover.mp3",
    volume: 0.3,
  },
  click_confirm: {
    file: "ui_click_confirm.mp3",
    volume: 0.5,
  },
  click_back: {
    file: "ui_click_back.mp3",
    volume: 0.4,
  },
  toggle_on: {
    file: "ui_toggle_on.mp3",
    volume: 0.5,
  },
  toggle_off: {
    file: "ui_toggle_off.mp3",
    volume: 0.45,
  },
  slider: {
    file: "ui_slider.mp3",
    volume: 0.25,
  },
  success: {
    file: "ui_success.mp3",
    volume: 0.55,
  },
  error: {
    file: "ui_error.mp3",
    volume: 0.5,
  },
  processing: {
    file: "ui_processing.mp3",
    volume: 0.3,
    loop: true,
  },
  notification: {
    file: "ui_notification.mp3",
    volume: 0.5,
  },
};

export const UI_SOUND_TYPES: UISoundType[] = Object.keys(
  UI_SOUNDS,
) as UISoundType[];
