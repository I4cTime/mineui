"use client";

// App Settings → Appearance: theme choice + user accent override. Applies to
// the whole app, not to a server. The swatch fills are user-pickable data
// values (see ACCENT_PRESETS), not UI styling; the surrounding chrome stays
// on theme tokens.
import { useMemo, useRef } from "react";
import { Check, Palette } from "lucide-react";
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
import { useUISound } from "@/app/hooks/useUISound";
import { ACCENT_PRESETS, useAccentColor } from "@/app/hooks/useAccentColor";
import { THEMES, useTheme, type ThemeId } from "@/app/hooks/useTheme";

export default function AppearanceCard() {
  const { play } = useUISound();
  const { accent, setAccent } = useAccentColor();
  const { theme, setTheme } = useTheme();
  const themeRefs = useRef<Record<ThemeId, HTMLButtonElement | null>>({
    deepslate: null,
    phosphor: null,
    quantum: null,
    softglass: null,
  });
  const handleThemeSelect = (next: ThemeId) => {
    if (next === theme) return;
    play("toggle_on");
    setTheme(next);
  };
  const handleThemeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const index = THEMES.findIndex((t) => t.id === theme);
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (index + 1) % THEMES.length;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = (index - 1 + THEMES.length) % THEMES.length;
    if (nextIndex === null) return;
    event.preventDefault();
    const next = THEMES[nextIndex].id;
    handleThemeSelect(next);
    themeRefs.current[next]?.focus();
  };
  // What the custom ColorPicker shows: the override when set, else the
  // current theme's own accent read from the DOM. Safe to read during
  // render — this card only mounts behind PageBoundary (client-only), and
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
  }, [accent]);

  return (
    <Card className="p-6">
      <Card.Header className="flex-col items-start gap-1">
        <div className="flex items-center gap-2">
          <Palette size={16} className="text-accent" />
          <Card.Title>Appearance</Card.Title>
        </div>
        <Card.Description>
          Pick a theme, then optionally override its accent everywhere
          in the app. Both apply instantly and persist on this machine.
        </Card.Description>
      </Card.Header>
      <Card.Content className="mt-4 flex flex-col items-start gap-4">
        <div
          role="radiogroup"
          aria-label="Theme"
          className="grid w-full gap-3 sm:grid-cols-2"
          onKeyDown={handleThemeKeyDown}
        >
          {THEMES.map((option) => {
            const selected = option.id === theme;
            return (
              <button
                key={option.id}
                ref={(node) => {
                  themeRefs.current[option.id] = node;
                }}
                type="button"
                role="radio"
                aria-checked={selected}
                tabIndex={selected ? 0 : -1}
                onClick={() => handleThemeSelect(option.id)}
                onMouseEnter={() => play("hover")}
                className="relative flex items-start gap-3 rounded-lg border p-4 text-left focus-visible:outline-2 focus-visible:outline-offset-2"
                style={{
                  borderColor: selected ? "var(--accent)" : "var(--border)",
                  background: selected
                    ? "color-mix(in oklab, var(--accent) 8%, transparent)"
                    : "var(--surface-secondary)",
                  outlineColor: "var(--focus)",
                  transition:
                    "border-color var(--motion-fast) var(--motion-ease), background var(--motion-fast) var(--motion-ease)",
                }}
              >
                <span className="flex-1">
                  <span className="block text-sm font-semibold">{option.label}</span>
                  <span className="mt-1 block text-xs text-muted">{option.description}</span>
                </span>
                {selected && (
                  <span
                    aria-hidden
                    className="flex size-5 shrink-0 items-center justify-center rounded-full"
                    style={{ background: "var(--accent)", color: "var(--accent-foreground)" }}
                  >
                    <Check size={12} />
                  </span>
                )}
              </button>
            );
          })}
        </div>
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
              // "slider" is throttled (50ms) in useUISound — safe for
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
              Reset to theme accent
            </Button>
          )}
        </div>
      </Card.Content>
    </Card>
  );
}
