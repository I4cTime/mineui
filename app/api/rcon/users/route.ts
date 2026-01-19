import { NextResponse } from "next/server";
import { runRcon } from "@/app/api/_utils/rcon";
import { runPodman } from "@/app/api/_utils/podman";
import { serverConfig } from "@/app/lib/serverConfig";

export const revalidate = 0;

type UserRow = {
  username: string;
  lastSeen: string | null;
  lastSeenEpoch: number | null;
  ipAddress: string | null;
  isOnline: boolean;
};

const parseList = (output: string) => {
  const parts = output.split(":");
  if (parts.length < 2) return [];
  return parts[1]
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
};

const parseLogTimestamp = (value: string) => {
  const [hh, mm, ss] = value.split(":").map((v) => Number(v));
  if ([hh, mm, ss].some((v) => Number.isNaN(v))) return null;
  const now = new Date();
  const candidate = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
    hh,
    mm,
    ss,
  );
  if (candidate.getTime() - now.getTime() > 60_000) {
    candidate.setDate(candidate.getDate() - 1);
  }
  return candidate;
};

const stripAnsi = (line: string) =>
  line.replace(/\u001b\[[0-9;]*m/g, "").replace(/\r/g, "");

const parseLogs = (lines: string[]) => {
  const users = new Map<string, Partial<UserRow>>();
  const loginRegex =
    /^\[(\d{2}:\d{2}:\d{2})\]\s+\[[^\]]+\]:\s+([^[]+)\[\/([\d.:]+)\]\s+logged in/;
  const loginNoIpRegex =
    /^\[(\d{2}:\d{2}:\d{2})\]\s+\[[^\]]+\]:\s+(.+)\s+logged in with entity id/;
  const joinRegex =
    /^\[(\d{2}:\d{2}:\d{2})\]\s+\[[^\]]+\]:\s+(?:\\[Not Secure\\]\\s+)?(.+)\s+joined the game$/;
  const leftRegex =
    /^\[(\d{2}:\d{2}:\d{2})\]\s+\[[^\]]+\]:\s+(?:\\[Not Secure\\]\\s+)?(.+)\s+left the game$/;
  const uuidRegex =
    /^\[(\d{2}:\d{2}:\d{2})\]\s+\[[^\]]+\]:\s+UUID of player (.+) is/;

  for (const rawLine of lines) {
    const line = stripAnsi(rawLine);
    const loginMatch = line.match(loginRegex);
    if (loginMatch) {
      const [, time, nameRaw, ip] = loginMatch;
      const name = nameRaw.trim();
      const ts = parseLogTimestamp(time);
      const entry = users.get(name) ?? {};
      entry.ipAddress = ip;
      entry.lastSeen = ts ? ts.toLocaleString() : time;
      entry.lastSeenEpoch = ts ? ts.getTime() : null;
      users.set(name, entry);
      continue;
    }
    const loginNoIpMatch = line.match(loginNoIpRegex);
    if (loginNoIpMatch) {
      const [, time, nameRaw] = loginNoIpMatch;
      const name = nameRaw.trim();
      const ts = parseLogTimestamp(time);
      const entry = users.get(name) ?? {};
      entry.lastSeen = ts ? ts.toLocaleString() : time;
      entry.lastSeenEpoch = ts ? ts.getTime() : null;
      users.set(name, entry);
      continue;
    }
    const joinMatch = line.match(joinRegex);
    if (joinMatch) {
      const [, time, nameRaw] = joinMatch;
      const name = nameRaw.trim();
      const ts = parseLogTimestamp(time);
      const entry = users.get(name) ?? {};
      entry.lastSeen = ts ? ts.toLocaleString() : time;
      entry.lastSeenEpoch = ts ? ts.getTime() : null;
      users.set(name, entry);
      continue;
    }
    const leftMatch = line.match(leftRegex);
    if (leftMatch) {
      const [, time, nameRaw] = leftMatch;
      const name = nameRaw.trim();
      const ts = parseLogTimestamp(time);
      const entry = users.get(name) ?? {};
      entry.lastSeen = ts ? ts.toLocaleString() : time;
      entry.lastSeenEpoch = ts ? ts.getTime() : null;
      users.set(name, entry);
      continue;
    }
    const uuidMatch = line.match(uuidRegex);
    if (uuidMatch) {
      const [, time, nameRaw] = uuidMatch;
      const name = nameRaw.trim();
      const ts = parseLogTimestamp(time);
      const entry = users.get(name) ?? {};
      entry.lastSeen = ts ? ts.toLocaleString() : time;
      entry.lastSeenEpoch = ts ? ts.getTime() : null;
      users.set(name, entry);
    }
  }

  return users;
};

const readLatestLog = async () => {
  try {
    const { stdout } = await runPodman([
      "exec",
      serverConfig.containerName,
      "sh",
      "-c",
      "tail -n 4000 /data/logs/latest.log 2>/dev/null || true",
    ]);
    return stdout.split("\n").filter(Boolean);
  } catch {
    return [];
  }
};

const readFallbackLog = async () => {
  try {
    const { stdout } = await runPodman([
      "exec",
      serverConfig.containerName,
      "sh",
      "-c",
      "tail -n 2000 /data/logs/latest.log.1 2>/dev/null || true",
    ]);
    return stdout.split("\n").filter(Boolean);
  } catch {
    return [];
  }
};

export const GET = async () => {
  try {
    const listOutput = await runRcon("list");
    const onlinePlayers = parseList(listOutput);
    const [logs, fallbackLogs] = await Promise.all([
      readLatestLog(),
      readFallbackLog(),
    ]);
    const combinedLogs = [...logs, ...fallbackLogs];
    const parsed = parseLogs(combinedLogs);

    const usernames = new Set([
      ...onlinePlayers,
      ...Array.from(parsed.keys()),
    ]);

    const rows: UserRow[] = Array.from(usernames).map((username) => {
      const entry = parsed.get(username) ?? {};
      return {
        username,
        lastSeen: entry.lastSeen ?? null,
        lastSeenEpoch: entry.lastSeenEpoch ?? null,
        ipAddress: entry.ipAddress ?? null,
        isOnline: onlinePlayers.includes(username),
      };
    });

    rows.sort((a, b) => {
      if (a.isOnline !== b.isOnline) return a.isOnline ? -1 : 1;
      return (b.lastSeenEpoch ?? 0) - (a.lastSeenEpoch ?? 0);
    });

    return NextResponse.json({
      ok: true,
      users: rows,
      online: onlinePlayers,
      raw: { list: listOutput },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "User list unavailable";
    return NextResponse.json(
      { ok: false, error: message, users: [] },
      { status: 500 },
    );
  }
};
