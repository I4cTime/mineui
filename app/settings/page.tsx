"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import {
  Sparkles,
  Check,
  Container,
  Download,
  Palette,
  RefreshCw,
  Save,
  Settings as SettingsIcon,
  Shield,
  Trash2,
} from "lucide-react";
import {
  Button,
  Card,
  Chip,
  ColorArea,
  ColorField,
  ColorPicker,
  ColorSlider,
  ColorSwatch,
  ColorSwatchPicker,
  Input,
  Label,
  ListBox,
  Select,
  Skeleton,
  Switch,
  TextField,
  toast,
} from "@heroui/react";
import ConfirmDialog from "@/app/components/ConfirmDialog";
import PageHeader from "@/app/components/PageHeader";
import { formatDateTime } from "@/app/lib/format";
import { useUISound } from "@/app/hooks/useUISound";
import { ACCENT_PRESETS, useAccentColor } from "@/app/hooks/useAccentColor";
import { useMode } from "@/app/components/ModeProvider";
import { usePageMotion } from "@/app/lib/motion";
import {
  deleteInstance,
  detectRuntimes,
  getSettings,
  instanceStatus,
  javaCheck,
  setSettings as saveSettingsIpc,
  IpcError,
  type AdvancedModeSettings,
  type InstanceStatus,
  type JavaCheck,
  type RuntimeKind,
  type RuntimeProbe,
  type Settings,
  type SimpleModeSettings,
} from "@/app/lib/ipc";

const numberFrom = (event: React.ChangeEvent<HTMLInputElement>) => {
  const value = event.target.valueAsNumber;
  return Number.isFinite(value) ? value : 0;
};

const MODE_OPTIONS = [
  {
    id: "simple",
    title: "Simple",
    description:
      "MineUI runs a managed vanilla server for you — pick a version on the dashboard and press start.",
    icon: Sparkles,
  },
  {
    id: "advanced",
    title: "Advanced",
    description:
      "Attach to an existing Minecraft container managed by Podman or Docker.",
    icon: Container,
  },
] as const;

type ModeId = (typeof MODE_OPTIONS)[number]["id"];

/**
 * One selectable card of the mode radio group. Custom control (not a HeroUI
 * ToggleButtonGroup) because the design is a rich card — icon tile, title,
 * description, check badge — not a segmented button. Radio semantics +
 * roving tabindex live on the group in SettingsPage.
 */
function ModeOptionCard({
  option,
  selected,
  disabled,
  onSelect,
  onHover,
  buttonRef,
}: {
  option: (typeof MODE_OPTIONS)[number];
  selected: boolean;
  disabled: boolean;
  onSelect: () => void;
  onHover: () => void;
  buttonRef: (node: HTMLButtonElement | null) => void;
}) {
  const Icon = option.icon;
  return (
    <button
      ref={buttonRef}
      type="button"
      role="radio"
      aria-checked={selected}
      tabIndex={selected ? 0 : -1}
      disabled={disabled}
      onClick={onSelect}
      onMouseEnter={onHover}
      className="relative flex items-start gap-3 rounded-lg border p-4 text-left focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
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
      <span
        aria-hidden
        className="flex size-9 shrink-0 items-center justify-center rounded-lg"
        style={{
          background: selected
            ? "color-mix(in oklab, var(--accent) 16%, transparent)"
            : "var(--segment)",
          color: selected ? "var(--accent)" : "var(--muted)",
          transition:
            "background var(--motion-fast) var(--motion-ease), color var(--motion-fast) var(--motion-ease)",
        }}
      >
        <Icon size={18} />
      </span>
      <span className="flex min-w-0 flex-col gap-1 pr-7">
        <span className="font-display text-sm text-foreground">
          {option.title}
        </span>
        <span className="text-xs leading-relaxed text-muted">
          {option.description}
        </span>
      </span>
      <span
        aria-hidden
        className="absolute top-3 right-3 flex size-4.5 items-center justify-center rounded-full"
        style={{
          background: selected ? "var(--accent)" : "transparent",
          border: selected ? "none" : "1px solid var(--border)",
          transition:
            "background var(--motion-fast) var(--motion-ease), border-color var(--motion-fast) var(--motion-ease)",
        }}
      >
        {selected && (
          <Check size={12} strokeWidth={3} style={{ color: "var(--accent-foreground)" }} />
        )}
      </span>
    </button>
  );
}

