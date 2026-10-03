"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { motion } from "motion/react";
import {
  Sparkles,
  Archive,
  Check,
  ChevronDown,
  Clock,
  Container,
  Eye,
  EyeOff,
  Gauge,
  Play,
  Plus,
  RefreshCw,
  Save,
  Settings as SettingsIcon,
  Server,
  SlidersHorizontal,
  Trash2,
  TriangleAlert,
  Undo2,
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
  Switch,
  TextField,
  toast,
} from "@heroui/react";
import ConfirmDialog from "@/app/components/ConfirmDialog";
import DeleteContainerButton from "@/app/components/DeleteContainerButton";
import PageHeader from "@/app/components/PageHeader";
import RuntimeInstallHelp from "@/app/components/RuntimeInstallHelp";
import { formatDateTime } from "@/app/lib/format";
import { useUISound } from "@/app/hooks/useUISound";
import { useMode } from "@/app/components/ModeProvider";
import { identityLine, phaseText, useServers } from "@/app/components/ServerProvider";
import { setLeaveGuard } from "@/app/lib/leaveGuard";
import { usePageMotion } from "@/app/lib/motion";
import {
  deleteInstance,
  detectRuntimes,
  getSchedulerStatus,
  getSettings,
  instanceStatus,
  javaCheck,
  runScheduledJobNow,
  setSettings as saveSettingsIpc,
  isTauri,
  IpcError,
  type AdvancedModeSettings,
  type BackupSettings,
  type InstanceStatus,
  type JavaCheck,
  type RuntimeKind,
  type RuntimeProbe,
  type Schedule,
  type ScheduledJob,
  type ScheduledJobKind,
  type SchedulerStatus,
  type Settings,
  type SimpleModeSettings,
  type Weekday,
} from "@/app/lib/ipc";

// Same list as the backend's DEFAULT_RCON_ALLOWLIST (settings.rs).
const DEFAULT_ALLOWLIST =
  "list, whitelist, op, deop, ban, pardon, banlist, kick, say, save-all, stop, tps";

const parseAllowlist = (text: string) =>
  text
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

/** What "unchanged" means: everything Save sends, minus the mode (which is
 *  not part of the draft — it has its own guarded switch). */
const snapshotOf = (settings: Settings, allowlistText: string) =>
  JSON.stringify({ ...settings, activeMode: null, rconAllowlist: parseAllowlist(allowlistText) });

const validPort = (value: number) => Number.isInteger(value) && value >= 1 && value <= 65535;

/** Everything the backend would reject, in the user's words, before Save. */
function problemsIn(draft: Settings, isSimple: boolean): string[] {
  const problems: string[] = [];
  if (isSimple) {
    if (!(draft.simple.memoryMb >= 512)) problems.push("Memory must be at least 512 MB.");
    if (!validPort(draft.simple.serverPort)) problems.push("Server port must be 1–65535.");
    if (!validPort(draft.simple.rconPort)) problems.push("RCON port must be 1–65535.");
    if (draft.simple.serverPort === draft.simple.rconPort)
      problems.push("The server port and the RCON port must differ.");
  } else {
    if (draft.advanced.containerName.trim() === "") problems.push("Container name cannot be empty.");
    if (!validPort(draft.advanced.queryPort)) problems.push("Query port must be 1–65535.");
    if (!validPort(draft.advanced.rconPort)) problems.push("RCON port must be 1–65535.");
  }
  for (const job of draft.scheduler.jobs) {
    if (job.schedule.kind === "interval" && !(job.schedule.everyHours >= 1 && job.schedule.everyHours <= 168))
      problems.push("A scheduled task's interval must be 1–168 hours.");
    if (job.kind === "broadcast" && !(job.message && job.message.trim()))
      problems.push("A broadcast task needs a message.");
  }
  if (!(draft.backups.keepLast >= 0 && draft.backups.keepLast <= 1000))
    problems.push("Backups to keep must be 0–1000.");
  return [...new Set(problems)];
}

const numberFrom = (event: React.ChangeEvent<HTMLInputElement>) => {
  const value = event.target.valueAsNumber;
  return Number.isFinite(value) ? value : 0;
};

const JOB_KINDS: { id: ScheduledJobKind; label: string; hint: string }[] = [
  { id: "backup", label: "Backup", hint: "Back up the world (the Backups settings below apply)." },
  { id: "restart", label: "Restart", hint: "Restart the server; an optional warning is sent 60 s before." },
  { id: "broadcast", label: "Broadcast", hint: "Send a chat message to everyone online." },
];

const WEEKDAYS: { id: Weekday; label: string }[] = [
  { id: "monday", label: "Monday" },
  { id: "tuesday", label: "Tuesday" },
  { id: "wednesday", label: "Wednesday" },
  { id: "thursday", label: "Thursday" },
  { id: "friday", label: "Friday" },
  { id: "saturday", label: "Saturday" },
  { id: "sunday", label: "Sunday" },
];

const newJobId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const defaultSchedule = (kind: Schedule["kind"]): Schedule => {
  switch (kind) {
    case "interval":
      return { kind: "interval", everyHours: 6 };
    case "weekly":
      return { kind: "weekly", weekday: "sunday", time: "04:00" };
    default:
      return { kind: "daily", time: "04:00" };
  }
};

const describeSchedule = (schedule: Schedule): string => {
  switch (schedule.kind) {
    case "interval":
      return schedule.everyHours === 1 ? "Every hour" : `Every ${schedule.everyHours} hours`;
    case "daily":
      return `Daily at ${schedule.time}`;
    case "weekly": {
      const day = WEEKDAYS.find((w) => w.id === schedule.weekday)?.label ?? schedule.weekday;
      return `${day}s at ${schedule.time}`;
    }
  }
};

