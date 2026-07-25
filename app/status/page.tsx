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
import { Card, Chip, ProgressCircle } from "@heroui/react";
import PageHeader from "@/app/components/PageHeader";
import { formatBytes } from "@/app/lib/format";
import { SkeletonCard } from "@/app/components/Skeleton";
import { useMode } from "@/app/components/ModeProvider";
import { usePageMotion } from "@/app/lib/motion";
import {
  getMetrics,
  getServerState,
  getServerStatus,
  onServerState,
  type Metrics,
  type ServerState,
  type ServerStatus,
} from "@/app/lib/ipc";

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

// Composes core ProgressCircle at a ~110px size with a centered value/sublabel
// overlay. HeroUI's ProgressCircle keeps a fixed internal 36x36 viewBox/radius
// (see progress-circle.tsx: CENTER/RADIUS/CIRCUMFERENCE are module constants)
// and scales purely via the `.progress-circle__track` CSS box size — the
// FillCircle's stroke-dasharray/dashoffset are computed from that fixed
// radius, so overriding cx/cy/r/strokeWidth/viewBox to arbitrary values (as
// this previously did) desyncs the dash math from the actual rendered
// circle, producing tiny broken arc fragments. Enlarge via a Tailwind size
// class on Track only, per the documented "Sizes"/"Passing Tailwind CSS
// classes" pattern — never touch the SVG geometry props.
function MetricRing({
  value,
  label,
  sublabel,
}: {
  value: number;
  label: string;
  sublabel: string;
}) {
  return (
    <div className="relative inline-flex size-27.5 items-center justify-center">
      <ProgressCircle aria-label={`${sublabel} usage`} color="accent" value={value}>
        <ProgressCircle.Track className="size-27.5">
          <ProgressCircle.TrackCircle />
          <ProgressCircle.FillCircle />
        </ProgressCircle.Track>
      </ProgressCircle>
      <div className="absolute flex flex-col items-center justify-center text-center">
        <span className="font-pixel-num text-lg text-accent">{label}</span>
        <span className="text-xs text-muted">{sublabel}</span>
      </div>
    </div>
  );
}

export default function StatusPage() {
  const { containerMotion, cardMotion } = usePageMotion();
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [serverState, setServerState] = useState<ServerState | null>(null);
  const [loading, setLoading] = useState(true);
  // Shared app-wide mode (app/components/ModeProvider.tsx), not the
  // payload's own `serverState.mode` — this is what makes the "Container:"/
  // "Process:" labeling below (and the network/disk-IO fallback copy)
  // update the instant a navbar toggle fires instead of waiting on the next
  // 30s poll or state event to notice the backend agrees.
  const { mode } = useMode();
  const isSimple = mode === "simple";

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
    // Re-run on a mode toggle so this page refetches immediately instead of
    // showing data fetched under the previous mode until the next poll/event.
  }, [mode]);

  const stateSummary = useMemo(() => {
    if (!serverState) return "unknown";
    if (mode === "advanced") {
      return serverState.container?.status ?? serverState.phase;
    }
    return serverState.process?.pid
      ? `${serverState.phase} (pid ${serverState.process.pid})`
      : serverState.phase;
  }, [serverState, mode]);

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
      <div className="min-h-screen bg-background">
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
            <MetricRing
              value={metrics?.cpuPercent ?? 0}
              label={formatPercent(metrics?.cpuPercent ?? null)}
              sublabel="CPU"
            />
            <MetricRing
              value={metrics?.mem.percent ?? 0}
              label={formatPercent(metrics?.mem.percent ?? null)}
              sublabel="Memory"
            />
            <MetricRing
              value={metrics?.disk?.percent ?? 0}
              label={formatPercent(metrics?.disk?.percent ?? null)}
              sublabel="Disk"
            />
            <MetricRing
              value={Math.min((metrics?.tps?.one ?? 0) * 5, 100)}
              label={metrics?.tps?.one != null ? metrics.tps.one.toFixed(1) : "—"}
              sublabel="TPS"
            />
          </Card>
        </motion.section>

        <motion.section className="grid gap-6 md:grid-cols-3" variants={containerMotion}>
          <motion.div variants={cardMotion}>
            <Card className="p-5 h-full">
              <Card.Header className="flex items-center gap-3 text-sm text-accent">
                <Activity size={18} />
                <span className="font-pixel text-xs tracking-wide">Game Status</span>
              </Card.Header>
              <Card.Content className="mt-4 grid gap-2 text-sm text-muted">
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
                  <span className="font-pixel-num">
                    {status?.players.online ?? 0}/{status?.players.max ?? "?"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Ping:</span>
                  <span className="font-pixel-num">{status?.pingMs != null ? `${status.pingMs}ms` : "—"}</span>
                </div>
                <div className="flex justify-between">
                  <span>MOTD:</span>
                  <span className="truncate max-w-37.5">{status?.motd ?? "—"}</span>
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
              <Card.Header className="flex items-center gap-3 text-sm text-accent">
                <Timer size={18} />
                <span className="font-pixel text-xs tracking-wide">Uptime & TPS</span>
              </Card.Header>
              <Card.Content className="mt-4 grid gap-2 text-sm text-muted">
                <div className="flex justify-between">
                  <span>{isSimple ? "Process:" : "Container:"}</span>
                  <span className="truncate max-w-42.5">{stateSummary}</span>
                </div>
                <div className="flex justify-between">
                  <span>Uptime:</span>
                  <span>{formatUptime(metrics)}</span>
                </div>
                <div className="flex justify-between">
                  <span>TPS:</span>
                  <span className="font-pixel-num text-xs">{tpsDisplay}</span>
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
              <Card.Header className="flex items-center gap-3 text-sm text-accent">
                <Cpu size={18} />
                <span className="font-pixel text-xs tracking-wide">Compute</span>
              </Card.Header>
              <Card.Content className="mt-4 grid gap-2 text-sm text-muted">
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
              <Card.Header className="flex items-center gap-3 text-sm text-accent">
                <Network size={18} />
                <span className="font-pixel text-xs tracking-wide">Network</span>
              </Card.Header>
              <Card.Content className="mt-4 grid gap-2 text-sm text-muted">
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
              <Card.Header className="flex items-center gap-3 text-sm text-accent">
                <Database size={18} />
                <span className="font-pixel text-xs tracking-wide">Disk I/O</span>
              </Card.Header>
              <Card.Content className="mt-4 grid gap-2 text-sm text-muted">
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
              <Card.Header className="flex items-center gap-3 text-sm text-accent">
                <HardDrive size={18} />
                <span className="font-pixel text-xs tracking-wide">Disk Usage</span>
              </Card.Header>
              <Card.Content className="mt-4 grid gap-2 text-sm text-muted">
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
              <Card.Header className="flex items-center gap-3 text-sm text-accent">
                <Database size={18} />
                <span className="font-pixel text-xs tracking-wide">Dimensions</span>
              </Card.Header>
              <Card.Content className="mt-4 grid gap-2 text-sm text-muted">
                {dimensionsDisplay.length === 0 ? (
                  <div className="text-xs">—</div>
                ) : (
                  dimensionsDisplay.map(([dimension, values]) => (
                    <div key={dimension} className="flex justify-between gap-3">
                      <span className="truncate max-w-35">{dimension}</span>
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
