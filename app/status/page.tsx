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
import { Card, Chip } from "@heroui/react";
import PageHeader from "@/app/components/PageHeader";
import ProgressRing from "@/app/components/ProgressRing";
import { SkeletonCard } from "@/app/components/Skeleton";
import {
  getMetrics,
  getServerState,
  getServerStatus,
  onServerState,
  type Metrics,
  type ServerState,
  type ServerStatus,
} from "@/app/lib/ipc";

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

const formatMspt = (value: number | null) =>
  value === null ? "—" : `${value.toFixed(2)} ms`;

const formatUptime = (metrics: Metrics | null) => {
  if (!metrics) return "—";
  let seconds = metrics.uptimeSeconds;
  if (seconds === null && metrics.startedAt) {
    const started = new Date(metrics.startedAt);
    if (!Number.isNaN(started.getTime())) {
      seconds = Math.max(0, Math.floor((Date.now() - started.getTime()) / 1000));
    }
  }
  if (seconds === null) return "—";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
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
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [serverState, setServerState] = useState<ServerState | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchAll = () => {
      Promise.allSettled([
        getServerStatus(),
        getMetrics(),
        getServerState(),
      ]).then(([statusRes, metricsRes, stateRes]) => {
        if (statusRes.status === "fulfilled") setStatus(statusRes.value);
        if (metricsRes.status === "fulfilled") setMetrics(metricsRes.value);
        if (stateRes.status === "fulfilled") setServerState(stateRes.value);
        setLoading(false);
      });
    };

    fetchAll();
    const interval = setInterval(fetchAll, 30_000);

    let disposed = false;
    let unlisten: (() => void) | null = null;
    onServerState(() => fetchAll()).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });

    return () => {
      clearInterval(interval);
      disposed = true;
      unlisten?.();
    };
  }, []);

  const isSimple = serverState?.mode === "simple";

  const stateSummary = useMemo(() => {
    if (!serverState) return "unknown";
    if (serverState.mode === "advanced") {
      return serverState.container?.status ?? serverState.phase;
    }
    return serverState.process?.pid
      ? `${serverState.phase} (pid ${serverState.process.pid})`
      : serverState.phase;
  }, [serverState]);

  const tpsDisplay = useMemo(() => {
    if (!metrics?.tps) return "—";
    if (!Number.isFinite(metrics.tps.one)) return metrics.tps.raw;
    return `${metrics.tps.one.toFixed(1)} / ${metrics.tps.five.toFixed(1)} / ${metrics.tps.fifteen.toFixed(1)}`;
  }, [metrics]);

  const dimensionsDisplay = useMemo(() => {
    if (!metrics?.dimensions) return [];
    return Object.entries(metrics.dimensions);
  }, [metrics]);

  if (loading) {
    return (
      <div className="min-h-screen" style={{ background: "var(--background)" }}>
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
        <PageHeader title="Server Status" icon={Gauge} />

        {/* Performance Rings */}
        <motion.section variants={cardMotion}>
          <Card className="flex sm:flex-col md:flex-row justify-center gap-8 p-6">
            <ProgressRing
              value={metrics?.cpuPercent ?? 0}
              label={formatPercent(metrics?.cpuPercent ?? null)}
              sublabel="CPU"
              size={110}
            />
            <ProgressRing
              value={metrics?.mem.percent ?? 0}
              label={formatPercent(metrics?.mem.percent ?? null)}
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
          </Card>
        </motion.section>

        <motion.section className="grid gap-6 md:grid-cols-3" variants={containerMotion}>
          <motion.div variants={cardMotion}>
            <Card className="p-5 h-full">
              <Card.Header className="flex items-center gap-3 text-sm text-[var(--accent)]">
                <Activity size={18} />
                <span className="font-pixel text-xs tracking-wide">Game Status</span>
              </Card.Header>
              <Card.Content className="mt-4 grid gap-2 text-sm text-[var(--muted)]">
                <div className="flex justify-between items-center">
                  <span>Online:</span>
                  <Chip
                    size="sm"
                    variant="soft"
                    color={status?.online ? "success" : "warning"}
                  >
                    {status?.online ? "Yes" : "No"}
                  </Chip>
                </div>
                <div className="flex justify-between">
                  <span>Version:</span>
                  <span>{status?.version ?? "—"}</span>
                </div>
                <div className="flex justify-between">
                  <span>Players:</span>
                  <span>
                    {status?.players.online ?? 0}/{status?.players.max ?? "?"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Ping:</span>
                  <span>{status?.pingMs != null ? `${status.pingMs}ms` : "—"}</span>
                </div>
                <div className="flex justify-between">
                  <span>MOTD:</span>
                  <span className="truncate max-w-[150px]">{status?.motd ?? "—"}</span>
                </div>
                <div className="flex justify-between">
                  <span>Source:</span>
                  <span>{status?.source ?? "—"}</span>
                </div>
              </Card.Content>
            </Card>
          </motion.div>

          <motion.div variants={cardMotion}>
            <Card className="p-5 h-full">
              <Card.Header className="flex items-center gap-3 text-sm text-[var(--accent)]">
                <Timer size={18} />
                <span className="font-pixel text-xs tracking-wide">Uptime & TPS</span>
              </Card.Header>
              <Card.Content className="mt-4 grid gap-2 text-sm text-[var(--muted)]">
                <div className="flex justify-between">
                  <span>{isSimple ? "Process:" : "Container:"}</span>
                  <span className="truncate max-w-[170px]">{stateSummary}</span>
                </div>
                <div className="flex justify-between">
                  <span>Uptime:</span>
                  <span>{formatUptime(metrics)}</span>
                </div>
                <div className="flex justify-between">
                  <span>TPS:</span>
                  <span className="text-xs">{tpsDisplay}</span>
                </div>
                <div className="flex justify-between">
                  <span>MSPT:</span>
                  <span className="text-xs">
                    {metrics?.mspt
                      ? `${formatMspt(metrics.mspt.one)} / ${formatMspt(metrics.mspt.five)} / ${formatMspt(metrics.mspt.fifteen)}`
                      : "—"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Chunks:</span>
                  <span>{metrics?.chunks ?? "—"}</span>
                </div>
                <div className="flex justify-between">
                  <span>Entities:</span>
                  <span>{metrics?.entities ?? "—"}</span>
                </div>
              </Card.Content>
            </Card>
          </motion.div>

          <motion.div variants={cardMotion}>
            <Card className="p-5 h-full">
              <Card.Header className="flex items-center gap-3 text-sm text-[var(--accent)]">
                <Cpu size={18} />
                <span className="font-pixel text-xs tracking-wide">Compute</span>
              </Card.Header>
              <Card.Content className="mt-4 grid gap-2 text-sm text-[var(--muted)]">
                <div className="flex justify-between">
                  <span>Source:</span>
                  <span>
                    {metrics
                      ? `${metrics.base}${metrics.enriched ? " + utils" : ""}`
                      : "—"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>CPU Load:</span>
                  <span>{formatPercent(metrics?.cpuPercent ?? null)}</span>
                </div>
                <div className="flex justify-between">
                  <span>Memory:</span>
                  <span>
                    {formatBytes(metrics?.mem.usedBytes ?? null)} /{" "}
                    {formatBytes(metrics?.mem.totalBytes ?? null)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Memory %:</span>
                  <span>{formatPercent(metrics?.mem.percent ?? null)}</span>
                </div>
              </Card.Content>
            </Card>
          </motion.div>
        </motion.section>

        <motion.section className="grid gap-6 md:grid-cols-3" variants={containerMotion}>
          <motion.div variants={cardMotion}>
            <Card className="p-5">
              <Card.Header className="flex items-center gap-3 text-sm text-[var(--accent)]">
                <Network size={18} />
                <span className="font-pixel text-xs tracking-wide">Network</span>
              </Card.Header>
              <Card.Content className="mt-4 grid gap-2 text-sm text-[var(--muted)]">
                {metrics?.net ? (
                  <>
                    <div className="flex justify-between">
                      <span>Inbound:</span>
                      <span>{formatBytes(metrics.net.inputBytes)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Outbound:</span>
                      <span>{formatBytes(metrics.net.outputBytes)}</span>
                    </div>
                  </>
                ) : (
                  <span className="text-xs">
                    {isSimple
                      ? "Container network stats are available in Advanced mode."
                      : "—"}
                  </span>
                )}
              </Card.Content>
            </Card>
          </motion.div>

          <motion.div variants={cardMotion}>
            <Card className="p-5 h-full">
              <Card.Header className="flex items-center gap-3 text-sm text-[var(--accent)]">
                <Database size={18} />
                <span className="font-pixel text-xs tracking-wide">Disk I/O</span>
              </Card.Header>
              <Card.Content className="mt-4 grid gap-2 text-sm text-[var(--muted)]">
                {metrics?.block ? (
                  <>
                    <div className="flex justify-between">
                      <span>Read:</span>
                      <span>{formatBytes(metrics.block.inputBytes)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Write:</span>
                      <span>{formatBytes(metrics.block.outputBytes)}</span>
                    </div>
                  </>
                ) : (
                  <span className="text-xs">
                    {isSimple
                      ? "Container block-IO stats are available in Advanced mode."
                      : "—"}
                  </span>
                )}
              </Card.Content>
            </Card>
          </motion.div>

          <motion.div variants={cardMotion}>
            <Card className="p-5">
              <Card.Header className="flex items-center gap-3 text-sm text-[var(--accent)]">
                <HardDrive size={18} />
                <span className="font-pixel text-xs tracking-wide">Disk Usage</span>
              </Card.Header>
              <Card.Content className="mt-4 grid gap-2 text-sm text-[var(--muted)]">
                <div className="flex justify-between">
                  <span>Used:</span>
                  <span>
                    {formatBytes(metrics?.disk?.usedBytes ?? null)} /{" "}
                    {formatBytes(metrics?.disk?.totalBytes ?? null)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Usage:</span>
                  <span>{formatPercent(metrics?.disk?.percent ?? null)}</span>
                </div>
              </Card.Content>
            </Card>
          </motion.div>

          <motion.div variants={cardMotion}>
            <Card className="p-5 h-full">
              <Card.Header className="flex items-center gap-3 text-sm text-[var(--accent)]">
                <Database size={18} />
                <span className="font-pixel text-xs tracking-wide">Dimensions</span>
              </Card.Header>
              <Card.Content className="mt-4 grid gap-2 text-sm text-[var(--muted)]">
                {dimensionsDisplay.length === 0 ? (
                  <div className="text-xs">—</div>
                ) : (
                  dimensionsDisplay.map(([dimension, values]) => (
                    <div key={dimension} className="flex justify-between gap-3">
                      <span className="truncate max-w-[140px]">{dimension}</span>
                      <span className="text-xs">
                        {values.chunks ?? "—"} ch / {values.entities ?? "—"} en
                      </span>
                    </div>
                  ))
                )}
              </Card.Content>
            </Card>
          </motion.div>
        </motion.section>
      </motion.main>
    </div>
  );
}
