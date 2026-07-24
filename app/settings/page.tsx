"use client";

import { useCallback, useEffect, useState } from "react";
import { motion } from "motion/react";
import {
  Sparkles,
  Container,
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
  Input,
  Label,
  ListBox,
  Select,
  Skeleton,
  TextField,
  toast,
} from "@heroui/react";
import ConfirmDialog from "@/app/components/ConfirmDialog";
import PageHeader from "@/app/components/PageHeader";
import { useUISound } from "@/app/hooks/useUISound";
import { useMode } from "@/app/components/ModeProvider";
import { listStagger, scaleIn } from "@/app/lib/motion";
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

export default function SettingsPage() {
  // Re-read on every render so a theme switch is picked up (docs/theme-contract.md §6).
  const containerMotion = listStagger();
  const cardMotion = scaleIn();
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
  const { play } = useUISound();
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

        {/* Mode switch */}
        <motion.section variants={cardMotion}>
          <Card className="p-6">
            <Card.Header className="flex-col items-start gap-1">
              <Card.Title>Mode</Card.Title>
              <Card.Description>
                Simple runs a managed vanilla server for you. Advanced attaches
                to an existing Podman or Docker container.
              </Card.Description>
            </Card.Header>
            <Card.Content className="mt-4 flex flex-wrap gap-3">
              <Button
                variant={isSimple ? "primary" : "secondary"}
                isDisabled={modeSwitching}
                onPress={() => handleModeChange("simple")}
                onMouseEnter={() => play("hover")}
              >
                <Sparkles size={16} />
                Simple
              </Button>
              <Button
                variant={!isSimple ? "primary" : "secondary"}
                isDisabled={modeSwitching}
                onPress={() => handleModeChange("advanced")}
                onMouseEnter={() => play("hover")}
              >
                <Container size={16} />
                Advanced
              </Button>
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
                        created {new Date(instance.createdAt).toLocaleString()}
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