const MODE_OPTIONS = [
  {
    id: "simple",
    title: "Simple",
    description:
      "MineUI downloads and runs a plain (vanilla) Minecraft server on this computer. Nothing else to install.",
    icon: Sparkles,
  },
  {
    id: "advanced",
    title: "Advanced",
    description:
      "Runs in a container (Podman or Docker). MineUI can create it for you — with Fabric, Forge, Paper or a modpack — or use one you already have.",
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
  const [schedulerStatus, setSchedulerStatus] = useState<SchedulerStatus | null>(null);
  const [runningJob, setRunningJob] = useState<string | null>(null);
  // What is saved (snapshotOf); the draft is "dirty" when it differs.
  const [baseline, setBaseline] = useState<string | null>(null);
  const [savedSettings, setSavedSettings] = useState<Settings | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [containerUnlocked, setContainerUnlocked] = useState(false);
  const [showRconPassword, setShowRconPassword] = useState(false);
  const [pendingMode, setPendingMode] = useState<ModeId | null>(null);
  const [confirmRunJob, setConfirmRunJob] = useState<string | null>(null);
  const [deleteTyped, setDeleteTyped] = useState("");
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null);
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);
  const { active, activeId, overview, rename, refreshOverview } = useServers();
  const entry = overview.find((item) => item.id === activeId);
  const phase = entry?.phase ?? null;
  const serverBusy = phase === "running" || phase === "starting" || phase === "stopping";
  const modeRefs = useRef<Record<ModeId, HTMLButtonElement | null>>({
    simple: null,
    advanced: null,
  });
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

  const refreshSchedulerStatus = useCallback(() => {
    getSchedulerStatus()
      .then(setSchedulerStatus)
      .catch(() => setSchedulerStatus(null));
  }, []);

  const loadAll = useCallback(async () => {
    try {
      const settings = await getSettings();
      setDraft(settings);
      setAllowlistText(settings.rconAllowlist.join(", "));
      setSavedSettings(settings);
      setBaseline(snapshotOf(settings, settings.rconAllowlist.join(", ")));
      setLoadError(null);
      refreshSchedulerStatus();
      // Best-effort environment probes; failures just hide the hints.
      instanceStatus().then(setInstance).catch(() => setInstance(null));
      javaCheck().then(setJava).catch(() => setJava(null));
      detectRuntimes().then(setRuntimes).catch(() => setRuntimes(null));
    } catch (error) {
      setLoadError(error instanceof IpcError ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [refreshSchedulerStatus]);

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

  const updateBackups = (patch: Partial<BackupSettings>) =>
    setDraft((prev) =>
      prev ? { ...prev, backups: { ...prev.backups, ...patch } } : prev,
    );

  const updateJobs = (mutate: (jobs: ScheduledJob[]) => ScheduledJob[]) =>
    setDraft((prev) =>
      prev
        ? { ...prev, scheduler: { ...prev.scheduler, jobs: mutate(prev.scheduler.jobs) } }
        : prev,
    );

  const updateJob = (id: string, patch: Partial<ScheduledJob>) =>
    updateJobs((jobs) => jobs.map((job) => (job.id === id ? { ...job, ...patch } : job)));

  const addJob = () => {
    play("click_confirm");
    updateJobs((jobs) => [
      ...jobs,
      {
        id: newJobId(),
        kind: "backup",
        enabled: true,
        schedule: defaultSchedule("daily"),
        message: null,
      },
    ]);
  };

  const removeJob = (id: string) => {
    play("click_confirm");
    updateJobs((jobs) => jobs.filter((job) => job.id !== id));
  };

  const runJobNow = async (id: string) => {
    setRunningJob(id);
    play("click_confirm");
    try {
      const result = await runScheduledJobNow(id);
      if (result.ok) {
        play("success");
        toast.success(result.message ? `Job ran: ${result.message}` : "Job ran");
      } else {
        play("error");
        toast.danger(result.message ?? "Job did not run");
      }
    } catch (error) {
      play("error");
      toast.danger(error instanceof IpcError ? error.message : "Job failed");
    } finally {
      setRunningJob(null);
      refreshSchedulerStatus();
    }
  };

  // Changing how the server is run re-points MineUI at a different server
  // for this entry — never a one-click affair (UX review: it looked like the
  // server had been deleted), and never while it is running.
  const requestModeChange = (nextMode: ModeId) => {
    if (nextMode === mode || modeSwitching) return;
    if (serverBusy) {
      play("error");
      toast.warning(`Stop ${active.name} first — it cannot change type while it is running.`);
      return;
    }
    play("click_confirm");
    setPendingMode(nextMode);
  };
  const confirmModeChange = () => {
    const next = pendingMode;
    setPendingMode(null);
    if (!next) return;
    play(next === "advanced" ? "toggle_on" : "toggle_off");
    void setSharedMode(next).then(() => refreshOverview());
  };

  const isSimpleNow = mode === "simple";
  const dirty =
    draft !== null && baseline !== null && snapshotOf(draft, allowlistText) !== baseline;
  const problems = useMemo(
    () => (draft ? problemsIn(draft, isSimpleNow) : []),
    [draft, isSimpleNow],
  );

  // Leaving with unsaved edits asks first (header nav + server switch).
  useEffect(() => {
    if (!dirty) {
      setLeaveGuard(null);
      return;
    }
    setLeaveGuard((proceed) => setPendingLeave(() => proceed));
    return () => setLeaveGuard(null);
  }, [dirty]);

  const discardChanges = () => {
    if (!savedSettings) return;
    play("click_back");
    setDraft(savedSettings);
    setAllowlistText(savedSettings.rconAllowlist.join(", "));
    setContainerUnlocked(false);
  };

  const submitRename = async () => {
    const next = (nameDraft ?? "").trim();
    if (!next || next === active.name) return;
    setRenaming(true);
    try {
      await rename(activeId, next);
      play("success");
      toast.success(`Renamed to ${next}`);
      setNameDraft(null);
    } catch (error) {
      play("error");
      toast.danger(error instanceof IpcError ? error.message : "Rename failed");
    } finally {
      setRenaming(false);
    }
  };

  const saveSettings = async () => {
    if (!draft || problems.length > 0) return;
    const wasRunning = phase === "running";
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
        rconAllowlist: parseAllowlist(allowlistText),
      });
      setDraft(normalized);
      setAllowlistText(normalized.rconAllowlist.join(", "));
      setSavedSettings(normalized);
      setBaseline(snapshotOf(normalized, normalized.rconAllowlist.join(", ")));
      setContainerUnlocked(false);
      refreshSchedulerStatus();
      // Re-sync ModeProvider in case the backend normalized activeMode to
      // something other than what we sent.
      await refreshMode();
      play("success");
      toast.success(
        wasRunning
          ? "Settings saved. Memory, ports and connection changes apply the next time the server starts."
          : "Settings saved",
      );
      void refreshOverview();
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
      toast.success("Server files deleted");
      setInstance(await instanceStatus().catch(() => null));
      const fresh = await getSettings();
      setDraft(fresh);
      setSavedSettings(fresh);
      setAllowlistText(fresh.rconAllowlist.join(", "));
      setBaseline(snapshotOf(fresh, fresh.rconAllowlist.join(", ")));
      void refreshOverview();
      await refreshMode();
    } catch (error) {
      play("error");
      toast.danger(
        error instanceof IpcError ? error.message : "Delete failed",
      );
    } finally {
      setDeleting(false);
      setDeleteOpen(false);
      setDeleteTyped("");
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
              {!isTauri() && (
                <p>
                  Launch MineUI with{" "}
                  <code className="font-mono">pnpm tauri dev</code> or the
                  packaged app — the web preview has no backend.
                </p>
              )}
            </Card.Content>
            <Card.Footer className="mt-4">
              <Button onPress={() => loadAll()}>Retry</Button>
            </Card.Footer>
          </Card>
        </main>
      </div>
    );
  }

  const isSimple = isSimpleNow;
  const detail = identityLine(entry);
  const nameValue = nameDraft ?? active.name;
  const jobToConfirm = draft.scheduler.jobs.find((job) => job.id === confirmRunJob);

  return (
    <div
      className="min-h-screen"
      style={{
        background: `radial-gradient(circle at top, var(--page-wash), transparent 60%), var(--background)`,
      }}
    >
      <motion.main
        className="page-main mx-auto flex max-w-5xl flex-col gap-6 px-4 pt-5 pb-10 md:px-6"
        initial="hidden"
        animate="show"
        variants={containerMotion}
      >
        <PageHeader title="Server Settings" icon={SettingsIcon} />

        {!isSimple && runtimes && runtimes.resolved === null && (
          <motion.section variants={cardMotion}>
            <RuntimeInstallHelp
              onRecheck={() => detectRuntimes().then(setRuntimes).catch(() => setRuntimes(null))}
            />
          </motion.section>
        )}

        {/* 1. This server: what it is, by name. */}
        <motion.section variants={cardMotion}>
          <Card className="p-6">
            <Card.Header className="flex-col items-start gap-1">
              <div className="flex items-center gap-2">
                <Server size={16} className="text-accent" />
                <Card.Title>This server</Card.Title>
              </div>
              <Card.Description>
                {isSimple
                  ? "A plain Minecraft server that MineUI runs on this computer."
                  : "A server in a container (Podman or Docker) that MineUI controls."}
              </Card.Description>
            </Card.Header>
            <Card.Content className="mt-4 grid gap-4 md:grid-cols-2">
              <TextField className="flex flex-col gap-2">
                <Label>Name</Label>
                <div className="flex gap-2">
                  <Input
                    fullWidth
                    maxLength={40}
                    value={nameValue}
                    onChange={(event) => setNameDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void submitRename();
                      if (event.key === "Escape") setNameDraft(null);
                    }}
                    onFocus={() => play("hover")}
                  />
                  {nameDraft !== null && nameDraft.trim() !== "" && nameDraft.trim() !== active.name && (
                    <Button onPress={submitRename} isDisabled={renaming} isPending={renaming}>
                      Rename
                    </Button>
                  )}
                </div>
                <span className="text-xs text-muted">
                  Only how MineUI shows it. Applies at once; nothing on the server changes.
                </span>
              </TextField>

              {isSimple ? (
                <div className="flex flex-col gap-2 text-sm">
                  <span className="text-xs uppercase tracking-[0.2em] text-muted">
                    Server files
                  </span>
                  <div className="flex flex-wrap items-center gap-2">
                    <Chip
                      variant="soft"
                      color={instance?.exists ? "success" : "default"}
                    >
                      {instance?.exists
                        ? `Minecraft ${instance.mcVersion ?? "?"}`
                        : "Not set up yet"}
                    </Chip>
                    {instance?.exists && instance.createdAt && (
                      <span className="text-xs text-muted">
                        created {formatDateTime(instance.createdAt)}
                      </span>
                    )}
                  </div>
                  <span className="text-xs text-muted">
                    Server folder:{" "}
                    <span className="break-all font-mono">{draft.simple.instanceDir}</span>
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
              ) : (
                <div className="flex flex-col gap-2 text-sm">
                  <span className="text-xs uppercase tracking-[0.2em] text-muted">Container</span>
                  <div className="flex flex-wrap items-center gap-2">
                    <Chip variant="soft" color={phase === "running" ? "success" : "default"}>
                      {phaseText(phase)}
                    </Chip>
                    <span className="break-all font-mono text-xs text-muted">
                      {detail || draft.advanced.containerName}
                    </span>
                  </div>
                  <span className="text-xs text-muted">
                    The server type, Minecraft version and memory were set when the
                    container was created. To change them, use <em>Delete container</em>{" "}
                    below — the world is kept — and create it again.
                  </span>
                </div>
              )}
            </Card.Content>
          </Card>
        </motion.section>

        {/* 2. Performance & network — Simple only (a container's are fixed
            at creation, see the note above). */}
        {isSimple && (
          <motion.section variants={cardMotion} initial="hidden" animate="show">
            <Card className="p-6">
              <Card.Header className="flex-col items-start gap-1">
                <div className="flex items-center gap-2">
                  <Gauge size={16} className="text-accent" />
                  <Card.Title>Performance &amp; network</Card.Title>
                </div>
                <Card.Description>
                  Both apply the next time the server starts.
                  {instance?.exists
                    ? " The Minecraft version is fixed for these server files; to change it, make a backup, delete the server files below, set the server up again and restore the backup."
                    : ""}
                </Card.Description>
              </Card.Header>
              <Card.Content className="mt-4 grid gap-4 md:grid-cols-2">
                <TextField className="flex flex-col gap-2" type="number">
                  <Label>Memory (MB)</Label>
                  <Input
                    fullWidth
                    type="number"
                    min={512}
                    step={512}
                    value={String(draft.simple.memoryMb)}
                    onChange={(event) => updateSimple({ memoryMb: numberFrom(event) })}
                    onFocus={() => play("hover")}
                  />
                  <span className="text-xs text-muted">
                    How much RAM the server may use. 2048–4096 suits most small servers.
                  </span>
                </TextField>

                <TextField className="flex flex-col gap-2" type="number">
                  <Label>Server port</Label>
                  <Input
                    fullWidth
                    type="number"
                    min={1}
                    max={65535}
                    value={String(draft.simple.serverPort)}
                    onChange={(event) => updateSimple({ serverPort: numberFrom(event) })}
                    onFocus={() => play("hover")}
                  />
                  <span className="text-xs text-muted">
                    The port players connect to (Minecraft&apos;s default is 25565). If you
                    forward a port on your router, keep the two the same.
                  </span>
                </TextField>
              </Card.Content>
            </Card>
          </motion.section>
        )}

        {/* 3. Scheduled tasks (contract §3.10) */}
        <motion.section variants={cardMotion}>
          <Card className="p-6">
            <Card.Header className="flex-col items-start gap-1">
              <div className="flex items-center gap-2">
                <Clock size={16} className="text-accent" />
                <Card.Title>Scheduled tasks</Card.Title>
              </div>
              <Card.Description>
                Automatic restarts, backups and chat messages. Times are this
                computer&apos;s local time. Tasks run only while MineUI is open; one
                missed while it was closed is skipped, not run late. &ldquo;Every N
                hours&rdquo; counts from the last run, or from when MineUI was opened.
              </Card.Description>
            </Card.Header>
            <Card.Content className="mt-4 grid gap-4">
              <Switch
                isSelected={draft.scheduler.enabled}
                onChange={(selected: boolean) => {
                  play(selected ? "toggle_on" : "toggle_off");
                  setDraft((prev) =>
                    prev
                      ? { ...prev, scheduler: { ...prev.scheduler, enabled: selected } }
                      : prev,
                  );
                }}
              >
                <Switch.Content>
                  <Switch.Control>
                    <Switch.Thumb />
                  </Switch.Control>
                  <Label>Run scheduled tasks</Label>
                </Switch.Content>
              </Switch>

              {draft.scheduler.jobs.length === 0 && (
                <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted">
                  No scheduled tasks yet. Add one below — for example a daily backup at 04:00.
                </div>
              )}

              {draft.scheduler.jobs.map((job) => {
                const status = schedulerStatus?.jobs.find((item) => item.id === job.id);
                const kindMeta = JOB_KINDS.find((k) => k.id === job.kind);
                const showMessage = job.kind !== "backup";
                return (
                  <div
                    key={job.id}
                    className="grid gap-3 rounded-lg border border-border p-4"
                    style={{ background: "var(--surface-secondary)" }}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex flex-wrap items-center gap-3">
                        <Select
                          className="w-40 text-sm"
                          placeholder="Task"
                          value={job.kind}
                          onChange={(value) => {
                            if (value === null) return;
                            const kind = value as ScheduledJobKind;
                            play("toggle_on");
                            updateJob(job.id, {
                              kind,
                              message: kind === "backup" ? null : job.message,
                            });
                          }}
                        >
                          <Label className="sr-only">Task</Label>
                          <Select.Trigger onMouseEnter={() => play("hover")}>
                            <Select.Value />
                            <Select.Indicator />
                          </Select.Trigger>
                          <Select.Popover>
                            <ListBox>
                              {JOB_KINDS.map((kind) => (
                                <ListBox.Item key={kind.id} id={kind.id} textValue={kind.label}>
                                  {kind.label}
                                </ListBox.Item>
                              ))}
                            </ListBox>
                          </Select.Popover>
                        </Select>
                        <Switch
                          isSelected={job.enabled}
                          onChange={(selected: boolean) => {
                            play(selected ? "toggle_on" : "toggle_off");
                            updateJob(job.id, { enabled: selected });
                          }}
                        >
                          <Switch.Content>
                            <Switch.Control>
                              <Switch.Thumb />
                            </Switch.Control>
                            <Label>Enabled</Label>
                          </Switch.Content>
                        </Switch>
                      </div>
                      <div className="flex items-center gap-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          onPress={() =>
                            job.kind === "restart" ? setConfirmRunJob(job.id) : runJobNow(job.id)
                          }
                          isDisabled={runningJob !== null || !status || dirty}
                          isPending={runningJob === job.id}
                          onMouseEnter={() => play("hover")}
                          aria-label={!status || dirty ? "Run now (save your changes first)" : "Run now"}
                        >
                          <Play size={14} />
                          Run now
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onPress={() => removeJob(job.id)}
                          onMouseEnter={() => play("hover")}
                          aria-label="Remove task"
                        >
                          <Trash2 size={14} />
                        </Button>
                      </div>
                    </div>

                    <div className="grid gap-3 md:grid-cols-3">
                      <div className="flex flex-col gap-2">
                        <Label>Frequency</Label>
                        <Select
                          className="w-full text-sm"
                          placeholder="Frequency"
                          value={job.schedule.kind}
                          onChange={(value) => {
                            if (value === null) return;
                            updateJob(job.id, {
                              schedule: defaultSchedule(value as Schedule["kind"]),
                            });
                          }}
                        >
                          <Label className="sr-only">Frequency</Label>
                          <Select.Trigger onMouseEnter={() => play("hover")}>
                            <Select.Value />
                            <Select.Indicator />
                          </Select.Trigger>
                          <Select.Popover>
                            <ListBox>
                              <ListBox.Item id="interval">Every N hours</ListBox.Item>
                              <ListBox.Item id="daily">Daily</ListBox.Item>
                              <ListBox.Item id="weekly">Weekly</ListBox.Item>
                            </ListBox>
                          </Select.Popover>
                        </Select>
                      </div>

                      {job.schedule.kind === "interval" && (
                        <TextField className="flex flex-col gap-2" type="number">
                          <Label>Every (hours)</Label>
                          <Input
                            fullWidth
                            type="number"
                            min={1}
                            max={168}
                            value={String(job.schedule.everyHours)}
                            onChange={(event) =>
                              updateJob(job.id, {
                                schedule: { kind: "interval", everyHours: numberFrom(event) },
                              })
                            }
                            onFocus={() => play("hover")}
                          />
                        </TextField>
                      )}

                      {job.schedule.kind === "weekly" && (
                        <div className="flex flex-col gap-2">
                          <Label>Day</Label>
                          <Select
                            className="w-full text-sm"
                            placeholder="Day"
                            value={job.schedule.weekday}
                            onChange={(value) => {
                              if (value === null || job.schedule.kind !== "weekly") return;
                              updateJob(job.id, {
                                schedule: { ...job.schedule, weekday: value as Weekday },
                              });
                            }}
                          >
                            <Label className="sr-only">Day</Label>
                            <Select.Trigger onMouseEnter={() => play("hover")}>
                              <Select.Value />
                              <Select.Indicator />
                            </Select.Trigger>
                            <Select.Popover>
                              <ListBox>
                                {WEEKDAYS.map((day) => (
                                  <ListBox.Item key={day.id} id={day.id} textValue={day.label}>
                                    {day.label}
                                  </ListBox.Item>
                                ))}
                              </ListBox>
                            </Select.Popover>
                          </Select>
                        </div>
                      )}

                      {job.schedule.kind !== "interval" && (
                        <TextField className="flex flex-col gap-2">
                          <Label>Time</Label>
                          <Input
                            fullWidth
                            type="time"
                            step={60}
                            value={job.schedule.time}
                            onChange={(event) => {
                              const time = event.target.value;
                              if (job.schedule.kind === "interval") return;
                              updateJob(job.id, { schedule: { ...job.schedule, time } });
                            }}
                            onFocus={() => play("hover")}
                          />
                        </TextField>
                      )}
                    </div>

                    {showMessage && (
                      <TextField className="flex flex-col gap-2">
                        <Label>
                          {job.kind === "broadcast" ? "Message" : "Warning message (optional)"}
                        </Label>
                        <Input
                          fullWidth
                          maxLength={200}
                          placeholder={
                            job.kind === "broadcast"
                              ? "Remember to vote for the server!"
                              : "Server restarting in 60 seconds"
                          }
                          value={job.message ?? ""}
                          onChange={(event) =>
                            updateJob(job.id, {
                              message: event.target.value.length > 0 ? event.target.value : null,
                            })
                          }
                          onFocus={() => play("hover")}
                        />
                      </TextField>
                    )}

                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                      <span>{kindMeta?.hint}</span>
                      <span aria-hidden>·</span>
                      <span>{describeSchedule(job.schedule)}</span>
                      {status?.nextRunEpochMs != null && (
                        <>
                          <span aria-hidden>·</span>
                          <span>Next: {formatDateTime(status.nextRunEpochMs)}</span>
                        </>
                      )}
                      {status?.lastRun && (
                        <>
                          <span aria-hidden>·</span>
                          <Chip size="sm" variant="soft" color={status.lastRun.ok ? "success" : "danger"}>
                            Last: {formatDateTime(status.lastRun.epochMs)}
                            {status.lastRun.message ? ` — ${status.lastRun.message}` : ""}
                          </Chip>
                        </>
                      )}
                      {!status && (
                        <>
                          <span aria-hidden>·</span>
                          <span className="text-warning">Not saved yet</span>
                        </>
                      )}
                      {status && !draft.scheduler.enabled && (
                        <>
                          <span aria-hidden>·</span>
                          <span className="text-warning">Scheduler is off</span>
                        </>
                      )}
                      {status && draft.scheduler.enabled && !job.enabled && (
                        <>
                          <span aria-hidden>·</span>
                          <span className="text-warning">Paused</span>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </Card.Content>
            <Card.Footer className="mt-4 justify-start">
              <Button
                variant="ghost"
                onPress={addJob}
                isDisabled={draft.scheduler.jobs.length >= 32}
                onMouseEnter={() => play("hover")}
              >
                <Plus size={16} />
                Add task
              </Button>
            </Card.Footer>
          </Card>
        </motion.section>

        {/* 4. Backups (contract §3.8) */}
        <motion.section variants={cardMotion}>
          <Card className="p-6">
            <Card.Header className="flex-col items-start gap-1">
              <div className="flex items-center gap-2">
                <Archive size={16} className="text-accent" />
                <Card.Title>Backups</Card.Title>
              </div>
              <Card.Description>
                How many backups to keep and where to copy them. Applies to every
                backup, whether you make it yourself or a scheduled task does.
              </Card.Description>
            </Card.Header>
            <Card.Content className="mt-4 grid gap-4 md:grid-cols-2">
              <TextField className="flex flex-col gap-2" type="number">
                <Label>Keep only the newest</Label>
                <Input
                  fullWidth
                  type="number"
                  min={0}
                  max={1000}
                  value={String(draft.backups.keepLast)}
                  onChange={(event) => updateBackups({ keepLast: numberFrom(event) })}
                  onFocus={() => play("hover")}
                />
                <span className="text-xs text-muted">
                  {draft.backups.keepLast > 0
                    ? `After each new backup, older ones beyond the newest ${draft.backups.keepLast} are deleted automatically.`
                    : "0 = never delete: every backup is kept until you delete it yourself."}
                </span>
              </TextField>
              <TextField className="flex flex-col gap-2">
                <Label>Also copy each new backup to</Label>
                <Input
                  fullWidth
                  className="font-mono"
                  placeholder="Leave empty for no second copy"
                  value={draft.backups.copyDir ?? ""}
                  onChange={(event) =>
                    updateBackups({
                      copyDir: event.target.value.trim().length > 0 ? event.target.value : null,
                    })
                  }
                  onFocus={() => play("hover")}
                />
                <span className="text-xs text-muted">
                  A full folder path on this computer — another disk, a USB drive or a
                  network share is the point: backups otherwise live with the server
                  itself. The folder is created if missing; a failed copy is recorded in
                  the activity log on the Status page.
                </span>
              </TextField>
            </Card.Content>
          </Card>
        </motion.section>

        {/* 5. Advanced — everything a working server never needs touched. */}
        <motion.section variants={cardMotion}>
          <Card className="p-6">
            <button
              type="button"
              aria-expanded={advancedOpen}
              aria-controls="advanced-settings"
              onClick={() => {
                play(advancedOpen ? "toggle_off" : "toggle_on");
                setAdvancedOpen((open) => !open);
              }}
              onMouseEnter={() => play("hover")}
              className="flex w-full items-start justify-between gap-3 text-left focus-visible:outline-2 focus-visible:outline-offset-4"
              style={{ outlineColor: "var(--focus)" }}
            >
              <span className="flex flex-col gap-1">
                <span className="flex items-center gap-2">
                  <SlidersHorizontal size={16} className="text-accent" />
                  <span className="text-base font-semibold">Advanced</span>
                </span>
                <span className="text-sm text-muted">
                  {isSimple
                    ? "Java location, the internal RCON port, console command rules, and how this server is run. A working server never needs these changed."
                    : "How MineUI reaches the container, console command rules, and how this server is run. MineUI filled these in when it created the container — change them only if you changed the container yourself."}
                </span>
              </span>
              <ChevronDown
                size={18}
                className="mt-1 shrink-0 text-muted"
                style={{
                  transform: advancedOpen ? "rotate(180deg)" : "none",
                  transition: "transform var(--motion-fast) var(--motion-ease)",
                }}
              />
            </button>

            {advancedOpen && (
              <div id="advanced-settings" className="mt-6 grid gap-8">
                {isSimple ? (
                  <div className="grid gap-4 md:grid-cols-2">
                    <TextField className="flex flex-col gap-2">
                      <Label>Java location</Label>
                      <Input
                        fullWidth
                        className="font-mono"
                        placeholder="Leave empty to find Java automatically"
                        value={draft.simple.javaPath ?? ""}
                        onChange={(event) => updateSimple({ javaPath: event.target.value || null })}
                        onFocus={() => play("hover")}
                      />
                      <span className="text-xs text-muted">
                        The full path to a <code className="font-mono">java</code> program, if
                        MineUI finds the wrong one or none.
                      </span>
                    </TextField>
                    <TextField className="flex flex-col gap-2" type="number">
                      <Label>RCON port</Label>
                      <Input
                        fullWidth
                        type="number"
                        min={1}
                        max={65535}
                        value={String(draft.simple.rconPort)}
                        onChange={(event) => updateSimple({ rconPort: numberFrom(event) })}
                        onFocus={() => play("hover")}
                      />
                      <span className="text-xs text-muted">
                        The local channel MineUI uses to send commands to the server. Change
                        it only if another program already uses this port.
                      </span>
                    </TextField>
                  </div>
                ) : (
                  <div className="grid gap-4">
                    <div className="grid gap-1">
                      <span className="text-sm font-semibold">Connection</span>
                      <span className="text-xs text-muted">
                        Wrong values here make a working server look offline or missing; the
                        server itself is not affected, and putting the old value back fixes it.
                      </span>
                    </div>
                    <div className="grid gap-4 md:grid-cols-2">
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

                    <TextField className="flex flex-col gap-2" isDisabled={!containerUnlocked}>
                      <Label>Container name</Label>
                      <div className="flex gap-2">
                        <Input
                          fullWidth
                          className="font-mono"
                          placeholder="minecraft-server"
                          value={draft.advanced.containerName}
                          onChange={(event) =>
                            updateAdvanced({ containerName: event.target.value })
                          }
                          onFocus={() => play("hover")}
                        />
                        {!containerUnlocked && (
                          <Button
                            variant="secondary"
                            onPress={() => {
                              play("click_confirm");
                              setContainerUnlocked(true);
                            }}
                          >
                            Change…
                          </Button>
                        )}
                      </div>
                      <span className="text-xs text-muted">
                        Which container MineUI controls. Changing it does not rename
                        the container — MineUI stops managing the current one (it
                        keeps running) and looks for one with the new name.
                      </span>
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

                    <TextField className="flex flex-col gap-2">
                      <Label>RCON password</Label>
                      <div className="flex gap-2">
                        <Input
                          fullWidth
                          className="font-mono"
                          type={showRconPassword ? "text" : "password"}
                          autoComplete="off"
                          value={draft.advanced.rconPassword}
                          onChange={(event) =>
                            updateAdvanced({ rconPassword: event.target.value })
                          }
                          onFocus={() => play("hover")}
                        />
                        <Button
                          variant="secondary"
                          isIconOnly
                          aria-label={showRconPassword ? "Hide the RCON password" : "Show the RCON password"}
                          onPress={() => setShowRconPassword((shown) => !shown)}
                        >
                          {showRconPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                        </Button>
                      </div>
                      <span className="text-xs text-muted">
                        Must match the server&apos;s own RCON password. Changing it here
                        does not change it on the server — it only breaks the player
                        list, console and scheduled tasks.
                      </span>
                    </TextField>

                    <TextField className="flex flex-col gap-2">
                      <Label>World folder (inside the container&apos;s /data)</Label>
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
                      <Label>Server-utils URL (optional add-on for extra stats)</Label>
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
                    </div>
                  </div>
                )}

                <div className="grid gap-3">
                  <div className="grid gap-1">
                    <span className="text-sm font-semibold">Commands allowed in the console</span>
                    <span className="text-xs text-muted">
                      Only these commands can be typed on the Console (RCON) page — a guard
                      against a slip of the keyboard. Player actions and scheduled tasks are not
                      affected. Separate with commas.
                    </span>
                  </div>
                  <TextField className="flex flex-col gap-2">
                    <Label className="sr-only">Commands allowed in the console</Label>
                    <Input
                      fullWidth
                      className="font-mono"
                      placeholder={DEFAULT_ALLOWLIST}
                      value={allowlistText}
                      onChange={(event) => setAllowlistText(event.target.value)}
                      onFocus={() => play("hover")}
                    />
                  </TextField>
                  {parseAllowlist(allowlistText).join(", ") !== DEFAULT_ALLOWLIST && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="w-fit"
                      onPress={() => {
                        play("click_back");
                        setAllowlistText(DEFAULT_ALLOWLIST);
                      }}
                    >
                      <Undo2 size={14} />
                      Back to the default list
                    </Button>
                  )}
                </div>

                <div className="grid gap-3">
                  <div className="grid gap-1">
                    <span className="text-sm font-semibold">Mod downloads from your own network</span>
                    <span className="text-xs text-muted">
                      By default, a mod link that points at this computer or another device on
                      your home network is refused — a link from the internet should never be
                      able to reach those. Turn this on only if you host mod files yourself on
                      your own network.
                    </span>
                  </div>
                  <Switch
                    isSelected={draft.allowPrivateDownloadHosts}
                    onChange={(selected: boolean) => {
                      play(selected ? "toggle_on" : "toggle_off");
                      setDraft((prev) =>
                        prev ? { ...prev, allowPrivateDownloadHosts: selected } : prev,
                      );
                    }}
                  >
                    <Switch.Content>
                      <Switch.Control>
                        <Switch.Thumb />
                      </Switch.Control>
                      <Label>Allow downloads from my own network</Label>
                    </Switch.Content>
                  </Switch>
                </div>

                <div className="grid gap-3">
                  <div className="grid gap-1">
                    <span className="text-sm font-semibold">How this server is run</span>
                    <span className="text-xs text-muted">
                      Switching does not move or delete anything: MineUI simply stops showing
                      the current {isSimple ? "server files" : "container"} for{" "}
                      {active.name} and shows the other kind instead (empty until you set it
                      up). Switch back and everything is as you left it.
                      {serverBusy ? ` Stop ${active.name} first.` : ""}
                    </span>
                  </div>
                  <div
                    role="radiogroup"
                    aria-label="How this server is run"
                    className="grid gap-3 sm:grid-cols-2"
                    onKeyDown={(event: React.KeyboardEvent) => {
                      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key))
                        return;
                      event.preventDefault();
                      const next: ModeId = isSimple ? "advanced" : "simple";
                      modeRefs.current[next]?.focus();
                    }}
                  >
                    {MODE_OPTIONS.map((option) => (
                      <ModeOptionCard
                        key={option.id}
                        option={option}
                        selected={mode === option.id}
                        disabled={modeSwitching || (serverBusy && mode !== option.id)}
                        onSelect={() => requestModeChange(option.id)}
                        onHover={() => play("hover")}
                        buttonRef={(node) => {
                          modeRefs.current[option.id] = node;
                        }}
                      />
                    ))}
                  </div>
                </div>
              </div>
            )}
          </Card>
        </motion.section>

        {/* 6. Danger zone */}
        <motion.section variants={cardMotion}>
          <Card className="p-6">
            <Card.Header className="flex-col items-start gap-1">
              <div className="flex items-center gap-2">
                <TriangleAlert size={16} className="text-danger" />
                <Card.Title>Danger zone</Card.Title>
              </div>
              <Card.Description>
                To take {active.name} off MineUI&apos;s list without deleting anything, use{" "}
                <Link href="/app-settings#servers" className="text-accent underline">
                  App Settings → Servers
                </Link>
                .
              </Card.Description>
            </Card.Header>
            {isSimple ? (
              instance?.exists ? (
                <Card.Footer className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
                  <span className="max-w-md text-xs text-muted">
                    Deleting the server files removes the world, its settings and{" "}
                    <strong>every backup stored with it</strong> from this computer.
                    {serverBusy ? ` Stop ${active.name} first.` : ""}
                  </span>
                  <Button
                    variant="danger"
                    isDisabled={serverBusy}
                    onPress={() => {
                      play("click_confirm");
                      setDeleteOpen(true);
                    }}
                    onMouseEnter={() => play("hover")}
                  >
                    <Trash2 size={16} />
                    Delete server files
                  </Button>
                </Card.Footer>
              ) : (
                <Card.Content className="mt-4 text-sm text-muted">
                  Nothing to delete — this server has not been set up yet.
                </Card.Content>
              )
            ) : (
              /* Renders its own footer; nothing while there is no container. */
              <DeleteContainerButton />
            )}
          </Card>
        </motion.section>

        {/* One Save for the whole page, visible exactly when there is
            something to save. */}
        {dirty && (
          <div
            role="region"
            aria-label="Unsaved changes"
            className="sticky bottom-4 z-20 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-accent p-3"
            style={{ background: "var(--overlay)", boxShadow: "var(--overlay-shadow)" }}
          >
            <div className="grid gap-0.5 text-sm">
              <span className="font-semibold">Unsaved changes</span>
              {problems.length > 0 ? (
                <span className="text-xs text-danger">{problems.join(" ")}</span>
              ) : (
                <span className="text-xs text-muted">
                  Nothing on this page is applied until you save.
                </span>
              )}
            </div>
            <div className="flex gap-2">
              <Button variant="tertiary" onPress={discardChanges} isDisabled={saving}>
                Discard
              </Button>
              <Button
                onPress={saveSettings}
                isDisabled={saving || problems.length > 0}
                isPending={saving}
                onMouseEnter={() => play("hover")}
              >
                <Save size={16} />
                {saving ? "Saving..." : "Save settings"}
              </Button>
            </div>
          </div>
        )}

        <ConfirmDialog
          isOpen={deleteOpen}
          title="Delete server files"
          description={`This permanently deletes ${active.name}'s world, its settings and every backup stored with it (${draft.simple.instanceDir}). Copies in your second backup folder are not touched. This cannot be undone.`}
          confirmLabel="Delete world and backups"
          cancelLabel="Cancel"
          variant="danger"
          isLoading={deleting}
          isConfirmDisabled={deleteTyped.trim() !== active.name}
          onCancel={() => {
            setDeleteOpen(false);
            setDeleteTyped("");
          }}
          onConfirm={handleDeleteInstance}
          footer={
            <TextField
              className="flex flex-col gap-2"
              value={deleteTyped}
              onChange={setDeleteTyped}
              isDisabled={deleting}
            >
              <Label>
                Type <span className="font-mono text-danger">{active.name}</span> to confirm
              </Label>
              <Input autoComplete="off" spellCheck={false} />
            </TextField>
          }
        />

        <ConfirmDialog
          isOpen={pendingMode !== null}
          title={pendingMode === "advanced" ? "Run it in a container" : "Run it on this computer"}
          description={
            pendingMode === "advanced"
              ? `MineUI will stop showing ${active.name}'s current server files and show a container server here instead — empty until you create or attach one. Nothing is deleted or moved: the world stays where it is and is not carried over. Switch back at any time.`
              : `MineUI will stop managing the container "${draft.advanced.containerName}" for ${active.name} and show a plain server on this computer instead — empty until you set it up. The container and its world are not deleted or moved. Switch back at any time.`
          }
          confirmLabel="Switch"
          cancelLabel="Keep as is"
          onCancel={() => setPendingMode(null)}
          onConfirm={confirmModeChange}
        />

        <ConfirmDialog
          isOpen={jobToConfirm !== undefined}
          title={`Restart ${active.name} now`}
          description="Everyone playing is disconnected while the server restarts. If the task has a warning message, it is sent first and the restart follows 60 seconds later."
          confirmLabel="Restart now"
          cancelLabel="Cancel"
          variant="danger"
          onCancel={() => setConfirmRunJob(null)}
          onConfirm={() => {
            const id = confirmRunJob;
            setConfirmRunJob(null);
            if (id) void runJobNow(id);
          }}
        />

        <ConfirmDialog
          isOpen={pendingLeave !== null}
          title="Leave without saving"
          description="You changed settings on this page and have not saved them. Leaving throws those changes away."
          confirmLabel="Discard changes"
          cancelLabel="Stay here"
          variant="danger"
          onCancel={() => setPendingLeave(null)}
          onConfirm={() => {
            const proceed = pendingLeave;
            setPendingLeave(null);
            setLeaveGuard(null);
            proceed?.();
          }}
        />
      </motion.main>
    </div>
  );
}
