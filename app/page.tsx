"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
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
      <div className="min-h-screen mc-grid" style={{ background: "var(--background)" }}>
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
      className="min-h-screen mc-grid"
      style={{
        background: `radial-gradient(circle at top, var(--mc-accent-soft), transparent 60%), var(--background)`,
      }}
    >
      <motion.main
        className="mx-auto flex min-h-screen max-w-6xl flex-col gap-6 px-4 py-10 md:px-6"
        initial="hidden"
        animate="show"
        variants={containerMotion}
      >
        <motion.header className="flex flex-col gap-2" variants={cardMotion}>
          <span className="mc-subtitle">Home Server Control</span>
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div className="relative">
              <motion.div
                className="absolute -inset-4 rounded-full"
                style={{
                  background: "radial-gradient(circle, var(--mc-accent-soft), transparent 70%)",
                }}
                animate={{ opacity: [0.2, 0.6, 0.3] }}
                transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
              />
              <h1 className="mc-title mc-glow relative">MineUI</h1>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <motion.span
                className="mc-chip"
                animate={{
                  borderColor: container?.running
                    ? "var(--mc-accent)"
                    : "var(--mc-panel-border)",
                }}
              >
                Container: {container?.status ?? "unknown"}
              </motion.span>
              <motion.span
                className="mc-chip"
                animate={{
                  borderColor: serverOnline
                    ? "var(--mc-accent)"
                    : "var(--mc-panel-border)",
                }}
              >
                {serverOnline ? (
                  <span className="flex items-center gap-1.5">
                    <span
                      className="inline-block h-2 w-2 rounded-full animate-pulse"
                      style={{ background: "var(--mc-accent)" }}
                    />
                    Online
                  </span>
                ) : (
                  "Offline"
                )}
              </motion.span>
              <button
                className="mc-button"
                onClick={handleRefresh}
                disabled={busy}
                onMouseEnter={() => play("hover")}
              >
                <RefreshCcw size={16} className={busy ? "animate-spin" : ""} />
                <span className="hidden sm:inline">Refresh</span>
              </button>
            </div>
          </div>
        </motion.header>

        <motion.section className="mc-panel p-5" variants={cardMotion}>
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 text-sm" style={{ color: "var(--mc-accent)" }}>
              <ScrollText size={18} />
              <span className="font-pixel text-xs tracking-wide">Server Logs</span>
            </div>
            <motion.div
              className="h-2 w-2 rounded-full"
              style={{ background: "var(--mc-accent)" }}
              animate={{ opacity: [0.3, 1, 0.3] }}
              transition={{ duration: 2, repeat: Infinity }}
            />
          </div>
          <div
            ref={logsRef}
            className="mt-4 max-h-[420px] overflow-auto rounded-lg border p-4 text-xs leading-5 font-mono"
            style={{
              background: "color-mix(in oklab, var(--background) 70%, black)",
              borderColor: "var(--mc-panel-border)",
              color: "var(--foreground)",
            }}
          >
            {logs?.lines?.length ? (
              <pre className="whitespace-pre-wrap">{logs.lines.join("\n")}</pre>
            ) : (
              <div className="flex items-center gap-2" style={{ color: "var(--mc-muted)" }}>
                <Activity size={16} />
                Waiting for logs...
              </div>
            )}
          </div>
        </motion.section>

        <motion.section className="grid gap-6 md:grid-cols-3" variants={containerMotion}>
          <motion.div className="mc-panel flex flex-col p-5" variants={cardMotion}>
            <div className="flex items-center gap-3 text-sm" style={{ color: "var(--mc-accent)" }}>
              <Server size={18} />
              <span className="font-pixel text-xs tracking-wide">Status</span>
            </div>
            <div className="mt-4 flex flex-1 flex-col gap-2">
              <div className="text-lg font-semibold" style={{ color: "var(--foreground)" }}>
                {serverOnline ? "Online" : "Offline"}
              </div>
              <div className="text-sm" style={{ color: "var(--mc-muted)" }}>
                Version: {status?.version ?? "unknown"}
              </div>
              <div className="text-sm" style={{ color: "var(--mc-muted)" }}>
                MOTD: {status?.motd ?? "—"}
              </div>
              <div className="text-sm" style={{ color: "var(--mc-muted)" }}>
                Ping: {status?.ping ? `${status.ping}ms` : "—"}
              </div>
            </div>
            <div className="mt-auto flex flex-wrap gap-2 pt-4">
              <button
                className="mc-button"
                onClick={() => handleAction("/api/server/start", "Start")}
                disabled={busy}
                onMouseEnter={() => play("hover")}
              >
                {busy ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
                Start
              </button>
              <button
                className="mc-button"
                onClick={() => handleAction("/api/server/stop", "Stop")}
                disabled={busy}
                onMouseEnter={() => play("hover")}
              >
                <Square size={16} />
                Stop
              </button>
              <button
                className="mc-button"
                onClick={() => handleAction("/api/backup", "Backup")}
                disabled={busy}
                onMouseEnter={() => play("hover")}
              >
                <Archive size={16} />
                Backup
              </button>
            </div>
          </motion.div>

          <motion.div className="mc-panel flex flex-col p-5" variants={cardMotion}>
            <div className="flex items-center gap-3 text-sm" style={{ color: "var(--mc-accent)" }}>
              <Users size={18} />
              <span className="font-pixel text-xs tracking-wide">Players</span>
            </div>
            <div className="mt-4 flex flex-1 flex-col">
              <div className="flex items-center gap-3">
                <span className="font-pixel text-2xl" style={{ color: "var(--mc-accent)" }}>
                  {playerCount}/{maxPlayers || "?"}
                </span>
                <span className="text-sm" style={{ color: "var(--mc-muted)" }}>
                  Online now
                </span>
              </div>
              <div className="mt-4 flex flex-wrap gap-2">
                {playerCount === 0 ? (
                  <span className="text-sm" style={{ color: "var(--mc-muted)" }}>
                    No players online
                  </span>
                ) : (
                  <span className="mc-chip">{playerCount} online</span>
                )}
              </div>
            </div>
            <Link
              className="mc-button mt-auto w-fit pt-4"
              href="/players"
              onClick={() => play("click_confirm")}
              onMouseEnter={() => play("hover")}
            >
              View players
            </Link>
          </motion.div>

          <motion.div className="mc-panel flex flex-col p-5" variants={cardMotion}>
            <div className="flex items-center gap-3 text-sm" style={{ color: "var(--mc-accent)" }}>
              <Boxes size={18} />
              <span className="font-pixel text-xs tracking-wide">Mods & Plugins</span>
            </div>
            <div className="mt-4 flex flex-1 flex-col gap-3 text-sm">
              <div>
                <div className="mc-subtitle text-[10px]">Mods</div>
                <div className="mt-2">
                  <span className="mc-chip">{mods?.mods?.length ?? 0} total</span>
                </div>
              </div>
              <div>
                <div className="mc-subtitle text-[10px]">Plugins</div>
                <div className="mt-2">
                  <span className="mc-chip">{mods?.plugins?.length ?? 0} total</span>
                </div>
              </div>
            </div>
            <Link
              className="mc-button mt-auto w-fit pt-4"
              href="/mods"
              onClick={() => play("click_confirm")}
              onMouseEnter={() => play("hover")}
            >
              View mods
            </Link>
          </motion.div>
        </motion.section>
      </motion.main>
    </div>
  );
}
