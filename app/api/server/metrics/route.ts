import { NextResponse } from "next/server";
import { runPodman } from "@/app/api/_utils/podman";
import { runRcon } from "@/app/api/_utils/rcon";
import {
  fetchServerUtilsJson,
  getServerUtilsBaseUrl,
} from "@/app/api/_utils/mineuiServerUtils";
import { serverConfig } from "@/app/lib/serverConfig";

export const revalidate = 0;

const parsePercent = (value: string) => {
  const num = Number(value.replace("%", "").trim());
  return Number.isFinite(num) ? num : null;
};

const parseBytes = (value: string) => {
  const trimmed = value.trim();
  const match = trimmed.match(/^([\d.]+)\s*([KMGT]?i?B)?$/i);
  if (!match) return null;
  const size = Number(match[1]);
  if (!Number.isFinite(size)) return null;
  const unit = (match[2] ?? "B").toUpperCase();
  const base = unit.includes("IB") ? 1024 : 1000;
  const powMap: Record<string, number> = {
    B: 0,
    KB: 1,
    MB: 2,
    GB: 3,
    TB: 4,
    KIB: 1,
    MIB: 2,
    GIB: 3,
    TIB: 4,
  };
  const power = powMap[unit] ?? 0;
  return Math.round(size * Math.pow(base, power));
};

const parseUsage = (value: string) => {
  const [usedRaw, totalRaw] = value.split("/").map((part) => part.trim());
  return {
    usedBytes: usedRaw ? parseBytes(usedRaw) : null,
    totalBytes: totalRaw ? parseBytes(totalRaw) : null,
  };
};

const parseIO = (value: string) => {
  const [inputRaw, outputRaw] = value.split("/").map((part) => part.trim());
  return {
    inputBytes: inputRaw ? parseBytes(inputRaw) : null,
    outputBytes: outputRaw ? parseBytes(outputRaw) : null,
  };
};

const parseTps = (output: string) => {
  const match = output.match(
    /TPS from last 1m, 5m, 15m: ([\\d.]+),\\s*([\\d.]+),\\s*([\\d.]+)/i,
  );
  if (!match) return null;
  return {
    one: Number(match[1]),
    five: Number(match[2]),
    fifteen: Number(match[3]),
    raw: output,
  };
};

type ServerUtilsMetricsResponse = {
  ok: boolean;
  tps?: { one: number; five: number; fifteen: number; raw?: string };
  mspt?: { one: number | null; five: number | null; fifteen: number | null };
  chunks?: number | null;
  entities?: number | null;
  dimensions?: Record<string, { chunks: number | null; entities: number | null }>;
  system?: {
    cpuPercent?: number | null;
    mem?: { totalBytes?: number | null; usedBytes?: number | null };
    net?: { inputBytes?: number | null; outputBytes?: number | null };
    disk?: { readBytes?: number | null; writeBytes?: number | null };
    container?: {
      cpuPercent?: number | null;
      mem?: {
        usedBytes?: number | null;
        limitBytes?: number | null;
        percent?: number | null;
      };
      net?: { inputBytes?: number | null; outputBytes?: number | null };
      block?: { readBytes?: number | null; writeBytes?: number | null };
      pids?: number | null;
    };
  };
  players?: { online: number | null; max: number | null };
  error?: string;
};

