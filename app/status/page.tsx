"use client";

import { useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import {
  Activity,
  Cpu,
  Database,
  Gauge,
  HardDrive,
  Network,
  Timer,
} from "lucide-react";
import PageHeader from "@/app/components/PageHeader";
import ProgressRing from "@/app/components/ProgressRing";
import { SkeletonCard } from "@/app/components/Skeleton";
import { useUISound } from "@/app/hooks/useUISound";

type StatusResponse = {
  online: boolean;
  version?: string | null;
  motd?: string | null;
  players?: { online: number; max: number };
  ping?: number | null;
  error?: string;
};

type MetricsResponse = {
  ok: boolean;
  cpuPercent: number | null;
  memPercent: number | null;
  memUsage: { usedBytes: number | null; totalBytes: number | null };
  netIO: { inputBytes: number | null; outputBytes: number | null };
  blockIO: { inputBytes: number | null; outputBytes: number | null };
  disk: { usedBytes: number | null; totalBytes: number | null; percent: number | null };
  uptime: string | null;
  tps: { one: number; five: number; fifteen: number; raw: string } | null;
  chunks: number | null;
  entities: number | null;
  error?: string;
};

type ContainerState = {
  exists: boolean;
  running: boolean;
  status: string | null;
  id: string | null;
  createdAt: string | null;
};

const fetchJson = async <T,>(path: string): Promise<T> => {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json() as Promise<T>;
};

const formatBytes = (value: number | null) => {
  if (!value) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
};

const formatPercent = (value: number | null) =>
  value === null ? "—" : `${value.toFixed(1)}%`;

const formatUptime = (value: string | null) => {
  if (!value) return "—";
  const started = new Date(value);
  if (Number.isNaN(started.getTime())) return value;
  const diff = Date.now() - started.getTime();
  const hours = Math.floor(diff / 3_600_000);
  const minutes = Math.floor((diff % 3_600_000) / 60_000);
  return `${hours}h ${minutes}m`;
};

const containerMotion = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.1 },
  },
};

const cardMotion = {
  hidden: { opacity: 0, y: 20 },
  show: { opacity: 1, y: 0 },
};

