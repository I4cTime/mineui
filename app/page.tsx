"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { motion } from "motion/react";
import { listStagger, scaleIn, transition } from "@/app/lib/motion";
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
import { EmptyState, KPI, NumberValue } from "@heroui-pro/react";
import { useUISound } from "@/app/hooks/useUISound";
import { SkeletonCard } from "@/app/components/Skeleton";
import CreateServerFlow from "@/app/components/CreateServerFlow";
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

const phaseChipColor = (phase: ServerPhase | undefined) => {
  switch (phase) {
    case "running":
      return "success" as const;
    case "starting":
    case "stopping":
      return "warning" as const;
    case "crashed":
      return "danger" as const;
    default:
      return "default" as const;
  }
};

const phaseLabel = (phase: ServerPhase | undefined) => {
  switch (phase) {
    case "not-created":
      return "not created";
    case undefined:
      return "unknown";
    default:
      return phase;
  }
};

export default function Home() {
  const router = useRouter();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [serverState, setServerState] = useState<ServerState | null>(null);
  const [instance, setInstance] = useState<InstanceStatus | null>(null);
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [mods, setMods] = useState<ModsList | null>(null);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [backendError, setBackendError] = useState<string | null>(null);
  const logsRef = useRef<HTMLDivElement>(null);
  const { play } = useUISound();

  const serverOnline = status?.online ?? false;
  const playerCount = status?.players.online ?? 0;
  const maxPlayers = status?.players.max ?? 0;

  const isSimple = settings?.activeMode === "simple";
  const needsOnboarding =
    isSimple && instance !== null && !instance.exists;
  const showDashboard = !loading && backendError === null && !needsOnboarding;

  const bootstrap = useCallback(async () => {
    try {
      const loadedSettings = await getSettings();
      setSettings(loadedSettings);
      setServerState(await getServerState());
      if (loadedSettings.activeMode === "simple") {
        setInstance(await instanceStatus());
      } else {
        setInstance(null);
      }
      setBackendError(null);
    } catch (error) {
      setBackendError(
        error instanceof IpcError ? error.message : String(error),
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    bootstrap();
  }, [bootstrap]);

  // Pull data (status ping + mods list) — no events for these, poll lightly.
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
    refreshPolled();
    const interval = setInterval(refreshPolled, 8000);
    return () => clearInterval(interval);
  }, [showDashboard, refreshPolled]);

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

  const runAction = async (action: () => Promise<unknown>, label: string) => {
    play("click_confirm");
    setBusy(true);
    try {
      await action();
      play("success");
      toast.success(`${label} completed`);
      setServerState(await getServerState().catch(() => null));
      await refreshPolled();
    } catch (error) {
      play("error");
      toast.danger(
        error instanceof IpcError ? error.message : `${label} failed`,
      );
    } finally {
      setBusy(false);
    }
  };

  const handleRefresh = () => {
    play("click_confirm");
    getServerState().then(setServerState).catch(() => {});
    refreshPolled();
  };

  // Read fresh on every render so a theme switch (data-theme changes at
  // runtime, see Navbar.tsx) is picked up on next navigation/mount —
  // presets must never be frozen module-level constants (docs/theme-contract.md §6).
  const containerMotion = listStagger();
  const cardMotion = scaleIn();

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

  if (backendError !== null) {
    return (
      <div className="min-h-screen bg-background">
        <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-6 px-4 py-10 md:px-6">
          <Card className="p-6">
            <Card.Header className="flex items-center gap-3 text-sm text-accent">
              <Server size={18} />
              <span className="font-pixel text-xs tracking-wide">
                Backend unavailable
              </span>
            </Card.Header>
            <Card.Content className="mt-4 grid gap-3 text-sm text-muted">
              <p>{backendError}</p>
              <p>
                Launch MineUI with{" "}
                <code className="font-mono">pnpm tauri dev</code> or the packaged
                app — the web preview has no backend.
              </p>
            </Card.Content>
            <Card.Footer className="mt-4">
              <Button onPress={() => bootstrap()}>
                <RefreshCcw size={16} />
                Retry
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
        background: `radial-gradient(circle at top, color-mix(in oklab, var(--accent) 18%, transparent), transparent 60%), var(--background)`,
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
              {/* Static glow — was an infinite 4s pulse loop; the contract
                  forbids ambient loops (docs/theme-contract.md §6), and the
                  dashboard only budgets one (the online-status dot below). */}
              <div
                className="absolute -inset-4 rounded-full opacity-40"
                style={{
                  background:
                    "radial-gradient(circle, color-mix(in oklab, var(--accent) 25%, transparent), transparent 70%)",
                }}
              />
              <h1 className="font-pixel text-2xl uppercase tracking-[0.2em] text-accent">
                MineUI
              </h1>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Chip variant="soft" color="accent">
                {isSimple ? "Simple mode" : "Advanced mode"}
              </Chip>
              {!needsOnboarding && (
                <>
                  {/* Signature moment: brief scale/glow on every stopped→
                      starting→running (etc.) transition, keyed to
                      --motion-base. Remounting on phase change is what
                      drives the "enter" animation below — no loop. */}
                  <motion.span
                    key={serverState?.phase ?? "unknown"}
                    className="inline-flex"
                    initial={{ opacity: 0, scale: 0.92, filter: "brightness(1.5)" }}
                    animate={{ opacity: 1, scale: 1, filter: "brightness(1)" }}
                    transition={transition("base")}
                  >
                    <Chip
                      variant="soft"
                      color={phaseChipColor(serverState?.phase)}
                    >
                      Server: {phaseLabel(serverState?.phase)}
                    </Chip>
                  </motion.span>
                  <Chip
                    variant="soft"
                    color={serverOnline ? "success" : "warning"}
                  >
                    {serverOnline ? (
                      <span className="flex items-center gap-1.5">
                        {/* The one sanctioned ambient loop on this screen
                            (docs/theme-contract.md §6 / audit finding) —
                            everything else on this page is state-triggered
                            or static. Reduced-motion guard: globals.css
                            "motion" section. */}
                        <span
                          className="inline-block h-2 w-2 rounded-full animate-pulse bg-accent"
                        />
                        Online
                      </span>
                    ) : (
                      "Offline"
                    )}
                  </Chip>
                  <Button
                    onPress={handleRefresh}
                    isDisabled={busy}
                    onMouseEnter={() => play("hover")}
                  >
                    <RefreshCcw size={16} className={busy ? "animate-spin" : ""} />
                    <span className="hidden sm:inline">Refresh</span>
                  </Button>
                  <Button
                    variant="tertiary"
                    onPress={() => runAction(createBackup, "Backup")}
                    isDisabled={busy}
                    onMouseEnter={() => play("hover")}
                  >
                    <Archive size={16} />
                    <span className="hidden sm:inline">Backup</span>
                  </Button>
                </>
              )}
            </div>
          </div>
        </motion.header>

        {needsOnboarding ? (
          <CreateServerFlow
            defaultMemoryMb={settings?.simple.memoryMb ?? 2048}
            onCreated={() => {
              setLoading(true);
              bootstrap();
            }}
          />
        ) : (
          <>
            <motion.section variants={cardMotion}>
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
                      (remounts via `key`), then settles — state-change-
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
                        "color-mix(in oklab, var(--background) 70%, black)",
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

            <motion.section
              className="grid gap-6 md:grid-cols-3"
              variants={containerMotion}
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
                      <div className="text-lg font-semibold">
                        {serverOnline ? "Online" : "Offline"}
                      </div>
                      <div className="text-muted">
                        Version: {status?.version ?? "unknown"}
                      </div>
                      <div className="text-muted">
                        MOTD: {status?.motd ?? "—"}
                      </div>
                      <div className="text-muted font-pixel-num">
                        Ping: {status?.pingMs != null ? `${status.pingMs}ms` : "—"}
                      </div>
                    </div>
                  </KPI.Content>
                  <KPI.Footer className="mt-auto flex flex-wrap gap-2 pt-4">
                    <Button
                      onPress={() => runAction(startServer, "Start")}
                      isDisabled={
                        busy ||
                        serverState?.phase === "running" ||
                        serverState?.phase === "starting"
                      }
                      onMouseEnter={() => play("hover")}
                    >
                      {busy ? (
                        <Loader2 size={16} className="animate-spin" />
                      ) : (
                        <Play size={16} />
                      )}
                      Start
                    </Button>
                    <Button
                      variant="danger"
                      onPress={() => runAction(stopServer, "Stop")}
                      isDisabled={busy}
                      onMouseEnter={() => play("hover")}
                    >
                      <Square size={16} />
                      Stop
                    </Button>
                    <Button
                      variant="tertiary"
                      onPress={() => runAction(restartServer, "Restart")}
                      isDisabled={busy}
                      onMouseEnter={() => play("hover")}
                    >
                      <RefreshCcw size={16} />
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
      </motion.main>
    </div>
  );
}
