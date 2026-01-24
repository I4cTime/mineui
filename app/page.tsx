"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { motion } from "motion/react";
import { toast } from "sonner";
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
import { Button, ButtonGroup, Card, Chip, Separator } from "@heroui/react";
import { useUISound } from "@/app/hooks/useUISound";
import { SkeletonCard } from "@/app/components/Skeleton";

type ContainerState = {
  exists: boolean;
  running: boolean;
  status: string | null;
  id: string | null;
  createdAt: string | null;
};

type StatusResponse = {
  online: boolean;
  version?: string | null;
  motd?: string | null;
  players?: { online: number; max: number; sample: Array<{ name: string }> };
  ping?: number | null;
  error?: string;
};

type LogsResponse = {
  ok: boolean;
  lines: string[];
};

type ModsResponse = {
  mods: Array<{
    name: string;
    filename: string;
    sizeBytes: number;
    updatedAt: number;
    loader: "forge" | "neoforge" | "fabric" | "unknown";
  }>;
  plugins: Array<{
    name: string;
    filename: string;
    sizeBytes: number;
    updatedAt: number;
    loader: "forge" | "neoforge" | "fabric" | "unknown";
  }>;
};

const fetchJson = async <T,>(path: string): Promise<T> => {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json() as Promise<T>;
};