export default function StatusPage() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [metrics, setMetrics] = useState<MetricsResponse | null>(null);
  const [container, setContainer] = useState<ContainerState | null>(null);
  const [loading, setLoading] = useState(true);
  const { play } = useUISound();

  useEffect(() => {
    Promise.allSettled([
      fetchJson<StatusResponse>("/api/status"),
      fetchJson<MetricsResponse>("/api/server/metrics"),
      fetchJson<ContainerState>("/api/server/state"),
    ]).then(([statusRes, metricsRes, containerRes]) => {
      if (statusRes.status === "fulfilled") setStatus(statusRes.value);
      else setStatus({ online: false });
      if (metricsRes.status === "fulfilled") setMetrics(metricsRes.value);
      if (containerRes.status === "fulfilled") setContainer(containerRes.value);
      setLoading(false);
    });
  }, []);

  const tpsDisplay = useMemo(() => {
    if (!metrics?.tps) return "—";
    if (!Number.isFinite(metrics.tps.one)) return metrics.tps.raw;
    return `${metrics.tps.one.toFixed(1)} / ${metrics.tps.five.toFixed(1)} / ${metrics.tps.fifteen.toFixed(1)}`;
  }, [metrics]);

  if (loading) {
    return (
      <div className="min-h-screen mc-grid" style={{ background: "var(--background)" }}>
        <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-6 px-4 py-10 md:px-6">
          <div className="h-16" />
          <div className="grid gap-6 md:grid-cols-3">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <SkeletonCard key={i} />
            ))}
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
        <PageHeader title="Server Status" icon={Gauge} />

        {/* Performance Rings */}
        <motion.section
          className="mc-panel flex flex-wrap items-center justify-center gap-8 p-6"
          variants={cardMotion}
        >
          <ProgressRing
            value={metrics?.cpuPercent ?? 0}
            label={formatPercent(metrics?.cpuPercent ?? null)}
            sublabel="CPU"
            size={110}
          />
          <ProgressRing
            value={metrics?.memPercent ?? 0}
            label={formatPercent(metrics?.memPercent ?? null)}
            sublabel="Memory"
            size={110}
          />
          <ProgressRing
            value={metrics?.disk?.percent ?? 0}
            label={formatPercent(metrics?.disk?.percent ?? null)}
            sublabel="Disk"
            size={110}
          />
          <ProgressRing
            value={Math.min((metrics?.tps?.one ?? 0) * 5, 100)}
            label={metrics?.tps?.one != null ? metrics.tps.one.toFixed(1) : "—"}
            sublabel="TPS"
            size={110}
          />
        </motion.section>

        <motion.section className="grid gap-6 md:grid-cols-3" variants={containerMotion}>
          <motion.div className="mc-panel p-5" variants={cardMotion}>
            <div className="flex items-center gap-3 text-sm" style={{ color: "var(--mc-accent)" }}>
              <Activity size={18} />
              <span className="font-pixel text-xs tracking-wide">Game Status</span>
            </div>
            <div className="mt-4 grid gap-2 text-sm" style={{ color: "var(--mc-muted)" }}>
              <div className="flex justify-between">
                <span>Online:</span>
                <span style={{ color: status?.online ? "var(--mc-accent)" : "inherit" }}>
                  {status?.online ? "Yes" : "No"}
                </span>
              </div>
              <div className="flex justify-between">
                <span>Version:</span>
                <span>{status?.version ?? "—"}</span>
              </div>
              <div className="flex justify-between">
                <span>Players:</span>
                <span>{status?.players?.online ?? 0}/{status?.players?.max ?? "?"}</span>
              </div>
              <div className="flex justify-between">
                <span>Ping:</span>
                <span>{status?.ping ? `${status.ping}ms` : "—"}</span>
              </div>
              <div className="flex justify-between">
                <span>MOTD:</span>
                <span className="truncate max-w-[150px]">{status?.motd ?? "—"}</span>
              </div>
            </div>
          </motion.div>

          <motion.div className="mc-panel p-5" variants={cardMotion}>
            <div className="flex items-center gap-3 text-sm" style={{ color: "var(--mc-accent)" }}>
              <Timer size={18} />
              <span className="font-pixel text-xs tracking-wide">Uptime & TPS</span>
            </div>
            <div className="mt-4 grid gap-2 text-sm" style={{ color: "var(--mc-muted)" }}>
              <div className="flex justify-between">
                <span>Container:</span>
                <span>{container?.status ?? "unknown"}</span>
              </div>
              <div className="flex justify-between">
                <span>Uptime:</span>
                <span>{formatUptime(metrics?.uptime ?? null)}</span>
              </div>
              <div className="flex justify-between">
                <span>TPS:</span>
                <span className="text-xs">{tpsDisplay}</span>
              </div>
              <div className="flex justify-between">
                <span>Chunks:</span>
                <span>{metrics?.chunks ?? "—"}</span>
              </div>
              <div className="flex justify-between">
                <span>Entities:</span>
                <span>{metrics?.entities ?? "—"}</span>
              </div>
            </div>
          </motion.div>

          <motion.div className="mc-panel p-5" variants={cardMotion}>
            <div className="flex items-center gap-3 text-sm" style={{ color: "var(--mc-accent)" }}>
              <Cpu size={18} />
              <span className="font-pixel text-xs tracking-wide">Compute</span>
            </div>
            <div className="mt-4 grid gap-2 text-sm" style={{ color: "var(--mc-muted)" }}>
              <div className="flex justify-between">
                <span>CPU Load:</span>
                <span>{formatPercent(metrics?.cpuPercent ?? null)}</span>
              </div>
              <div className="flex justify-between">
                <span>Memory:</span>
                <span>
                  {formatBytes(metrics?.memUsage?.usedBytes ?? null)} / {formatBytes(metrics?.memUsage?.totalBytes ?? null)}
                </span>
              </div>
              <div className="flex justify-between">
                <span>Memory %:</span>
                <span>{formatPercent(metrics?.memPercent ?? null)}</span>
              </div>
            </div>
          </motion.div>
        </motion.section>

        <motion.section className="grid gap-6 md:grid-cols-3" variants={containerMotion}>
          <motion.div className="mc-panel p-5" variants={cardMotion}>
            <div className="flex items-center gap-3 text-sm" style={{ color: "var(--mc-accent)" }}>
              <Network size={18} />
              <span className="font-pixel text-xs tracking-wide">Network</span>
            </div>
            <div className="mt-4 grid gap-2 text-sm" style={{ color: "var(--mc-muted)" }}>
              <div className="flex justify-between">
                <span>Inbound:</span>
                <span>{formatBytes(metrics?.netIO?.inputBytes ?? null)}</span>
              </div>
              <div className="flex justify-between">
                <span>Outbound:</span>
                <span>{formatBytes(metrics?.netIO?.outputBytes ?? null)}</span>
              </div>
            </div>
          </motion.div>

          <motion.div className="mc-panel p-5" variants={cardMotion}>
            <div className="flex items-center gap-3 text-sm" style={{ color: "var(--mc-accent)" }}>
              <Database size={18} />
              <span className="font-pixel text-xs tracking-wide">Disk I/O</span>
            </div>
            <div className="mt-4 grid gap-2 text-sm" style={{ color: "var(--mc-muted)" }}>
              <div className="flex justify-between">
                <span>Read:</span>
                <span>{formatBytes(metrics?.blockIO?.inputBytes ?? null)}</span>
              </div>
              <div className="flex justify-between">
                <span>Write:</span>
                <span>{formatBytes(metrics?.blockIO?.outputBytes ?? null)}</span>
              </div>
            </div>
          </motion.div>

          <motion.div className="mc-panel p-5" variants={cardMotion}>
            <div className="flex items-center gap-3 text-sm" style={{ color: "var(--mc-accent)" }}>
              <HardDrive size={18} />
              <span className="font-pixel text-xs tracking-wide">Disk Usage</span>
            </div>
            <div className="mt-4 grid gap-2 text-sm" style={{ color: "var(--mc-muted)" }}>
              <div className="flex justify-between">
                <span>Used:</span>
                <span>
                  {formatBytes(metrics?.disk?.usedBytes ?? null)} / {formatBytes(metrics?.disk?.totalBytes ?? null)}
                </span>
              </div>
              <div className="flex justify-between">
                <span>Usage:</span>
                <span>{formatPercent(metrics?.disk?.percent ?? null)}</span>
              </div>
            </div>
          </motion.div>
        </motion.section>
      </motion.main>
    </div>
  );
}
