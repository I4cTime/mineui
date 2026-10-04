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
  ScrollText,
} from "lucide-react";
import { Card, Chip, ProgressCircle, Table } from "@heroui/react";
import PageHeader from "@/app/components/PageHeader";
import ServerStateNotice from "@/app/components/ServerStateNotice";
import { phaseDotClass, useServers } from "@/app/components/ServerProvider";
import { formatBytes, formatDateTime } from "@/app/lib/format";
import { SkeletonCard } from "@/app/components/Skeleton";
import { useMode } from "@/app/components/ModeProvider";
import { usePageMotion } from "@/app/lib/motion";
import {
  getAuditLog,
  getMetrics,
  getServerState,
  getServerStatus,
  IpcError,
  onServerState,
  type AuditEntry,
  type Metrics,
  type ServerState,
  type ServerStatus,
} from "@/app/lib/ipc";

const formatPercent = (value: number | null) =>
  value === null ? "-" : `${value.toFixed(1)}%`;

const formatMspt = (value: number | null) =>
  value === null ? "-" : `${value.toFixed(2)} ms`;

const formatUptime = (metrics: Metrics | null) => {
  if (!metrics) return "-";
  let seconds = metrics.uptimeSeconds;
  if (seconds === null && metrics.startedAt) {
    const started = new Date(metrics.startedAt);
    if (!Number.isNaN(started.getTime())) {
      seconds = Math.max(0, Math.floor((Date.now() - started.getTime()) / 1000));
    }
  }
  if (seconds === null) return "-";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
};

// Composes core ProgressCircle at a ~110px size with a centered value/sublabel
// overlay. HeroUI's ProgressCircle keeps a fixed internal 36x36 viewBox/radius
// (see progress-circle.tsx: CENTER/RADIUS/CIRCUMFERENCE are module constants)
// and scales purely via the `.progress-circle__track` CSS box size - the
// FillCircle's stroke-dasharray/dashoffset are computed from that fixed
// radius, so overriding cx/cy/r/strokeWidth/viewBox to arbitrary values (as
// this previously did) desyncs the dash math from the actual rendered
// circle, producing tiny broken arc fragments. Enlarge via a Tailwind size
// class on Track only, per the documented "Sizes"/"Passing Tailwind CSS
// classes" pattern - never touch the SVG geometry props.
type RingTone = "accent" | "success" | "warning" | "danger";

const TONE_TEXT: Record<RingTone, string> = {
  accent: "text-accent",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
};

/** Usage rings: a fuller ring is worse. */
const usageTone = (value: number | null): RingTone =>
  value === null ? "accent" : value >= 90 ? "danger" : value >= 75 ? "warning" : "accent";

/** Game speed ring: a full ring (20 TPS) is good. */
const speedTone = (tps: number | null): RingTone =>
  tps === null ? "accent" : tps >= 18 ? "success" : tps >= 10 ? "warning" : "danger";

function MetricRing({
  value,
  label,
  title,
  tone,
}: {
  value: number;
  label: string;
  /** Full caption under the ring. */
  title: string;
  tone: RingTone;
}) {
  return (
    <div className="flex w-36 flex-col items-center gap-2 text-center">
      <div className="relative inline-flex size-27.5 items-center justify-center">
        <ProgressCircle aria-label={`${title}: ${label}`} color={tone} value={value}>
          <ProgressCircle.Track className="size-27.5">
            <ProgressCircle.TrackCircle />
            <ProgressCircle.FillCircle />
          </ProgressCircle.Track>
        </ProgressCircle>
        <div className="absolute flex flex-col items-center justify-center text-center">
          <span className={`font-pixel-num text-lg ${TONE_TEXT[tone]}`}>{label}</span>
        </div>
      </div>
      <span className="text-xs text-muted">{title}</span>
    </div>
  );
}

const NOT_REPORTED = "Not reported by this server type";

