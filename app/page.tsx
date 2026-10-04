"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { motion } from "motion/react";
import { transition, usePageMotion } from "@/app/lib/motion";
import {
  Activity,
  Archive,
  Boxes,
  Loader2,
  Play,
  RefreshCcw,
  ScrollText,
  Server,
  Square,
  Users,
} from "lucide-react";
import { Button, Card, Chip, ScrollShadow, Separator, toast } from "@heroui/react";
import { EmptyState, NumberValue } from "@heroui-pro/react";
import { KPI } from "@heroui-pro/react/kpi";
import { useUISound } from "@/app/hooks/useUISound";
import { useMode } from "@/app/components/ModeProvider";
import { SkeletonCard } from "@/app/components/Skeleton";
import CreateContainerFlow from "@/app/components/CreateContainerFlow";
import CreateServerFlow from "@/app/components/CreateServerFlow";
import RuntimeInstallHelp from "@/app/components/RuntimeInstallHelp";
import ServerIdentity from "@/app/components/ServerIdentity";
import ServersOverview from "@/app/components/ServersOverview";
import ConfirmDialog from "@/app/components/ConfirmDialog";
import { useServers } from "@/app/components/ServerProvider";
import {
  createBackup,
  getLogs,
  getServerState,
  getServerStatus,
  getSettings,
  instanceStatus,
  listMods,
  onLogs,
  onServerState,
  restartServer,
  startLogStream,
  startServer,
  stopLogStream,
  stopServer,
  IpcError,
  isTauri,
  type InstanceStatus,
  type ModsList,
  type ServerPhase,
  type ServerState,
  type ServerStatus,
  type Settings,
} from "@/app/lib/ipc";

const MAX_LOG_LINES = 1000;

// One statement of how the server is doing, from the two facts the backend
// gives: the process/container phase and whether the game answers a ping.
// "running" without an answer is the minutes between Start and "Done" (a
// modpack's first start installs the pack then) - showing "running" next to
// "Offline" made that look broken (UX review 2026-10).
type Condition = "online" | "warming" | "starting" | "stopping" | "stopped" | "crashed" | "unknown";

const conditionOf = (phase: ServerPhase | undefined, online: boolean): Condition => {
  switch (phase) {
    case "running":
      return online ? "online" : "warming";
    case "starting":
      return "starting";
    case "stopping":
      return "stopping";
    case "crashed":
      return "crashed";
    case "stopped":
    case "not-created":
      return "stopped";
    default:
      return "unknown";
  }
};

const CONDITION_LABEL: Record<Condition, string> = {
  online: "Online",
  warming: "Starting up…",
  starting: "Starting…",
  stopping: "Stopping…",
  stopped: "Stopped",
  crashed: "Crashed",
  unknown: "Unknown",
};

const conditionChipColor = (condition: Condition) => {
  switch (condition) {
    case "online":
      return "success" as const;
    case "warming":
    case "starting":
    case "stopping":
      return "warning" as const;
    case "crashed":
      return "danger" as const;
    default:
      return "default" as const;
  }
};

type DashAction = "start" | "stop" | "restart" | "backup";