export const GET = async () => {
  try {
    const [statsRaw, startedAtRaw, diskRaw] = await Promise.all([
      runPodman([
        "stats",
        "--no-stream",
        "--format",
        "json",
        serverConfig.containerName,
      ]),
      runPodman([
        "inspect",
        "-f",
        "{{.State.StartedAt}}",
        serverConfig.containerName,
      ]),
      runPodman([
        "exec",
        serverConfig.containerName,
        "sh",
        "-c",
        "df -k /data | tail -n 1",
      ]),
    ]);

    const stats = statsRaw.stdout ? JSON.parse(statsRaw.stdout) : [];
    const container = Array.isArray(stats) ? stats[0] : stats;
    const cpuPercent = parsePercent(container?.CPUPerc ?? "");
    const memPercent = parsePercent(container?.MemPerc ?? "");
    const memUsage = parseUsage(container?.MemUsage ?? "");
    const netIO = parseIO(container?.NetIO ?? "");
    const blockIO = parseIO(container?.BlockIO ?? "");

    const diskParts = diskRaw.stdout.trim().split(/\s+/);
    const diskTotal = diskParts[1] ? Number(diskParts[1]) * 1024 : null;
    const diskUsed = diskParts[2] ? Number(diskParts[2]) * 1024 : null;
    const diskPercentRaw = diskParts[4] ?? "";
    const diskPercent = parsePercent(diskPercentRaw);

    let tps: {
      one: number;
      five: number;
      fifteen: number;
      raw: string;
    } | null = null;
    let mspt: { one: number | null; five: number | null; fifteen: number | null } | null =
      null;
    let chunks: number | null = null;
    let entities: number | null = null;
    let dimensions: Record<string, { chunks: number | null; entities: number | null }> | null =
      null;
    let systemCpu: number | null = null;
    let systemMemUsage: { usedBytes: number | null; totalBytes: number | null } | null =
      null;
    let systemMemPercent: number | null = null;
    let systemNet: { inputBytes: number | null; outputBytes: number | null } | null =
      null;
    let systemDisk: { inputBytes: number | null; outputBytes: number | null } | null =
      null;
    let containerCpu: number | null = null;
    let containerMemUsage: { usedBytes: number | null; totalBytes: number | null } | null =
      null;
    let containerMemPercent: number | null = null;
    let containerNet: { inputBytes: number | null; outputBytes: number | null } | null =
      null;
    let containerBlock: { inputBytes: number | null; outputBytes: number | null } | null =
      null;
    const serverUtilsUrl = getServerUtilsBaseUrl();
    if (serverUtilsUrl) {
      try {
        const metricsResponse =
          await fetchServerUtilsJson<ServerUtilsMetricsResponse>("/metrics");
        if (metricsResponse.ok) {
          if (metricsResponse.tps) {
            const raw =
              metricsResponse.tps.raw ??
              `TPS avg 1m/5m/15m: ${metricsResponse.tps.one}, ${metricsResponse.tps.five}, ${metricsResponse.tps.fifteen}`;
            tps = {
              one: metricsResponse.tps.one,
              five: metricsResponse.tps.five,
              fifteen: metricsResponse.tps.fifteen,
              raw,
            };
          }
          chunks = metricsResponse.chunks ?? null;
          entities = metricsResponse.entities ?? null;
          mspt = metricsResponse.mspt ?? null;
          dimensions = metricsResponse.dimensions ?? null;
          if (metricsResponse.system) {
            systemCpu = metricsResponse.system.cpuPercent ?? null;
            if (metricsResponse.system.mem) {
              systemMemUsage = {
                usedBytes: metricsResponse.system.mem.usedBytes ?? null,
                totalBytes: metricsResponse.system.mem.totalBytes ?? null,
              };
              if (
                systemMemUsage.totalBytes != null &&
                systemMemUsage.usedBytes != null &&
                systemMemUsage.totalBytes > 0
              ) {
                systemMemPercent =
                  (systemMemUsage.usedBytes / systemMemUsage.totalBytes) * 100;
              }
            }
            if (metricsResponse.system.net) {
              systemNet = {
                inputBytes: metricsResponse.system.net.inputBytes ?? null,
                outputBytes: metricsResponse.system.net.outputBytes ?? null,
              };
            }
            if (metricsResponse.system.disk) {
              systemDisk = {
                inputBytes: metricsResponse.system.disk.readBytes ?? null,
                outputBytes: metricsResponse.system.disk.writeBytes ?? null,
              };
            }
            if (metricsResponse.system.container) {
              containerCpu =
                metricsResponse.system.container.cpuPercent ?? null;
              if (metricsResponse.system.container.mem) {
                containerMemUsage = {
                  usedBytes:
                    metricsResponse.system.container.mem.usedBytes ?? null,
                  totalBytes:
                    metricsResponse.system.container.mem.limitBytes ?? null,
                };
                containerMemPercent =
                  metricsResponse.system.container.mem.percent ?? null;
              }
              if (metricsResponse.system.container.net) {
                containerNet = {
                  inputBytes:
                    metricsResponse.system.container.net.inputBytes ?? null,
                  outputBytes:
                    metricsResponse.system.container.net.outputBytes ?? null,
                };
              }
              if (metricsResponse.system.container.block) {
                containerBlock = {
                  inputBytes:
                    metricsResponse.system.container.block.readBytes ?? null,
                  outputBytes:
                    metricsResponse.system.container.block.writeBytes ?? null,
                };
              }
            }
          }
        }
      } catch {
        tps = null;
      }
    }
    if (!tps) {
      try {
        const tpsOutput = await runRcon("tps");
        tps = parseTps(tpsOutput);
        if (!tps) {
          tps = { one: NaN, five: NaN, fifteen: NaN, raw: tpsOutput };
        }
      } catch {
        tps = null;
      }
    }

    return NextResponse.json({
      ok: true,
      cpuPercent: containerCpu ?? systemCpu ?? cpuPercent,
      memUsage: containerMemUsage ?? systemMemUsage ?? memUsage,
      memPercent: containerMemPercent ?? systemMemPercent ?? memPercent,
      netIO: containerNet ?? systemNet ?? netIO,
      blockIO: containerBlock ?? systemDisk ?? blockIO,
      disk: {
        usedBytes: diskUsed,
        totalBytes: diskTotal,
        percent: diskPercent,
        raw: diskRaw.stdout.trim(),
      },
      uptime: startedAtRaw.stdout.trim() || null,
      tps,
      mspt,
      chunks,
      entities,
      dimensions,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Metrics unavailable";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
};
