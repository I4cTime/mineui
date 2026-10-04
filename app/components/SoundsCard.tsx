"use client";

// App Settings → Sounds: the interface sounds — on/off, how loud, and which
// set. App-wide and stored on this machine, like the appearance. The header's
// speaker button stays as the quick mute.
import { useRef } from "react";
import { Check, Play, Volume2 } from "lucide-react";
import { Button, Card, Label, Slider, Switch } from "@heroui/react";
import { SOUND_SETS, type SoundSetId } from "@/app/lib/audio-constants";
import { previewSoundSet, useSoundSettings, useUISound } from "@/app/hooks/useUISound";

export default function SoundsCard() {
  const { play } = useUISound();
  const { enabled, volume, set, setEnabled, setVolume, setSet } = useSoundSettings();
  const setRefs = useRef<Partial<Record<SoundSetId, HTMLButtonElement | null>>>({});

  const choose = (next: SoundSetId) => {
    if (next === set) return;
    setSet(next);
    // Hear what you picked — at the current volume, even when muted would
    // make no sense, so only when sounds are on.
    if (enabled) previewSoundSet(next, volume);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const index = SOUND_SETS.findIndex((item) => item.id === set);
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (index + 1) % SOUND_SETS.length;
    if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = (index - 1 + SOUND_SETS.length) % SOUND_SETS.length;
    if (nextIndex === null) return;
    event.preventDefault();
    const next = SOUND_SETS[nextIndex].id;
    choose(next);
    setRefs.current[next]?.focus();
  };

  return (
    <Card className="p-6">
      <Card.Header className="flex-col items-start gap-1">
        <div className="flex items-center gap-2">
          <Volume2 size={16} className="text-accent" />
          <Card.Title>Sounds</Card.Title>
        </div>
        <Card.Description>
          The small sounds MineUI makes when you click, switch and finish
          things. They apply instantly and are remembered on this machine.
        </Card.Description>
      </Card.Header>
      <Card.Content className="mt-4 flex flex-col gap-5">
        <Switch
          isSelected={enabled}
          onChange={(selected: boolean) => {
            setEnabled(selected);
            // After the store updates `play` is still the old closure, so
            // audition directly: the switch-on sound of the chosen set.
            if (selected) previewSoundSet(set, volume);
          }}
        >
          <Switch.Content>
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
            <Label>Play interface sounds</Label>
          </Switch.Content>
        </Switch>

        <div className="grid gap-2">
          <Slider
            className="w-full max-w-md"
            value={volume}
            minValue={0}
            maxValue={100}
            step={5}
            isDisabled={!enabled}
            formatOptions={{ style: "unit", unit: "percent" }}
            onChange={(value) => {
              setVolume(value as number);
              play("slider");
            }}
            onChangeEnd={() => play("click_confirm")}
          >
            <Label>Volume</Label>
            <Slider.Output />
            <Slider.Track>
              <Slider.Fill />
              <Slider.Thumb />
            </Slider.Track>
          </Slider>
          <span className="text-xs text-muted">
            Relative to your system volume. Let go of the slider to hear it.
          </span>
        </div>

        <div className="grid gap-2">
          <Label className="text-sm">Sound set</Label>
          <div
            role="radiogroup"
            aria-label="Sound set"
            className="grid w-full gap-3 sm:grid-cols-2"
            onKeyDown={handleKeyDown}
          >
            {SOUND_SETS.map((option) => {
              const selected = option.id === set;
              return (
                <div
                  key={option.id}
                  className="flex items-stretch gap-2 rounded-lg border p-2"
                  style={{
                    borderColor: selected ? "var(--accent)" : "var(--border)",
                    background: selected
                      ? "color-mix(in oklab, var(--accent) 8%, transparent)"
                      : "var(--surface-secondary)",
                    transition:
                      "border-color var(--motion-fast) var(--motion-ease), background var(--motion-fast) var(--motion-ease)",
                  }}
                >
                  <button
                    ref={(node) => {
                      setRefs.current[option.id] = node;
                    }}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    tabIndex={selected ? 0 : -1}
                    onClick={() => choose(option.id)}
                    className="flex min-w-0 flex-1 items-start gap-3 rounded-md p-2 text-left focus-visible:outline-2 focus-visible:outline-offset-2"
                    style={{ outlineColor: "var(--focus)" }}
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
                  <Button
                    variant="ghost"
                    size="sm"
                    className="self-center"
                    aria-label={`Preview the ${option.label} sounds`}
                    onPress={() => previewSoundSet(option.id, volume)}
                  >
                    <Play size={14} />
                    Preview
                  </Button>
                </div>
              );
            })}
          </div>
          <span className="text-xs text-muted">
            Preview plays even while sounds are off, so you can choose before turning them on.
          </span>
        </div>
      </Card.Content>
    </Card>
  );
}