export default function SettingsPage() {
  const { containerMotion, cardMotion } = usePageMotion();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [allowlistText, setAllowlistText] = useState("");
  const [instance, setInstance] = useState<InstanceStatus | null>(null);
  const [java, setJava] = useState<JavaCheck | null>(null);
  const [javaChecking, setJavaChecking] = useState(false);
  const [runtimes, setRuntimes] = useState<RuntimeProbe | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const modeRefs = useRef<Record<ModeId, HTMLButtonElement | null>>({
    simple: null,
    advanced: null,
  });
  const { play } = useUISound();
  const { accent, setAccent } = useAccentColor();
  // What the custom ColorPicker shows: the override when set, else the
  // current theme's own accent read from the DOM. Safe to read during
  // render — this card only mounts after the IPC load effect (client-only),
  // and a reset re-runs this memo after the inline override is already
  // removed, so it picks up the theme value again.
  const pickerColor = useMemo(() => {
    if (accent !== null) return accent;
    if (typeof document === "undefined") return "#3ddc84";
    return (
      getComputedStyle(document.documentElement)
        .getPropertyValue("--accent")
        .trim() || "#3ddc84"
    );
  }, [accent]);
  // Shared app-wide mode (app/components/ModeProvider.tsx). Mode switching
  // lives here now, not in the draft/Save flow below — clicking Simple/
  // Advanced persists instantly through the same path the navbar toggle
  // uses, so this section and the navbar always agree.
  const {
    mode,
    switching: modeSwitching,
    setMode: setSharedMode,
    refresh: refreshMode,
  } = useMode();

  const recheckJava = useCallback(() => {
    setJavaChecking(true);
    javaCheck()
      .then(setJava)
      .catch(() => setJava(null))
      .finally(() => setJavaChecking(false));
  }, []);

  const loadAll = useCallback(async () => {
    try {
      const settings = await getSettings();
      setDraft(settings);
      setAllowlistText(settings.rconAllowlist.join(", "));
      setLoadError(null);
      // Best-effort environment probes; failures just hide the hints.
      instanceStatus().then(setInstance).catch(() => setInstance(null));
      javaCheck().then(setJava).catch(() => setJava(null));
      detectRuntimes().then(setRuntimes).catch(() => setRuntimes(null));
    } catch (error) {
      setLoadError(error instanceof IpcError ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- IPC fetch-on-mount: the loader flips its loading flag synchronously by design
    loadAll();
  }, [loadAll]);

  const updateSimple = (patch: Partial<SimpleModeSettings>) =>
    setDraft((prev) =>
      prev ? { ...prev, simple: { ...prev.simple, ...patch } } : prev,
    );

  const updateAdvanced = (patch: Partial<AdvancedModeSettings>) =>
    setDraft((prev) =>
      prev ? { ...prev, advanced: { ...prev.advanced, ...patch } } : prev,
    );

  const handleModeChange = (nextMode: "simple" | "advanced") => {
    if (nextMode === mode) return;
    play(nextMode === "advanced" ? "toggle_on" : "toggle_off");
    setSharedMode(nextMode);
  };

  const saveSettings = async () => {
    if (!draft) return;
    setSaving(true);
    play("click_confirm");
    try {
      const normalized = await saveSettingsIpc({
        ...draft,
        // The mode buttons below persist through ModeProvider the instant
        // they're pressed, not through this draft — draft.activeMode can be
        // stale (loaded before a navbar toggle happened elsewhere). Always
        // send the provider's current mode so Save can't stomp that toggle.
        activeMode: mode,
        rconAllowlist: allowlistText
          .split(",")
          .map((item) => item.trim().toLowerCase())
          .filter(Boolean),
      });
      setDraft(normalized);
      setAllowlistText(normalized.rconAllowlist.join(", "));
      // Re-sync ModeProvider in case the backend normalized activeMode to
      // something other than what we sent.
      await refreshMode();
      play("success");
      toast.success("Settings saved");
    } catch (error) {
      play("error");
      toast.danger(error instanceof IpcError ? error.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteInstance = async () => {
    setDeleting(true);
    try {
      await deleteInstance();
      play("success");
      toast.success("Instance deleted");
      setInstance(await instanceStatus().catch(() => null));
      setDraft(await getSettings());
      await refreshMode();
    } catch (error) {
      play("error");
      toast.danger(
        error instanceof IpcError ? error.message : "Delete failed",
      );
    } finally {
      setDeleting(false);
      setDeleteOpen(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-background">
        <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 px-4 py-10 md:px-6">
          <div className="h-16" />
          <Card className="p-6">
            <Card.Header className="flex-col items-start gap-2">
              <Skeleton className="h-5 w-40 rounded" />
              <Skeleton className="h-4 w-64 rounded" />
            </Card.Header>
            <Card.Content className="grid gap-4 md:grid-cols-2">
              {Array.from({ length: 6 }).map((_, index) => (
                <div key={index} className="space-y-2">
                  <Skeleton className="h-3 w-24 rounded" />
                  <Skeleton className="h-10 w-full rounded-lg" />
                </div>
              ))}
            </Card.Content>
            <Card.Footer className="justify-end">
              <Skeleton className="h-10 w-36 rounded-lg" />
            </Card.Footer>
          </Card>
        </main>
      </div>
    );
  }

  if (loadError !== null || draft === null) {
    return (
      <div className="min-h-screen bg-background">
        <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-6 px-4 py-10 md:px-6">
          <Card className="p-6">
            <Card.Header className="flex items-center gap-3 text-sm text-accent">
              <SettingsIcon size={18} />
              <span className="font-pixel text-xs tracking-wide">
                Settings unavailable
              </span>
            </Card.Header>
            <Card.Content className="mt-4 grid gap-3 text-sm text-muted">
              <p>{loadError ?? "Settings could not be loaded."}</p>
              <p>
                Launch MineUI with{" "}
                <code className="font-mono">pnpm tauri dev</code> or the
                packaged app — the web preview has no backend.
              </p>
            </Card.Content>
            <Card.Footer className="mt-4">
              <Button onPress={() => loadAll()}>Retry</Button>
            </Card.Footer>
          </Card>
        </main>
      </div>
    );
  }

  const isSimple = mode === "simple";

  return (
    <div
      className="min-h-screen"
      style={{
        background: `radial-gradient(circle at top, color-mix(in oklab, var(--accent) 18%, transparent), transparent 60%), var(--background)`,
      }}
    >
      <motion.main
        className="page-main mx-auto flex max-w-5xl flex-col gap-6 px-4 py-10 md:px-6"
        initial="hidden"
        animate="show"
        variants={containerMotion}
      >
        <PageHeader title="Settings" icon={SettingsIcon} />

        {/* Mode switch — a radio group of rich option cards. Roving
            tabindex: only the selected card is tabbable; arrow keys move
            selection (two options, so every arrow just flips to the other). */}
        <motion.section variants={cardMotion}>
          <Card className="p-6">
            <Card.Header className="flex-col items-start gap-1">
              <Card.Title>Mode</Card.Title>
              <Card.Description>
                How MineUI runs your server. Switching applies immediately.
              </Card.Description>
            </Card.Header>
            <Card.Content
              role="radiogroup"
              aria-label="App mode"
              className="mt-4 grid gap-3 sm:grid-cols-2"
              onKeyDown={(event: React.KeyboardEvent) => {
                if (
                  !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(
                    event.key,
                  )
                )
                  return;
                event.preventDefault();
                const next: ModeId = isSimple ? "advanced" : "simple";
                handleModeChange(next);
                modeRefs.current[next]?.focus();
              }}
            >
              {MODE_OPTIONS.map((option) => (
                <ModeOptionCard
                  key={option.id}
                  option={option}
                  selected={mode === option.id}
                  disabled={modeSwitching}
                  onSelect={() => handleModeChange(option.id)}
                  onHover={() => play("hover")}
                  buttonRef={(node) => {
                    modeRefs.current[option.id] = node;
                  }}
                />
              ))}
            </Card.Content>
          </Card>
        </motion.section>

        {/* Simple mode section — mounts on mode toggle after the parent's
            stagger has finished, so it must drive its own enter animation. */}
        {isSimple && (
          <motion.section variants={cardMotion} initial="hidden" animate="show">
            <Card className="p-6">
              <Card.Header className="flex-col items-start gap-1">
                <Card.Title>Simple mode</Card.Title>
                <Card.Description>
                  Managed vanilla server. The version is chosen when the
                  instance is created on the dashboard.
                </Card.Description>
              </Card.Header>
              <Card.Content className="mt-4 grid gap-4 md:grid-cols-2">
                <div className="flex flex-col gap-2 text-sm">
                  <span className="text-xs uppercase tracking-[0.2em] text-muted">
                    Instance
                  </span>
                  <div className="flex flex-wrap items-center gap-2">
                    <Chip
                      variant="soft"
                      color={instance?.exists ? "success" : "default"}
                    >
                      {instance?.exists
                        ? `Minecraft ${instance.mcVersion ?? "?"}`
                        : "No instance yet"}
                    </Chip>
                    {instance?.exists && instance.createdAt && (
                      <span className="text-xs text-muted">
                        created {formatDateTime(instance.createdAt)}
                      </span>
                    )}
                  </div>
                  <span className="truncate text-xs text-muted">
                    {draft.simple.instanceDir}
                  </span>
                  {java && (
                    <div className="flex flex-wrap items-center gap-2">
                      <Chip
                        variant="soft"
                        color={
                          java.found
                            ? java.compatible === false
                              ? "warning"
                              : "success"
                            : "warning"
                        }
                        className="w-fit"
                      >
                        {java.found
                          ? `Java ${java.version ?? "?"}${
                              java.requiredMajor !== null
                                ? ` (needs ${java.requiredMajor}+)`
                                : ""
                            }`
                          : "Java not found"}
                      </Chip>
                      <Button
                        variant="ghost"
                        size="sm"
                        isDisabled={javaChecking}
                        onPress={() => {
                          play("click_confirm");
                          recheckJava();
                        }}
                      >
                        <RefreshCw
                          size={13}
                          className={javaChecking ? "animate-spin" : undefined}
                        />
                        Re-check
                      </Button>
                    </div>
                  )}
                </div>

                <TextField className="flex flex-col gap-2">
                  <Label>Java path override</Label>
                  <Input
                    fullWidth
                    placeholder="Leave empty to auto-detect"
                    value={draft.simple.javaPath ?? ""}
                    onChange={(event) =>
                      updateSimple({ javaPath: event.target.value || null })
                    }
                    onFocus={() => play("hover")}
                  />
                </TextField>

                <TextField className="flex flex-col gap-2" type="number">
                  <Label>Memory (MB)</Label>
                  <Input
                    fullWidth
                    type="number"
                    min={512}
                    step={512}
                    value={String(draft.simple.memoryMb)}
                    onChange={(event) =>
                      updateSimple({ memoryMb: numberFrom(event) })
                    }
                    onFocus={() => play("hover")}
                  />
                </TextField>

                <TextField className="flex flex-col gap-2" type="number">
                  <Label>Server port</Label>
                  <Input
                    fullWidth
                    type="number"
                    min={1}
                    max={65535}
                    value={String(draft.simple.serverPort)}
                    onChange={(event) =>
                      updateSimple({ serverPort: numberFrom(event) })
                    }
                    onFocus={() => play("hover")}
                  />
                </TextField>

                <TextField className="flex flex-col gap-2" type="number">
                  <Label>RCON port</Label>
                  <Input
                    fullWidth
                    type="number"
                    min={1}
                    max={65535}
                    value={String(draft.simple.rconPort)}
                    onChange={(event) =>
                      updateSimple({ rconPort: numberFrom(event) })
                    }
                    onFocus={() => play("hover")}
                  />
                </TextField>
              </Card.Content>
              {instance?.exists && (
                <Card.Footer className="mt-4 flex items-center justify-between gap-3 border-t border-border pt-4">
                  <span className="text-xs text-muted">
                    Deleting the instance removes the world, configs, and
                    server jar from disk.
                  </span>
                  <Button
                    variant="danger"
                    onPress={() => {
                      play("click_confirm");
                      setDeleteOpen(true);
                    }}
                    onMouseEnter={() => play("hover")}
                  >
                    <Trash2 size={16} />
                    Delete instance
                  </Button>
                </Card.Footer>
              )}
            </Card>
          </motion.section>
        )}

        {/* Advanced mode section — same late-mount rule as Simple above. */}
        {!isSimple && (
          <motion.section variants={cardMotion} initial="hidden" animate="show">
            <Card className="p-6">
              <Card.Header className="flex-col items-start gap-1">
                <Card.Title>Advanced mode</Card.Title>
                <Card.Description>
                  Attach to an existing Minecraft container managed by Podman or
                  Docker.
                </Card.Description>
              </Card.Header>
              <Card.Content className="mt-4 grid gap-4 md:grid-cols-2">
                <div className="flex flex-col gap-2">
                  <Label>Container runtime</Label>
                  <Select
                    className="w-full text-sm"
                    placeholder="Runtime"
                    value={draft.advanced.runtime}
                    onChange={(value) => {
                      if (value === null) return;
                      updateAdvanced({ runtime: value as RuntimeKind });
                    }}
                  >
                    <Label className="sr-only">Container runtime</Label>
                    <Select.Trigger onMouseEnter={() => play("hover")}>
                      <Select.Value />
                      <Select.Indicator />
                    </Select.Trigger>
                    <Select.Popover>
                      <ListBox>
                        <ListBox.Item id="auto">Auto (Podman, then Docker)</ListBox.Item>
                        <ListBox.Item id="podman">Podman</ListBox.Item>
                        <ListBox.Item id="docker">Docker</ListBox.Item>
                      </ListBox>
                    </Select.Popover>
                  </Select>
                  {runtimes && (
                    <div className="flex flex-wrap gap-2 text-xs">
                      <Chip
                        variant="soft"
                        color={runtimes.podman ? "success" : "default"}
                        size="sm"
                      >
                        {runtimes.podman
                          ? `Podman ${runtimes.podman.version}`
                          : "Podman not found"}
                      </Chip>
                      <Chip
                        variant="soft"
                        color={runtimes.docker ? "success" : "default"}
                        size="sm"
                      >
                        {runtimes.docker
                          ? `Docker ${runtimes.docker.version}`
                          : "Docker not found"}
                      </Chip>
                    </div>
                  )}
                </div>

                <TextField className="flex flex-col gap-2">
                  <Label>Container name</Label>
                  <Input
                    fullWidth
                    placeholder="minecraft-server"
                    value={draft.advanced.containerName}
                    onChange={(event) =>
                      updateAdvanced({ containerName: event.target.value })
                    }
                    onFocus={() => play("hover")}
                  />
                </TextField>

                <TextField className="flex flex-col gap-2">
                  <Label>Runtime binary override</Label>
                  <Input
                    fullWidth
                    placeholder="Leave empty for PATH lookup"
                    value={draft.advanced.runtimeBinary ?? ""}
                    onChange={(event) =>
                      updateAdvanced({
                        runtimeBinary: event.target.value || null,
                      })
                    }
                    onFocus={() => play("hover")}
                  />
                </TextField>

                <TextField className="flex flex-col gap-2">
                  <Label>Socket path override</Label>
                  <Input
                    fullWidth
                    placeholder="/run/user/1000/podman/podman.sock"
                    value={draft.advanced.socketPath ?? ""}
                    onChange={(event) =>
                      updateAdvanced({ socketPath: event.target.value || null })
                    }
                    onFocus={() => play("hover")}
                  />
                </TextField>

                <TextField className="flex flex-col gap-2">
                  <Label>Query host</Label>
                  <Input
                    fullWidth
                    placeholder="127.0.0.1"
                    value={draft.advanced.queryHost}
                    onChange={(event) =>
                      updateAdvanced({ queryHost: event.target.value })
                    }
                    onFocus={() => play("hover")}
                  />
                </TextField>

                <TextField className="flex flex-col gap-2" type="number">
                  <Label>Query port</Label>
                  <Input
                    fullWidth
                    type="number"
                    min={1}
                    max={65535}
                    value={String(draft.advanced.queryPort)}
                    onChange={(event) =>
                      updateAdvanced({ queryPort: numberFrom(event) })
                    }
                    onFocus={() => play("hover")}
                  />
                </TextField>

                <TextField className="flex flex-col gap-2">
                  <Label>RCON host</Label>
                  <Input
                    fullWidth
                    placeholder="127.0.0.1"
                    value={draft.advanced.rconHost}
                    onChange={(event) =>
                      updateAdvanced({ rconHost: event.target.value })
                    }
                    onFocus={() => play("hover")}
                  />
                </TextField>

                <TextField className="flex flex-col gap-2" type="number">
                  <Label>RCON port</Label>
                  <Input
                    fullWidth
                    type="number"
                    min={1}
                    max={65535}
                    value={String(draft.advanced.rconPort)}
                    onChange={(event) =>
                      updateAdvanced({ rconPort: numberFrom(event) })
                    }
                    onFocus={() => play("hover")}
                  />
                </TextField>

                <TextField className="flex flex-col gap-2" type="password">
                  <Label>RCON password</Label>
                  <Input
                    fullWidth
                    type="password"
                    placeholder="change-me"
                    value={draft.advanced.rconPassword}
                    onChange={(event) =>
                      updateAdvanced({ rconPassword: event.target.value })
                    }
                    onFocus={() => play("hover")}
                  />
                </TextField>

                <TextField className="flex flex-col gap-2">
                  <Label>World directory</Label>
                  <Input
                    fullWidth
                    placeholder="world"
                    value={draft.advanced.worldDir}
                    onChange={(event) =>
                      updateAdvanced({ worldDir: event.target.value })
                    }
                    onFocus={() => play("hover")}
                  />
                </TextField>

                <TextField className="flex flex-col gap-2">
                  <Label>Server utils URL</Label>
                  <Input
                    fullWidth
                    placeholder="http://127.0.0.1:8787 (empty = disabled)"
                    value={draft.advanced.serverUtilsUrl ?? ""}
                    onChange={(event) =>
                      updateAdvanced({
                        serverUtilsUrl: event.target.value || null,
                      })
                    }
                    onFocus={() => play("hover")}
                  />
                </TextField>
              </Card.Content>
            </Card>
          </motion.section>
        )}

        {/* Shared: appearance — user accent override. The swatch fills are
            user-pickable data values (see ACCENT_PRESETS), not UI styling;
            the surrounding chrome stays on theme tokens. */}
        <motion.section variants={cardMotion}>
          <Card className="p-6">
            <Card.Header className="flex-col items-start gap-1">
              <div className="flex items-center gap-2">
                <Palette size={16} className="text-accent" />
                <Card.Title>Accent color</Card.Title>
              </div>
              <Card.Description>
                Override the theme&apos;s accent everywhere in the app. Themes
                themselves are picked from the navbar.
              </Card.Description>
            </Card.Header>
            <Card.Content className="mt-4 flex flex-col items-start gap-4">
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
        </motion.section>

        {/* Shared: download security */}
        <motion.section variants={cardMotion}>
          <Card className="p-6">
            <Card.Header className="flex-col items-start gap-1">
              <div className="flex items-center gap-2">
                <Download size={16} className="text-accent" />
                <Card.Title>Downloads</Card.Title>
              </div>
              <Card.Description>
                Mod downloads refuse loopback and private-network hosts by
                default (SSRF protection). Enable this only if you download
                mods from a LAN or localhost server.
              </Card.Description>
            </Card.Header>
            <Card.Content className="mt-4">
              <Switch
                isSelected={draft.allowPrivateDownloadHosts}
                onChange={(selected: boolean) => {
                  play(selected ? "toggle_on" : "toggle_off");
                  setDraft((prev) =>
                    prev
                      ? { ...prev, allowPrivateDownloadHosts: selected }
                      : prev,
                  );
                }}
              >
                <Switch.Content>
                  <Switch.Control>
                    <Switch.Thumb />
                  </Switch.Control>
                  <Label>Allow private download hosts</Label>
                </Switch.Content>
              </Switch>
            </Card.Content>
          </Card>
        </motion.section>

        {/* Shared: RCON allowlist + save */}
        <motion.section variants={cardMotion}>
          <Card className="p-6">
            <Card.Header className="flex-col items-start gap-1">
              <div className="flex items-center gap-2">
                <Shield size={16} className="text-accent" />
                <Card.Title>RCON allowlist</Card.Title>
              </div>
              <Card.Description>
                Comma-separated commands permitted through the RCON panel.
              </Card.Description>
            </Card.Header>
            <Card.Content className="mt-4">
              <TextField className="flex flex-col gap-2">
                <Label className="sr-only">RCON allowlist</Label>
                <Input
                  fullWidth
                  placeholder="list, whitelist, op, deop, ban, pardon"
                  value={allowlistText}
                  onChange={(event) => setAllowlistText(event.target.value)}
                  onFocus={() => play("hover")}
                />
              </TextField>
            </Card.Content>
            <Card.Footer className="mt-4 justify-end">
              <Button
                onPress={saveSettings}
                isDisabled={saving}
                isPending={saving}
                onMouseEnter={() => play("hover")}
              >
                <Save size={16} />
                {saving ? "Saving..." : "Save settings"}
              </Button>
            </Card.Footer>
          </Card>
        </motion.section>

        <ConfirmDialog
          isOpen={deleteOpen}
          title="Delete instance?"
          description={`This permanently removes ${draft.simple.instanceDir} including the world. The server must be stopped.`}
          confirmLabel="Delete instance"
          cancelLabel="Cancel"
          variant="danger"
          isLoading={deleting}
          onCancel={() => setDeleteOpen(false)}
          onConfirm={handleDeleteInstance}
        />
      </motion.main>
    </div>
  );
}