export default function Home() {
  const router = useRouter();
  const [container, setContainer] = useState<ContainerState | null>(null);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [logs, setLogs] = useState<LogsResponse | null>(null);
  const [mods, setMods] = useState<ModsResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const logsRef = useRef<HTMLDivElement>(null);
  const { play } = useUISound();

  const serverOnline = status?.online ?? false;
  const playerCount = status?.players?.online ?? 0;
  const maxPlayers = status?.players?.max ?? 0;

  const refreshAll = async () => {
    const [containerState, statusState, logState, modState] =
      await Promise.allSettled([
        fetchJson<ContainerState>("/api/server/state"),
        fetchJson<StatusResponse>("/api/status"),
        fetchJson<LogsResponse>("/api/logs?tail=200"),
        fetchJson<ModsResponse>("/api/mods"),
      ]);
    if (containerState.status === "fulfilled") {
      setContainer(containerState.value);
    }
    if (statusState.status === "fulfilled") {
      setStatus(statusState.value);
    }
    if (logState.status === "fulfilled") {
      setLogs(logState.value);
    }
    if (modState.status === "fulfilled") {
      setMods(modState.value);
    }
    setLoading(false);
  };

  useEffect(() => {
    refreshAll();
    const interval = setInterval(() => {
      refreshAll();
    }, 8000);
    return () => clearInterval(interval);
  }, []);

  // Auto-scroll logs to bottom
  useEffect(() => {
    if (logsRef.current) {
      logsRef.current.scrollTop = logsRef.current.scrollHeight;
    }
  }, [logs]);

  const handleAction = async (path: string, label: string) => {
    play("click_confirm");
    setBusy(true);
    try {
      const res = await fetch(path, { method: "POST" });
      if (!res.ok) throw new Error("Action failed");
      play("success");
      toast.success(`${label} completed`);
      await refreshAll();
    } catch {
      play("error");
      toast.error(`${label} failed`);
    } finally {
      setBusy(false);
    }
  };

  const handleRefresh = () => {
    play("click_confirm");
    refreshAll();
  };

  const containerMotion = {
    hidden: { opacity: 0, y: 12 },
    show: {
      opacity: 1,
      y: 0,
      transition: { staggerChildren: 0.08, duration: 0.4 },
    },
  };

  const cardMotion = {
    hidden: { opacity: 0, y: 14, scale: 0.98 },
    show: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.35 } },
  };

  if (loading) {
    return (
      <div className="min-h-screen" style={{ background: "var(--background)" }}>
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
          <span className="text-xs uppercase tracking-[0.3em] text-[var(--muted)]">
            Home Server Control
          </span>
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="relative">
              <motion.div
                className="absolute -inset-4 rounded-full"
                style={{
                  background:
                    "radial-gradient(circle, color-mix(in oklab, var(--accent) 25%, transparent), transparent 70%)",
                }}
                animate={{ opacity: [0.2, 0.6, 0.3] }}
                transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
              />
              <h1 className="font-pixel text-2xl uppercase tracking-[0.2em] text-[var(--accent)]">
                MineUI
              </h1>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Chip
                variant="soft"
                color={container?.running ? "accent" : "default"}
              >
                Container: {container?.status ?? "unknown"}
              </Chip>
              <Chip
                variant="soft"
                color={serverOnline ? "success" : "warning"}
              >
                {serverOnline ? (
                  <span className="flex items-center gap-1.5">
                    <span
                      className="inline-block h-2 w-2 rounded-full animate-pulse"
                      style={{ background: "var(--accent)" }}
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
                onPress={() => handleAction("/api/backup", "Backup")}
                isDisabled={busy}
                onMouseEnter={() => play("hover")}
              >
                <Archive size={16} />
                <span className="hidden sm:inline">Backup</span>
              </Button>
            </div>
          </div>
        </motion.header>

        <motion.section variants={cardMotion}>
          <Card className="p-5">
            <Card.Header className="flex flex-row items-center justify-between gap-3">
              <div className="flex items-center gap-3 text-sm text-[var(--accent)]">
                <ScrollText size={18} />
                <span className="font-pixel text-xs tracking-wide">Server Logs</span>
              </div>
              <motion.div
                className="h-2 w-2 rounded-full"
                style={{ background: "var(--accent)" }}
                animate={{ opacity: [0.3, 1, 0.3] }}
                transition={{ duration: 2, repeat: Infinity }}
              />
            </Card.Header>
            <Card.Content>
              <div
                ref={logsRef}
                className="mt-4 max-h-[420px] overflow-auto rounded-lg border p-4 text-xs leading-5 font-mono"
                style={{
                  background:
                    "color-mix(in oklab, var(--background) 70%, black)",
                  borderColor: "var(--border)",
                  color: "var(--foreground)",
                }}
              >
                {logs?.lines?.length ? (
                  <pre className="whitespace-pre-wrap">
                    {logs.lines.join("\n")}
                  </pre>
                ) : (
                  <div
                    className="flex items-center gap-2"
                    style={{ color: "var(--muted)" }}
                  >
                    <Activity size={16} />
                    Waiting for logs...
                  </div>
                )}
              </div>
            </Card.Content>
          </Card>
        </motion.section>

        <motion.section className="grid gap-6 md:grid-cols-3" variants={containerMotion}>
          <motion.div variants={cardMotion}>
            <Card className="flex h-full flex-col p-5">
              <Card.Header className="flex items-center gap-3 text-sm text-[var(--accent)]">
                <Server size={18} />
                <span className="font-pixel text-xs tracking-wide">Status</span>
              </Card.Header>
              <Card.Content className="mt-4 flex flex-1 flex-col gap-2 text-sm">
                <div className="text-lg font-semibold">
                  {serverOnline ? "Online" : "Offline"}
                </div>
                <div className="text-[var(--muted)]">
                  Version: {status?.version ?? "unknown"}
                </div>
                <div className="text-[var(--muted)]">
                  MOTD: {status?.motd ?? "—"}
                </div>
                <div className="text-[var(--muted)]">
                  Ping: {status?.ping ? `${status.ping}ms` : "—"}
                </div>
              </Card.Content>
              <Card.Footer className="mt-auto flex flex-wrap gap-2 pt-4">

                <Button
                  onPress={() => handleAction("/api/server/start", "Start")}
                  isDisabled={busy}
                  onMouseEnter={() => play("hover")}
                >
                  {busy ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
                  Start
                </Button>
                <Button
                  variant="danger"
                  onPress={() => handleAction("/api/server/stop", "Stop")}
                  isDisabled={busy}
                  onMouseEnter={() => play("hover")}
                >
                  <Square size={16} />
                  Stop
                </Button>
                <Button
                  variant="tertiary"
                  onPress={() => handleAction("/api/server/restart", "Restart")}
                  isDisabled={busy}
                  onMouseEnter={() => play("hover")}
                >
                  <RefreshCcw size={16} />
                  Restart
                </Button>
              </Card.Footer>
            </Card>
          </motion.div>

          <motion.div variants={cardMotion}>
            <Card className="flex h-full flex-col p-5">
              <Card.Header className="flex items-center gap-3 text-sm text-[var(--accent)]">
                <Users size={18} />
                <span className="font-pixel text-xs tracking-wide">Players</span>
              </Card.Header>
              <Card.Content className="mt-4 flex flex-1 flex-col">
                <div className="flex items-center gap-3">
                  <span className="font-pixel text-2xl text-[var(--accent)]">
                    {playerCount}/{maxPlayers || "?"}
                  </span>
                  <span className="text-sm text-[var(--muted)]">Online now</span>
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  {playerCount === 0 ? (
                    <span className="text-sm text-[var(--muted)]">
                      No players online
                    </span>
                  ) : (
                    <Chip variant="soft" color="accent">
                      {playerCount} online
                    </Chip>
                  )}
                </div>
              </Card.Content>
              <Card.Footer className="mt-auto pt-4">
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
              </Card.Footer>
            </Card>
          </motion.div>

          <motion.div variants={cardMotion}>
            <Card className="flex h-full flex-col p-5">
              <Card.Header className="flex items-center gap-3 text-sm text-[var(--accent)]">
                <Boxes size={18} />
                <span className="font-pixel text-xs tracking-wide">Mods & Plugins</span>
              </Card.Header>
              <Card.Content className="mt-4 flex flex-1 flex-col gap-3 text-sm">
                <div>
                  <div className="text-[10px] uppercase tracking-[0.2em] text-[var(--muted)]">
                    Mods
                  </div>
                  <div className="mt-2">
                    <Chip variant="soft">{mods?.mods?.length ?? 0} total</Chip>
                  </div>
                </div>
                <Separator />
                <div>
                  <div className="text-[10px] uppercase tracking-[0.2em] text-[var(--muted)]">
                    Plugins
                  </div>
                  <div className="mt-2">
                    <Chip variant="soft">{mods?.plugins?.length ?? 0} total</Chip>
                  </div>
                </div>
              </Card.Content>
              <Card.Footer className="mt-auto pt-4">
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
              </Card.Footer>
            </Card>
          </motion.div>
        </motion.section>
      </motion.main>
    </div>
  );
}