/** Collapsed technical rows at the bottom of a card. */
function Details({ children }: { children: React.ReactNode }) {
  return (
    <details className="mt-1 text-xs">
      <summary className="cursor-pointer text-muted">Details</summary>
      <div className="mt-2 grid gap-1.5">{children}</div>
    </details>
  );
}

const AUDIT_PHRASES: Record<string, string> = {
  "server.start": "Server started",
  "server.stop": "Server stopped",
  "server.restart": "Server restarted",
  "server.add": "Server added to MineUI",
  "server.remove": "Server removed from MineUI",
  "server.rename": "Server renamed",
  "backup.create": "Backup created",
  "backup.restore": "Backup restored",
  "backup.delete": "Backup deleted",
  "backup.prune": "Old backup removed",
  "backup.copy": "Backup copied to second folder",
  "scheduler.backup": "Scheduled backup",
  "scheduler.broadcast": "Scheduled message to players",
  "config.write": "Config file saved",
  "mod.upload": "Mod added",
  "mod.download": "Mod downloaded",
  "mod.unpack": "Mods unpacked from a zip",
  "mod.delete": "Mod deleted",
  "rcon.command": "Console command",
  "note.set": "Player note saved",
  "note.clear": "Player note removed",
  "player.ban": "Banned a player",
  "player.pardon": "Unbanned a player",
  "player.kick": "Kicked a player",
  "player.op": "Made a player an operator",
  "player.deop": "Removed operator from a player",
  "player.whitelist": "Changed the whitelist",
  "settings.update": "Settings changed",
  "container.create": "Server container created",
  "container.delete": "Server container deleted",
  "instance.create": "Server created",
  "instance.delete": "Server deleted",
};

const auditPhrase = (action: string) => AUDIT_PHRASES[action] ?? action;

