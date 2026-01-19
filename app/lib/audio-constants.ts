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
  src: string;
  volume: number;
  loop?: boolean;
}

export const UI_SOUNDS: Record<UISoundType, UISoundConfig> = {
  hover: {
    src: "/sounds/ui/ui_hover.mp3",
    volume: 0.3,
  },
  click_confirm: {
    src: "/sounds/ui/ui_click_confirm.mp3",
    volume: 0.5,
  },
  click_back: {
    src: "/sounds/ui/ui_click_back.mp3",
    volume: 0.4,
  },
  toggle_on: {
    src: "/sounds/ui/ui_toggle_on.mp3",
    volume: 0.5,
  },
  toggle_off: {
    src: "/sounds/ui/ui_toggle_off.mp3",
    volume: 0.45,
  },
  slider: {
    src: "/sounds/ui/ui_slider.mp3",
    volume: 0.25,
  },
  success: {
    src: "/sounds/ui/ui_success.mp3",
    volume: 0.55,
  },
  error: {
    src: "/sounds/ui/ui_error.mp3",
    volume: 0.5,
  },
  processing: {
    src: "/sounds/ui/ui_processing.mp3",
    volume: 0.3,
    loop: true,
  },
  notification: {
    src: "/sounds/ui/ui_notification.mp3",
    volume: 0.5,
  },
};

export const UI_SOUND_TYPES: UISoundType[] = Object.keys(
  UI_SOUNDS,
) as UISoundType[];
