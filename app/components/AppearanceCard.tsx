"use client";

// App Settings → Appearance: color mode (dark / light / match system), style
// choice and user accent override. Applies to the whole app, not to a server. The swatch fills are user-pickable data
// values (see ACCENT_PRESETS), not UI styling; the surrounding chrome stays
// on theme tokens.
import { useMemo } from "react";
import { Monitor, Moon, Palette, Sun } from "lucide-react";
import {
  Button,
  Card,
  ColorArea,
  ColorField,
  ColorPicker,
  ColorSlider,
  ColorSwatch,
  ColorSwatchPicker,
  Label,
} from "@heroui/react";
import { Segment } from "@heroui-pro/react";
import ChoiceCards from "@/app/components/ChoiceCards";
import { firstKey } from "@/app/lib/keys";
import { useUISound } from "@/app/hooks/useUISound";
import { ACCENT_PRESETS, useAccentColor } from "@/app/hooks/useAccentColor";
import { THEMES, useTheme } from "@/app/hooks/useTheme";
import {
  COLOR_MODES,
  useColorMode,
  type ColorModePreference,
} from "@/app/hooks/useColorMode";

const MODE_ICONS: Record<ColorModePreference, typeof Sun> = {
  dark: Moon,
  light: Sun,
  system: Monitor,
};

export default function AppearanceCard() {
  const { play } = useUISound();
  const { accent, setAccent } = useAccentColor();
  const { theme, setTheme } = useTheme();
  const { preference, mode, setPreference } = useColorMode();
  const handleModeSelect = (next: ColorModePreference) => {
    if (next === preference) return;
    play("toggle_on");
    setPreference(next);
  };
  // What the custom ColorPicker shows: the override when set, else the
  // current theme's own accent read from the DOM. Safe to read during
  // render - this card only mounts behind PageBoundary (client-only), and
  // a reset re-runs this memo after the inline override is already removed,
  // so it picks up the theme value again.
  const pickerColor = useMemo(() => {
    if (accent !== null) return accent;
    if (typeof document === "undefined") return "#3ddc84";
    return (
      getComputedStyle(document.documentElement)
        .getPropertyValue("--accent")
        .trim() || "#3ddc84"
    );
    // `mode` and `theme`: the palette's own accent differs per mode and style.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accent, mode, theme]);

  return (
    <Card className="p-6">
      <Card.Header className="flex-col items-start gap-1">
        <div className="flex items-center gap-2">
          <Palette size={16} className="text-accent" />
          <Card.Title>Appearance</Card.Title>
        </div>
        <Card.Description>
          Choose dark or light, pick a style, then optionally override its
          accent everywhere in the app. All three apply instantly and persist
          on this machine.
        </Card.Description>
      </Card.Header>
      <Card.Content className="mt-4 flex flex-col items-start gap-4">
        <Label className="text-sm">Mode</Label>
        <Segment
          aria-label="Color mode"
          selectedKey={preference}
          onSelectionChange={(key: unknown) => {
            const next = firstKey(key);
            if (next) handleModeSelect(next as ColorModePreference);
          }}
        >
          {COLOR_MODES.map((option) => {
            const Icon = MODE_ICONS[option.id];
            return (
              <Segment.Item
                key={option.id}
                id={option.id}
                onMouseEnter={() => play("hover")}
              >
                <Icon size={15} />
                {option.label}
                {option.id === "system" && (
                  <span className="text-xs font-normal text-muted">now {mode}</span>
                )}
              </Segment.Item>
            );
          })}
        </Segment>
        <Label id="appearance-style" className="text-sm">Style</Label>
        <ChoiceCards
          aria-labelledby="appearance-style"
          className="sm:grid-cols-2"
          value={theme}
          onChange={setTheme}
          options={THEMES.map((option) => ({
            id: option.id,
            title: option.label,
            description: mode === "light" ? option.descriptionLight : option.description,
          }))}
        />
        <Label className="text-sm">Accent override</Label>
        {/* Preset swatches. The transparent sentinel keeps the picker
            controlled while matching no preset when no override is
            set (RAC selects by color equality). */}
        <ColorSwatchPicker
          aria-label="Preset accent colors"
          value={accent ?? "rgba(0, 0, 0, 0)"}
          onChange={(color) => {
            play("toggle_on");
            setAccent(color.toString("hex"));
          }}
        >
          {ACCENT_PRESETS.map((preset) => (
            <ColorSwatchPicker.Item
              key={preset.id}
              color={preset.value}
              aria-label={preset.label}
            >
              <ColorSwatchPicker.Swatch />
              <ColorSwatchPicker.Indicator />
            </ColorSwatchPicker.Item>
          ))}
        </ColorSwatchPicker>

        <div className="flex flex-wrap items-center gap-3">
          <ColorPicker
            value={pickerColor}
            onChange={(color) => {
              // "slider" is throttled (50ms) in useUISound - safe for
              // the continuous onChange stream while dragging.
              play("slider");
              setAccent(color.toString("hex"));
            }}
          >
            <ColorPicker.Trigger onMouseEnter={() => play("hover")}>
              <ColorSwatch size="sm" />
              Custom color
            </ColorPicker.Trigger>
            <ColorPicker.Popover placement="bottom start">
              <div className="flex w-60 flex-col gap-3">
                <ColorArea
                  colorSpace="hsb"
                  xChannel="saturation"
                  yChannel="brightness"
                  className="h-40 w-full"
                >
                  <ColorArea.Thumb />
                </ColorArea>
                <ColorSlider channel="hue" colorSpace="hsb">
                  <ColorSlider.Track>
                    <ColorSlider.Thumb />
                  </ColorSlider.Track>
                </ColorSlider>
                <ColorField aria-label="Hex color">
                  <ColorField.Group fullWidth>
                    <ColorField.Input />
                  </ColorField.Group>
                </ColorField>
              </div>
            </ColorPicker.Popover>
          </ColorPicker>

          {accent !== null && (
            <Button
              variant="ghost"
              size="sm"
              onPress={() => {
                play("click_back");
                setAccent(null);
              }}
              onMouseEnter={() => play("hover")}
            >
              Reset to style accent
            </Button>
          )}
        </div>
        {accent !== null && mode === "light" && (
          <p className="text-xs text-muted">
            In light mode a bright pick is shown darker, so text and icons in
            this color stay readable. Your choice is kept as picked for dark
            mode.
          </p>
        )}
      </Card.Content>
    </Card>
  );
}