export default function StatusPage() {
  const { containerMotion, cardMotion } = usePageMotion();
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [serverState, setServerState] = useState<ServerState | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  // A failed call must not read as "stopped": keep the message and show it.
  const [metricsError, setMetricsError] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const { overview, activeId } = useServers();
  const serverEntry = overview.find((item) => item.id === activeId);
  // Shared app-wide mode (app/components/ModeProvider.tsx), not the
  // payload's own `serverState.mode` - this is what makes the "Container:"/
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
        getAuditLog(100),
      ]).then(([statusRes, metricsRes, stateRes, auditRes]) => {
        const message = (reason: unknown) =>
          reason instanceof IpcError ? reason.message : "the call failed";
        if (statusRes.status === "fulfilled") {
          setStatus(statusRes.value);
          setStatusError(null);
        } else {
          setStatusError(message(statusRes.reason));
        }
        if (metricsRes.status === "fulfilled") {
          setMetrics(metricsRes.value);
          setMetricsError(null);
        } else {
          setMetrics(null);
          setMetricsError(message(metricsRes.reason));
        }
        if (stateRes.status === "fulfilled") setServerState(stateRes.value);
        if (auditRes.status === "fulfilled") setAudit(auditRes.value.entries);
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
    if (!metrics?.tps) return metrics && serverState?.phase === "running" ? NOT_REPORTED : "-";
    if (!Number.isFinite(metrics.tps.one)) return metrics.tps.raw;
    return `${metrics.tps.one.toFixed(1)} / ${metrics.tps.five.toFixed(1)} / ${metrics.tps.fifteen.toFixed(1)}`;
  }, [metrics, serverState]);

  const dimensionsDisplay = useMemo(() => {
    if (!metrics?.dimensions) return [];
    return Object.entries(metrics.dimensions);
  }, [metrics]);

  // The one-line condition, in words. Phase comes from the live overview (the
  // same source as the header dot); `status` says whether the game answers.
  const phase = serverEntry?.phase;
  const address = serverEntry?.address ?? "this server's address";
  const condition = (() => {
    if (!serverEntry) return null;
    if (phase === null) return `MineUI can't read the server's state: ${serverEntry.error ?? "unknown error"}`;
    if (phase === "not-created") return "Not set up yet.";
    if (phase === "stopped") return "Stopped.";
    if (phase === "crashed") return "Stopped - it crashed.";
    if (phase === "starting") return "Starting - players can join when this turns green.";
    if (phase === "stopping") return "Stopping.";
    if (status?.online) return "Running - players can join. The Dashboard shows the address to give them.";
    return `Running, but MineUI can't reach it at ${address}: ${status?.error ?? statusError ?? "no answer"}`;
  })();
  const reachable = phase === "running" && status?.online === true;
  const ringsTone = {
    cpu: usageTone(metrics?.cpuPercent ?? null),
    mem: usageTone(metrics?.mem.percent ?? null),
    disk: usageTone(metrics?.disk?.percent ?? null),
    tps: speedTone(metrics?.tps?.one ?? null),
  };
  const enriched = metrics?.enriched === true;

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
        background: `radial-gradient(circle at top, var(--page-wash), transparent 60%), var(--background)`,
      }}
    >
      <motion.main
        className="page-main mx-auto flex max-w-6xl flex-col gap-6 px-4 pt-5 pb-10 md:px-6"
        initial="hidden"
        animate="show"
        variants={containerMotion}
      >
        <PageHeader title="Server Status" icon={Gauge} />

        {condition && (
          <motion.section variants={cardMotion}>
            <p role="status" className="flex items-start gap-2.5 text-sm">
              <span
                aria-hidden
                className={`mt-1.5 size-2.5 shrink-0 rounded-full ${
                  phase === "running" && !reachable ? "bg-warning" : phaseDotClass(phase)
                }`}
              />
              <span>{condition}</span>
            </p>
          </motion.section>
        )}

        <ServerStateNotice need="running" what="to show live numbers" />

        {metricsError && (
          <div role="alert" className="rounded-lg border border-danger p-3 text-sm text-danger">
            Couldn&apos;t read the live numbers: {metricsError}
          </div>
        )}

        {/* Performance Rings */}
        <motion.section variants={cardMotion}>
          <Card className="flex flex-col items-center gap-4 p-6">
            <div className="flex flex-wrap justify-center gap-8">
              <MetricRing
                value={metrics?.cpuPercent ?? 0}
                label={formatPercent(metrics?.cpuPercent ?? null)}
                title="CPU"
                tone={ringsTone.cpu}
              />
              <MetricRing
                value={metrics?.mem.percent ?? 0}
                label={formatPercent(metrics?.mem.percent ?? null)}
                title={isSimple ? "Memory (of this computer)" : "Memory"}
                tone={ringsTone.mem}
              />
              <MetricRing
                value={metrics?.disk?.percent ?? 0}
                label={formatPercent(metrics?.disk?.percent ?? null)}
                title="Disk (drive holding the server)"
                tone={ringsTone.disk}
              />
              <MetricRing
                value={Math.min((metrics?.tps?.one ?? 0) * 5, 100)}
                label={metrics?.tps?.one != null ? metrics.tps.one.toFixed(1) : "-"}
                title="Game speed (TPS)"
                tone={ringsTone.tps}
              />
            </div>
            <p className="text-xs text-muted">
              CPU, Memory and Disk: a fuller ring means busier. Game speed: a full ring is
              good (20 is perfect).
            </p>
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
                  <span>Players can join:</span>
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
                  <span>{status?.version ?? "-"}</span>
                </div>
                <div className="flex justify-between">
                  <span>Players:</span>
                  <span className="font-pixel-num">
                    {status?.players.online ?? 0}/{status?.players.max ?? "?"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Ping:</span>
                  <span className="font-pixel-num">{status?.pingMs != null ? `${status.pingMs}ms` : "-"}</span>
                </div>
                <div className="flex justify-between">
                  <span>MOTD:</span>
                  <span className="truncate max-w-37.5">{status?.motd ?? "-"}</span>
                </div>
                <Details>
                  <div className="flex justify-between">
                    <span>Answered through:</span>
                    <span>{status?.source ?? "-"}</span>
                  </div>
                </Details>
              </Card.Content>
            </Card>
          </motion.div>

          <motion.div variants={cardMotion}>
            <Card className="p-5 h-full">
              <Card.Header className="flex items-center gap-3 text-sm text-accent">
                <Timer size={18} />
                <span className="font-pixel text-xs tracking-wide">Uptime & Game speed</span>
              </Card.Header>
              <Card.Content className="mt-4 grid gap-2 text-sm text-muted">
                <div className="flex justify-between">
                  <span>Uptime:</span>
                  <span>{formatUptime(metrics)}</span>
                </div>
                <div className="grid gap-0.5">
                  <div className="flex justify-between gap-3">
                    <span>Game speed (TPS):</span>
                    <span className={metrics?.tps ? "font-pixel-num text-xs" : "text-xs"}>
                      {tpsDisplay}
                    </span>
                  </div>
                  <span className="text-xs">
                    20 is perfect; below about 18 players feel lag.
                    {metrics?.tps ? " Last 1 / 5 / 15 min." : ""}
                  </span>
                </div>
                <div className="grid gap-0.5">
                  <div className="flex justify-between gap-3">
                    <span>Time per tick (MSPT):</span>
                    <span className="text-xs">
                      {metrics?.mspt
                        ? `${formatMspt(metrics.mspt.one)} / ${formatMspt(metrics.mspt.five)} / ${formatMspt(metrics.mspt.fifteen)}`
                        : phase === "running"
                          ? NOT_REPORTED
                          : "-"}
                    </span>
                  </div>
                  {metrics?.mspt && (
                    <span className="text-xs">Last 1 / 5 / 15 min. Under 50 ms keeps the game at full speed.</span>
                  )}
                </div>
                {enriched && metrics?.chunks != null && (
                  <div className="flex justify-between">
                    <span>Loaded chunks:</span>
                    <span>{metrics.chunks}</span>
                  </div>
                )}
                {enriched && metrics?.entities != null && (
                  <div className="flex justify-between">
                    <span>Entities (mobs, items…):</span>
                    <span>{metrics.entities}</span>
                  </div>
                )}
                <Details>
                  <div className="flex justify-between gap-3">
                    <span>{isSimple ? "Process:" : "Container:"}</span>
                    <span className="truncate max-w-42.5">{stateSummary}</span>
                  </div>
                </Details>
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
                  <span>CPU load:</span>
                  <span>{formatPercent(metrics?.cpuPercent ?? null)}</span>
                </div>
                <div className="flex justify-between gap-3">
                  <span>{isSimple ? "Memory (of this computer):" : "Memory:"}</span>
                  <span className="text-right">
                    {formatBytes(metrics?.mem.usedBytes ?? null)} /{" "}
                    {formatBytes(metrics?.mem.totalBytes ?? null)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Memory used:</span>
                  <span>{formatPercent(metrics?.mem.percent ?? null)}</span>
                </div>
                <Details>
                  <div className="flex justify-between">
                    <span>Measured from:</span>
                    <span>
                      {metrics
                        ? `${metrics.base}${metrics.enriched ? " + utils" : ""}`
                        : "-"}
                    </span>
                  </div>
                </Details>
              </Card.Content>
            </Card>
          </motion.div>
        </motion.section>

        <motion.section className="grid gap-6 md:grid-cols-3" variants={containerMotion}>
          <motion.div variants={cardMotion}>
            <Card className="p-5 h-full">
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
                    <span className="text-xs">Totals since the server started.</span>
                  </>
                ) : (
                  <span className="text-xs">
                    {isSimple
                      ? "Container network stats are available in Advanced mode."
                      : "-"}
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
                    <span className="text-xs">Totals since the server started.</span>
                  </>
                ) : (
                  <span className="text-xs">
                    {isSimple
                      ? "Container block-IO stats are available in Advanced mode."
                      : "-"}
                  </span>
                )}
              </Card.Content>
            </Card>
          </motion.div>

          <motion.div variants={cardMotion}>
            <Card className="p-5 h-full">
              <Card.Header className="flex items-center gap-3 text-sm text-accent">
                <HardDrive size={18} />
                <span className="font-pixel text-xs tracking-wide">Disk (drive holding the server)</span>
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

          {enriched && dimensionsDisplay.length > 0 && (
            <motion.div variants={cardMotion}>
              <Card className="p-5 h-full">
                <Card.Header className="flex items-center gap-3 text-sm text-accent">
                  <Database size={18} />
                  <span className="font-pixel text-xs tracking-wide">Dimensions</span>
                </Card.Header>
                <Card.Content className="mt-4 grid gap-2 text-sm text-muted">
                  {dimensionsDisplay.map(([dimension, values]) => (
                    <div key={dimension} className="flex justify-between gap-3">
                      <span className="truncate max-w-35">{dimension}</span>
                      <span className="text-xs">
                        {values.chunks ?? "-"} chunks / {values.entities ?? "-"} entities
                      </span>
                    </div>
                  ))}
                </Card.Content>
              </Card>
            </motion.div>
          )}
        </motion.section>

        {/* Admin audit log (contract §3.11): every action taken from the app
            or by the scheduler, newest first. Polls with the rest of the page. */}
        <motion.section variants={cardMotion}>
          <Card className="overflow-hidden">
            <Card.Header className="flex items-center gap-3 border-b border-border p-5 text-sm text-accent">
              <ScrollText size={18} />
              <span className="font-pixel text-xs tracking-wide">Activity log</span>
              <span className="ml-auto text-xs text-muted">last {audit.length} actions</span>
            </Card.Header>
            <Card.Content className="p-0">
              <Table>
                <Table.ScrollContainer className="max-h-120">
                  <Table.Content aria-label="Activity log" className="min-w-180">
                    <Table.Header>
                      <Table.Column isRowHeader>When</Table.Column>
                      <Table.Column>Action</Table.Column>
                      <Table.Column>Target</Table.Column>
                      <Table.Column>Detail</Table.Column>
                      <Table.Column>By</Table.Column>
                    </Table.Header>
                    <Table.Body
                      items={audit}
                      renderEmptyState={() => (
                        <div className="p-6 text-center text-sm text-muted">
                          Nothing recorded yet. Server control, player actions,
                          RCON commands, backups and config edits show up here.
                        </div>
                      )}
                    >
                      {(entry) => (
                        <Table.Row id={entry.id}>
                          <Table.Cell className="whitespace-nowrap text-muted font-pixel-num">
                            {formatDateTime(entry.epochMs)}
                          </Table.Cell>
                          <Table.Cell>
                            <Chip size="sm" variant="soft" color={entry.ok ? "default" : "danger"}>
                              {auditPhrase(entry.action)}
                            </Chip>
                          </Table.Cell>
                          <Table.Cell className="max-w-48 truncate">{entry.target ?? "-"}</Table.Cell>
                          <Table.Cell className="max-w-72 text-muted">
                            <span className="block truncate" title={entry.error ?? entry.detail ?? undefined}>
                              {entry.error ?? entry.detail ?? "-"}
                            </span>
                          </Table.Cell>
                          <Table.Cell className="text-muted">
                            {entry.source === "scheduler" ? "Schedule" : "You"}
                          </Table.Cell>
                        </Table.Row>
                      )}
                    </Table.Body>
                  </Table.Content>
                </Table.ScrollContainer>
              </Table>
            </Card.Content>
          </Card>
        </motion.section>
      </motion.main>
    </div>
  );
}
