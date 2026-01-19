"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Activity,
  Archive,
  Boxes,
  Play,
  RefreshCcw,
  ScrollText,
  Server,
  Square,
  Users,
} from "lucide-react";

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
  };

  useEffect(() => {
    refreshAll();
    const interval = setInterval(() => {
      refreshAll();
    }, 8000);
    return () => clearInterval(interval);
  }, []);

  const handleAction = async (path: string) => {
    setBusy(true);
    try {
      const res = await fetch(path, { method: "POST" });
      if (!res.ok) throw new Error("Action failed");
      await refreshAll();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(29,68,38,0.55),_transparent_60%)] mc-grid">
      <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-6 px-6 py-10">
        <header className="flex flex-col gap-2">
          <span className="mc-subtitle">Home Server Control</span>
          <div className="flex flex-wrap items-end justify-between gap-4">
            <h1 className="mc-title mc-glow">MineUI</h1>
            <div className="flex items-center gap-3">
              <span className="mc-chip">
                Container: {container?.status ?? "unknown"}
              </span>
              <span className="mc-chip">
                Server: {serverOnline ? "online" : "offline"}
              </span>
              <button
                className="mc-button"
                onClick={() => refreshAll()}
                disabled={busy}
              >
                <RefreshCcw size={16} />
                Refresh
              </button>
            </div>
          </div>
        </header>

        <section className="grid gap-6 md:grid-cols-3">
          <div className="mc-panel p-5">
            <div className="flex items-center gap-3 text-sm text-emerald-200">
              <Server size={18} />
              Status
            </div>
            <div className="mt-4 flex flex-col gap-2">
              <div className="text-lg font-semibold">
                {serverOnline ? "Online" : "Offline"}
              </div>
              <div className="text-sm text-emerald-200/80">
                Version: {status?.version ?? "unknown"}
              </div>
              <div className="text-sm text-emerald-200/80">
                MOTD: {status?.motd ?? "—"}
              </div>
              <div className="text-sm text-emerald-200/80">
                Ping: {status?.ping ? `${status.ping}ms` : "—"}
              </div>
            </div>
            <div className="mt-5 flex flex-wrap gap-2">
              <button
                className="mc-button"
                onClick={() => handleAction("/api/server/start")}
                disabled={busy}
              >
                <Play size={16} />
                Start
              </button>
              <button
                className="mc-button"
                onClick={() => handleAction("/api/server/stop")}
                disabled={busy}
              >
                <Square size={16} />
                Stop
              </button>
              <button
                className="mc-button"
                onClick={() => handleAction("/api/backup")}
                disabled={busy}
              >
                <Archive size={16} />
                Backup
              </button>
            </div>
          </div>

          <div className="mc-panel p-5">
            <div className="flex items-center gap-3 text-sm text-emerald-200">
              <Users size={18} />
              Players
            </div>
            <div className="mt-4 flex items-center gap-3">
              <span className="text-3xl font-semibold">
                {playerCount}/{maxPlayers || "?"}
              </span>
              <span className="text-sm text-emerald-200/80">
                Online right now
              </span>
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {playerCount === 0 ? (
                <span className="text-sm text-emerald-200/70">
                  No players online
                </span>
              ) : (
                <span className="mc-chip">{playerCount} online</span>
              )}
            </div>
            <Link className="mc-button mt-4 w-fit" href="/players">
              View player details
            </Link>
          </div>

          <div className="mc-panel p-5">
            <div className="flex items-center gap-3 text-sm text-emerald-200">
              <Boxes size={18} />
              Mods & Plugins
            </div>
            <div className="mt-4 grid gap-3 text-sm text-emerald-200/80">
              <div>
                <div className="text-xs uppercase tracking-[0.25em] text-emerald-200/60">
                  Mods
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <span className="mc-chip">
                    {mods?.mods?.length ?? 0} total
                  </span>
                </div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-[0.25em] text-emerald-200/60">
                  Plugins
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <span className="mc-chip">
                    {mods?.plugins?.length ?? 0} total
                  </span>
                </div>
              </div>
              <Link className="mc-button w-fit" href="/mods">
                View mods & plugins
              </Link>
            </div>
          </div>
        </section>

        <section className="mc-panel p-5">
          <div className="flex items-center gap-3 text-sm text-emerald-200">
            <ScrollText size={18} />
            Server Logs
          </div>
          <div className="mt-4 max-h-[420px] overflow-auto rounded-lg border border-emerald-900/60 bg-black/70 p-4 text-xs leading-5 text-emerald-100/90">
            {logs?.lines?.length ? (
              <pre className="whitespace-pre-wrap">
                {logs.lines.join("\n")}
              </pre>
            ) : (
              <div className="flex items-center gap-2 text-emerald-200/70">
                <Activity size={16} />
                Waiting for logs...
              </div>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