export default function Home() {
  const router = useRouter();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [serverState, setServerState] = useState<ServerState | null>(null);
  const [instance, setInstance] = useState<InstanceStatus | null>(null);
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [mods, setMods] = useState<ModsList | null>(null);
  const [logLines, setLogLines] = useState<string[]>([]);
  // Which action is in flight - the spinner goes on that button only.
  const [busyAction, setBusyAction] = useState<DashAction | null>(null);
  const busy = busyAction !== null;
  const [confirmAction, setConfirmAction] = useState<"stop" | "restart" | null>(null);
  // The backend answered, but the container runtime behind it did not.
  const [runtimeDown, setRuntimeDown] = useState(false);
  const [loading, setLoading] = useState(true);
  const [backendError, setBackendError] = useState<string | null>(null);
  // Advanced mode with neither Podman nor Docker installed is not a broken
  // backend - it gets install instructions instead of the generic error.
  const [runtimeMissing, setRuntimeMissing] = useState(false);
  const logsRef = useRef<HTMLDivElement>(null);
  const { play } = useUISound();
  // Shared app-wide mode (app/components/ModeProvider.tsx) - not derived from
  // this page's own `settings` fetch anymore, so a navbar toggle updates this
  // page live instead of only on next remount. `settings` below is kept only
  // for fields useMode() doesn't carry (e.g. simple.memoryMb for
  // CreateServerFlow's default).
  const { mode, loading: modeLoading } = useMode();
  const { active: activeServer, activeId, overview } = useServers();
  const address = overview.find((item) => item.id === activeId)?.address ?? null;

  const serverOnline = status?.online ?? false;
  const playerCount = status?.players.online ?? 0;
  const maxPlayers = status?.players.max ?? 0;

  const isSimple = mode === "simple";
  // Nothing to show yet: simple mode without an instance, or advanced mode
  // whose container does not exist. Each has its own create flow below.
  const needsInstance = isSimple && instance !== null && !instance.exists;
  const needsContainer =
    !isSimple && settings !== null && serverState?.phase === "not-created";
  const needsOnboarding = needsInstance || needsContainer;
  const showDashboard = !loading && backendError === null && !needsOnboarding;

  // Depends on `mode`/`modeLoading` so a live mode toggle (no remount) also
  // refetches the mode-dependent data below (instanceStatus is simple-mode
  // only) instead of leaving this page showing stale data for the old mode
  // (docs/theme-contract.md's live-mode-toggle requirement).
  const bootstrap = useCallback(async () => {
    if (modeLoading) return; // wait for the provider's first mode read
    try {
      const loadedSettings = await getSettings();
      setSettings(loadedSettings);
      setServerState(await getServerState());
      if (mode === "simple") {
        setInstance(await instanceStatus());
      } else {
        setInstance(null);
      }
      setBackendError(null);
      setRuntimeMissing(false);
      setRuntimeDown(false);
    } catch (error) {
      setRuntimeMissing(error instanceof IpcError && error.code === "RUNTIME_NOT_FOUND");
      // Installed but not responding (Docker Desktop closed, podman machine
      // stopped) - not the same thing as "install a runtime".
      setRuntimeDown(error instanceof IpcError && error.code === "RUNTIME_UNAVAILABLE");
      setBackendError(
        error instanceof IpcError ? error.message : String(error),
      );
    } finally {
      setLoading(false);
    }
  }, [mode, modeLoading]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- IPC fetch-on-mount: the loader flips its loading flag synchronously by design
    bootstrap();
  }, [bootstrap]);

  // Pull data (status ping + mods list) - no events for these, poll lightly.
  const refreshPolled = useCallback(async () => {
    const [statusResult, modsResult] = await Promise.allSettled([
      getServerStatus(),
      listMods(),
    ]);
    if (statusResult.status === "fulfilled") setStatus(statusResult.value);
    if (modsResult.status === "fulfilled") setMods(modsResult.value);
  }, []);

  useEffect(() => {
    if (!showDashboard) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- IPC fetch-on-mount: the loader flips its loading flag synchronously by design
    refreshPolled();
    const interval = setInterval(refreshPolled, 8000);
    return () => clearInterval(interval);
    // `mode` restarts the poll on a live toggle so status/mods reflect the
    // newly targeted server immediately instead of up to 8s later.
  }, [showDashboard, refreshPolled, mode]);

  // Server state badge is event-driven: fetch on mount, subscribe for changes.
  useEffect(() => {
    if (!showDashboard) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;
    onServerState((event) => {
      setServerState((prev) =>
        prev ? { ...prev, mode: event.mode, phase: event.phase } : prev,
      );
      // Event is a change notification; refetch the full state for detail.
      getServerState().then(setServerState).catch(() => {});
      if (event.phase === "crashed") {
        toast.danger(
          `Server crashed${event.exitCode !== null ? ` (exit code ${event.exitCode})` : ""}`,
        );
      }
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [showDashboard]);

  // Log stream lifecycle per contract §4.1: backfill via get_logs, then
  // start_log_stream + mineui://logs listener; stop + unlisten on unmount.
  useEffect(() => {
    if (!showDashboard || !isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;

    getLogs(200)
      .then(({ lines }) => setLogLines(lines.slice(-MAX_LOG_LINES)))
      .catch(() => {});
    startLogStream().catch(() => {});
    onLogs((event) => {
      setLogLines((prev) =>
        [...prev, ...event.lines.map((line) => line.text)].slice(-MAX_LOG_LINES),
      );
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });

    return () => {
      disposed = true;
      unlisten?.();
      stopLogStream().catch(() => {});
    };
  }, [showDashboard]);

  // Auto-scroll logs to bottom
  useEffect(() => {
    if (logsRef.current) {
      logsRef.current.scrollTop = logsRef.current.scrollHeight;
    }
  }, [logLines]);

  // What each action says when the *request* went through - which for Start
  // and Restart is not yet "the server is up".
  const runAction = async (kind: DashAction) => {
    play("click_confirm");
    setBusyAction(kind);
    const name = activeServer.name;
    try {
      if (kind === "start") {
        await startServer();
        toast(`${name} is starting - it is ready when the status turns Online.`);
      } else if (kind === "stop") {
        await stopServer();
        toast.success(`${name} stopped`);
      } else if (kind === "restart") {
        await restartServer();
        toast(`${name} is restarting - it is ready when the status turns Online.`);
      } else {
        const { pruned } = await createBackup();
        toast.success(
          pruned.length > 0
            ? `Backup created. The oldest backup (${pruned[0]}) was removed - see Backups for how many are kept.`
            : "Backup created",
        );
      }
      play("success");
      setServerState(await getServerState().catch(() => null));
      await refreshPolled();
    } catch (error) {
      play("error");
      const fallback = { start: "Could not start", stop: "Could not stop", restart: "Could not restart", backup: "Backup failed" }[kind];
      toast.danger(error instanceof IpcError ? error.message : fallback);
    } finally {
      setBusyAction(null);
    }
  };

  // Stop/Restart disconnect people: ask when someone is playing.
  const requestAction = (kind: "stop" | "restart") => {
    if (playerCount > 0) {
      play("click_confirm");
      setConfirmAction(kind);
    } else {
      void runAction(kind);
    }
  };

  const phase = serverState?.phase;
  const condition = conditionOf(phase, serverOnline);
  const canStart = phase === "stopped" || phase === "crashed";
  const canStop = phase === "running" || phase === "starting";
  const canRestart = phase === "running";

  const handleRefresh = () => {
    play("click_confirm");
    getServerState().then(setServerState).catch(() => {});
    refreshPolled();
  };

  const { containerMotion, cardMotion } = usePageMotion();

  if (loading) {
    return (
      <div className="min-h-screen bg-background">
        <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-6 px-4 py-10 md:px-6">
          <div className="h-16" />
          <SkeletonCard />
          <div className="grid gap-6 md:grid-cols-3">
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </div>
        </main>
      </div>
    );
  }

  if (backendError !== null && runtimeMissing) {
    return (
      <div className="min-h-screen bg-background">
        <main className="page-main mx-auto flex max-w-3xl flex-col justify-center gap-6 px-4 py-10 md:px-6">
          <Card className="p-6">
            <Card.Header className="flex-col items-start gap-2">
              <div className="flex items-center gap-3 text-sm text-accent">
                <Server size={18} />
                <span className="font-pixel text-xs tracking-wide">
                  {activeServer.name} needs a container runtime
                </span>
              </div>
              <Card.Description>
                This server runs in a container, and MineUI found neither
                Podman nor Docker on this computer. Your other servers are
                unaffected. If you would rather not install anything, a plain
                Minecraft server needs no containers: switch how this server
                is run under <em>Advanced</em> in its settings.
              </Card.Description>
            </Card.Header>
            <Card.Content className="mt-4 grid gap-4">
              <RuntimeInstallHelp onRecheck={() => bootstrap()} />
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" onPress={() => router.push("/settings")}>
                  Open Server Settings
                </Button>
                <Button variant="tertiary" onPress={() => router.push("/app-settings#servers")}>
                  Manage servers
                </Button>
              </div>
            </Card.Content>
          </Card>
        </main>
      </div>
    );
  }

  if (backendError !== null) {
    return (
      <div className="min-h-screen bg-background">
        <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-6 px-4 py-10 md:px-6">
          <Card className="p-6">
            <Card.Header className="flex items-center gap-3 text-sm text-accent">
              <Server size={18} />
              <span className="font-pixel text-xs tracking-wide">
                {runtimeDown
                  ? `${activeServer.name}: the container runtime is not responding`
                  : `Couldn't load ${activeServer.name}`}
              </span>
            </Card.Header>
            <Card.Content className="mt-4 grid gap-3 text-sm text-muted">
              <p>{backendError}</p>
              {runtimeDown && (
                <p>
                  Podman or Docker is installed but not running. Start Docker
                  Desktop, or on Windows and macOS run{" "}
                  <code className="font-mono">podman machine start</code>, then try
                  again. Nothing is wrong with the server itself.
                </p>
              )}
              {!isTauri() && (
                <p>
                  Launch MineUI with{" "}
                  <code className="font-mono">pnpm tauri dev</code> or the packaged
                  app - the web preview has no backend.
                </p>
              )}
            </Card.Content>
            <Card.Footer className="mt-4 flex flex-wrap gap-2">
              <Button onPress={() => bootstrap()}>
                <RefreshCcw size={16} />
                Try again
              </Button>
              <Button variant="secondary" onPress={() => router.push("/settings")}>
                Server Settings
              </Button>
              <Button variant="tertiary" onPress={() => router.push("/app-settings#servers")}>
                Manage servers
              </Button>
            </Card.Footer>
          </Card>
        </main>
      </div>
    );
  }

  return (
    <div
      className="min-h-screen"
      style={{
        background: `radial-gradient(circle at top, var(--page-wash), transparent 60%), var(--background)`,
      }}
    >
      <motion.main
        className="page-main mx-auto flex max-w-6xl flex-col gap-6 px-4 py-10 md:px-6"
        initial="hidden"
        animate="show"
        variants={containerMotion}
      >
        <motion.header className="flex flex-col gap-3" variants={cardMotion}>
          <span className="text-xs uppercase tracking-[0.3em] text-muted">
            Home Server Control
          </span>
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="relative">
              {/* Static glow - was an infinite 4s pulse loop; the contract
                  forbids ambient loops (docs/theme-contract.md §6), and the
                  dashboard only budgets one (the online-status dot below).
                  Shape is "ellipse farthest-side" (not the previous bare
                  "circle", which defaults to farthest-corner sizing): on a
                  box this much wider than tall, farthest-corner math makes
                  the gradient's radius so large that the "transparent 70%"
                  stop never resolves before the box's own top/bottom edges,
                  so the halo was hard-cut there instead of fading out.
                  farthest-side sizes each axis to its own edge, so the fade
                  always completes symmetrically before any edge. */}
              <div
                className="pointer-events-none absolute -inset-8 opacity-40"
                style={{
                  background:
                    "radial-gradient(ellipse farthest-side, color-mix(in oklab, var(--accent) 25%, transparent), transparent 70%)",
                }}
              />
              <h1 className="font-pixel text-2xl uppercase tracking-[0.2em] text-accent -mr-[0.2em]">
                MineUI
              </h1>
              {/* Which server this dashboard is, named properly. */}
              <ServerIdentity className="relative mt-2" />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Chip variant="soft" color="accent">
                {isSimple ? "Simple mode" : "Advanced mode"}
              </Chip>
              {!needsOnboarding && (
                <>
                  {/* One chip says how the server is doing. Signature moment:
                      a brief scale/glow whenever the condition changes,
                      keyed to --motion-base (remount drives the enter
                      animation - no loop). */}
                  <motion.span
                    key={condition}
                    className="inline-flex"
                    initial={{ opacity: 0, scale: 0.92, filter: "brightness(1.5)" }}
                    animate={{ opacity: 1, scale: 1, filter: "brightness(1)" }}
                    transition={transition("base")}
                  >
                    <Chip variant="soft" color={conditionChipColor(condition)}>
                      {condition === "online" ? (
                        <span className="flex items-center gap-1.5">
                          {/* The one sanctioned ambient loop on this screen
                              (docs/theme-contract.md §6); reduced-motion
                              guard in globals.css. */}
                          <span className="inline-block h-2 w-2 rounded-full animate-pulse bg-accent" />
                          Online
                        </span>
                      ) : (
                        CONDITION_LABEL[condition]
                      )}
                    </Chip>
                  </motion.span>
                  <Button
                    onPress={handleRefresh}
                    isDisabled={busy}
                    onMouseEnter={() => play("hover")}
                  >
                    <RefreshCcw size={16} />
                    <span className="hidden sm:inline">Refresh</span>
                  </Button>
                  <Button
                    variant="tertiary"
                    onPress={() => runAction("backup")}
                    isDisabled={busy}
                    onMouseEnter={() => play("hover")}
                  >
                    {busyAction === "backup" ? (
                      <Loader2 size={16} className="animate-spin" />
                    ) : (
                      <Archive size={16} />
                    )}
                    <span className="hidden sm:inline">Backup</span>
                  </Button>
                </>
              )}
            </div>
          </div>
        </motion.header>

        {/* Every server at once (renders nothing with a single server). */}
        <ServersOverview />

        {needsContainer && settings ? (
          <CreateContainerFlow
            serverName={activeServer.name}
            settings={settings}
            onCreated={() => {
              setLoading(true);
              bootstrap();
            }}
          />
        ) : needsInstance ? (
          <CreateServerFlow
            defaultMemoryMb={settings?.simple.memoryMb ?? 2048}
            onCreated={() => {
              setLoading(true);
              bootstrap();
            }}
          />
        ) : (
          <>
            {/* Live mode toggling (no remount) means this branch can now
                mount for the first time well after the page's initial
                containerMotion stagger already resolved (previously this
                only ever mounted at first paint or after a full-page
                setLoading(true) remount) - must drive its own enter
                animation per the same fix as commit 1090c51. */}
            <motion.section
              variants={cardMotion}
              initial="hidden"
              animate="show"
            >
              <Card className="p-5">
                <Card.Header className="flex flex-row items-center justify-between gap-3">
                  <div className="flex items-center gap-3 text-sm text-accent">
                    <ScrollText size={18} />
                    <span className="font-pixel text-xs tracking-wide">
                      Server Logs
                    </span>
                  </div>
                  {/* Was an infinite 2s pulse loop; now a finite flash that
                      fires only when a new log batch actually arrives
                      (remounts via `key`), then settles - state-change-
                      triggered per the audit, not ambient. */}
                  <motion.div
                    key={logLines.length}
                    className="h-2 w-2 rounded-full bg-accent"
                    initial={{ opacity: 1 }}
                    animate={{ opacity: 0.4 }}
                    transition={transition("slow")}
                  />
                </Card.Header>
                <Card.Content>
                  <ScrollShadow
                    ref={logsRef}
                    className="mt-4 max-h-105 rounded-lg border border-border p-4 text-xs leading-5 font-mono text-foreground"
                    style={{
                      background:
                        "var(--well)",
                    }}
                  >
                    {logLines.length ? (
                      <pre className="whitespace-pre-wrap">
                        {logLines.join("\n")}
                      </pre>
                    ) : (
                      <div
                        className="flex items-center gap-2 text-muted"
                      >
                        <Activity size={16} />
                        Waiting for logs...
                      </div>
                    )}
                  </ScrollShadow>
                </Card.Content>
              </Card>
            </motion.section>

            {/* Same late-mount rule as the Server Logs section above - this
                stagger container itself must re-fire its entrance so its
                cardMotion children animate in instead of inheriting a
                long-settled parent state. */}
            <motion.section
              className="grid gap-6 md:grid-cols-3"
              variants={containerMotion}
              initial="hidden"
              animate="show"
            >
              <motion.div variants={cardMotion}>
                <KPI className="flex h-full flex-col p-5">
                  <KPI.Header>
                    <KPI.Icon
                      className="text-accent"
                      status={serverOnline ? "success" : undefined}
                    >
                      <Server size={16} />
                    </KPI.Icon>
                    <KPI.Title>Status</KPI.Title>
                  </KPI.Header>
                  <KPI.Content className="items-start">
                    <div className="grid flex-1 gap-2 text-sm">
                      <div className="text-lg font-semibold">{CONDITION_LABEL[condition]}</div>
                      {condition === "online" && (
                        <>
                          {address && (
                            <div className="text-muted">
                              Players join at <span className="font-mono">{address}</span>
                            </div>
                          )}
                          <div className="text-muted">Version: {status?.version ?? "unknown"}</div>
                          <div className="text-muted">MOTD: {status?.motd ?? "-"}</div>
                          <div className="text-muted font-pixel-num">
                            Ping: {status?.pingMs != null ? `${status.pingMs}ms` : "-"}
                          </div>
                        </>
                      )}
                      {condition === "warming" && (
                        <p className="text-muted" title={status?.error ?? undefined}>
                          The server is running but not taking players yet. The first
                          start of a modded server or modpack can take several minutes -
                          watch the log above; it is ready when a line says{" "}
                          <span className="font-mono">Done</span>.
                        </p>
                      )}
                      {condition === "starting" && (
                        <p className="text-muted">Starting - this updates by itself.</p>
                      )}
                      {condition === "stopping" && (
                        <p className="text-muted">Saving the world and shutting down.</p>
                      )}
                      {condition === "stopped" && (
                        <p className="text-muted">Press Start to bring the server online.</p>
                      )}
                      {condition === "crashed" && (
                        <p className="text-muted">
                          The server stopped unexpectedly. The last lines of the log
                          above usually say why; Start tries again.
                        </p>
                      )}
                    </div>
                  </KPI.Content>
                  <KPI.Footer className="mt-auto flex flex-wrap gap-2 pt-4">
                    <Button
                      onPress={() => runAction("start")}
                      isDisabled={busy || !canStart}
                      onMouseEnter={() => play("hover")}
                    >
                      {busyAction === "start" ? (
                        <Loader2 size={16} className="animate-spin" />
                      ) : (
                        <Play size={16} />
                      )}
                      Start
                    </Button>
                    <Button
                      variant="danger"
                      onPress={() => requestAction("stop")}
                      isDisabled={busy || !canStop}
                      onMouseEnter={() => play("hover")}
                    >
                      {busyAction === "stop" ? (
                        <Loader2 size={16} className="animate-spin" />
                      ) : (
                        <Square size={16} />
                      )}
                      Stop
                    </Button>
                    <Button
                      variant="tertiary"
                      onPress={() => requestAction("restart")}
                      isDisabled={busy || !canRestart}
                      onMouseEnter={() => play("hover")}
                    >
                      {busyAction === "restart" ? (
                        <Loader2 size={16} className="animate-spin" />
                      ) : (
                        <RefreshCcw size={16} />
                      )}
                      Restart
                    </Button>
                  </KPI.Footer>
                </KPI>
              </motion.div>

              <motion.div variants={cardMotion}>
                <KPI className="flex h-full flex-col p-5">
                  <KPI.Header>
                    <KPI.Icon
                      className="text-accent"
                      status={playerCount > 0 ? "success" : undefined}
                    >
                      <Users size={16} />
                    </KPI.Icon>
                    <KPI.Title>Players</KPI.Title>
                  </KPI.Header>
                  <KPI.Content className="items-start">
                    <div className="flex-1">
                      <KPI.Value className="font-pixel-num" value={playerCount}>
                        {(formatted) => (
                          <>
                            {formatted}
                            <NumberValue.Suffix>/{maxPlayers || "?"}</NumberValue.Suffix>
                          </>
                        )}
                      </KPI.Value>
                      <div className="mt-4 flex flex-wrap gap-2">
                        {playerCount === 0 ? (
                          <EmptyState size="sm" className="items-start text-left">
                            <EmptyState.Description>
                              No players online
                            </EmptyState.Description>
                          </EmptyState>
                        ) : (
                          <Chip variant="soft" color="accent">
                            {playerCount} online
                          </Chip>
                        )}
                      </div>
                    </div>
                  </KPI.Content>
                  <KPI.Footer className="mt-auto pt-4">
                    <Button
                      variant="secondary"
                      onPress={() => {
                        play("click_confirm");
                        router.push("/players");
                      }}
                      onMouseEnter={() => play("hover")}
                    >
                      View players
                    </Button>
                  </KPI.Footer>
                </KPI>
              </motion.div>

              <motion.div variants={cardMotion}>
                <KPI className="flex h-full flex-col p-5">
                  <KPI.Header>
                    <KPI.Icon className="text-accent">
                      <Boxes size={16} />
                    </KPI.Icon>
                    <KPI.Title>Mods & Plugins</KPI.Title>
                  </KPI.Header>
                  <KPI.Content className="flex-1 gap-3 text-sm">
                    <div className="flex gap-6">
                      <div>
                        <div className="text-[10px] uppercase tracking-[0.2em] text-muted">
                          Mods
                        </div>
                        <KPI.Value className="mt-2 text-lg" value={mods?.mods.length ?? 0} />
                      </div>
                      <Separator orientation="vertical" className="h-auto self-stretch" />
                      <div>
                        <div className="text-[10px] uppercase tracking-[0.2em] text-muted">
                          Plugins
                        </div>
                        <KPI.Value className="mt-2 text-lg" value={mods?.plugins.length ?? 0} />
                      </div>
                    </div>
                  </KPI.Content>
                  <KPI.Footer className="mt-auto pt-4">
                    <Button
                      variant="secondary"
                      onPress={() => {
                        play("click_confirm");
                        router.push("/mods");
                      }}
                      onMouseEnter={() => play("hover")}
                    >
                      View mods
                    </Button>
                  </KPI.Footer>
                </KPI>
              </motion.div>
            </motion.section>
          </>
        )}
        <ConfirmDialog
          isOpen={confirmAction !== null}
          title={confirmAction === "restart" ? `Restart ${activeServer.name}` : `Stop ${activeServer.name}`}
          description={`${playerCount} ${playerCount === 1 ? "player is" : "players are"} online and will be disconnected. The world is saved first.`}
          confirmLabel={confirmAction === "restart" ? "Restart anyway" : "Stop anyway"}
          cancelLabel="Cancel"
          variant="danger"
          onCancel={() => setConfirmAction(null)}
          onConfirm={() => {
            const kind = confirmAction;
            setConfirmAction(null);
            if (kind) void runAction(kind);
          }}
        />
      </motion.main>
    </div>
  );
}
