"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { motion } from "motion/react";
import { toast } from "sonner";
import { Filter, Search, Shield, Users } from "lucide-react";
import ConfirmDialog from "@/app/components/ConfirmDialog";
import PageHeader from "@/app/components/PageHeader";
import { SkeletonTable } from "@/app/components/Skeleton";
import { useUISound } from "@/app/hooks/useUISound";

type StatusResponse = {
  online: boolean;
  version?: string | null;
  motd?: string | null;
  players?: { online: number; max: number; sample: Array<{ name: string }> };
  ping?: number | null;
  error?: string;
};

type UserRow = {
  username: string;
  lastSeen: string | null;
  lastSeenEpoch: number | null;
  ipAddress: string | null;
  isOnline: boolean;
};

type UsersResponse = {
  ok: boolean;
  users: UserRow[];
  online: string[];
  raw: { list: string } | null;
  error?: string;
};

const fetchJson = async <T,>(path: string): Promise<T> => {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json() as Promise<T>;
};

type PlayerSample = { name?: string; id?: string } | string;

const toPlayerName = (player: PlayerSample) =>
  typeof player === "string" ? player : player.name ?? player.id ?? "Unknown";

const containerMotion = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.1 } },
};

const cardMotion = {
  hidden: { opacity: 0, y: 20 },
  show: { opacity: 1, y: 0 },
};

export default function PlayersPage() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [users, setUsers] = useState<UsersResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [presence, setPresence] = useState<"all" | "online" | "offline">("all");
  const [sort, setSort] = useState<"name-asc" | "last-seen-desc">("name-asc");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<{
    command: string;
    username: string;
  } | null>(null);
  const { play } = useUISound();

  useEffect(() => {
    Promise.allSettled([
      fetchJson<StatusResponse>("/api/status"),
      fetchJson<UsersResponse>("/api/rcon/users"),
    ]).then(([statusRes, usersRes]) => {
      if (statusRes.status === "fulfilled") setStatus(statusRes.value);
      else setStatus({ online: false });
      if (usersRes.status === "fulfilled") setUsers(usersRes.value);
      else setUsers({ ok: false, users: [], online: [], raw: null });
      setLoading(false);
    });
  }, []);

  const playerList = useMemo(() => {
    const sample = status?.players?.sample ?? [];
    return sample.map(toPlayerName);
  }, [status]);

  const userRows = useMemo(() => {
    return users?.users ?? [];
  }, [users]);

  const normalize = (value: string) => value.toLowerCase().trim();

  const filteredUsers = useMemo(() => {
    const needle = normalize(query);
    return userRows
      .filter((row) => {
        if (presence === "online") return row.isOnline;
        if (presence === "offline") return !row.isOnline;
        return true;
      })
      .filter((row) => {
        if (!needle) return true;
        return (
          normalize(row.username).includes(needle) ||
          normalize(row.ipAddress ?? "").includes(needle)
        );
      })
      .sort((a, b) => {
        if (sort === "last-seen-desc") {
          return (b.lastSeenEpoch ?? 0) - (a.lastSeenEpoch ?? 0);
        }
        return a.username.localeCompare(b.username);
      });
  }, [userRows, query, presence, sort]);

  const runUserCommand = async (command: string, username: string) => {
    setActionBusy(`${command}:${username}`);
    try {
      const res = await fetch("/api/rcon/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: `${command} ${username}` }),
      });
      const payload = await res.json();
      if (!res.ok || !payload.ok) {
        play("error");
        toast.error(payload.error ?? "Command failed.");
      } else {
        play("success");
        toast.success(`${command} ${username} completed`);
        const updated = await fetchJson<UsersResponse>("/api/rcon/users");
        setUsers(updated);
      }
    } catch (error) {
      play("error");
      toast.error(error instanceof Error ? error.message : "Command failed.");
    } finally {
      setActionBusy(null);
    }
  };

  const confirmAction = (command: string, username: string) => {
    setPendingAction({ command, username });
    setConfirmOpen(true);
  };

  if (loading) {
    return (
      <div className="min-h-screen mc-grid" style={{ background: "var(--background)" }}>
        <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-6 px-4 py-10 md:px-6">
          <div className="h-16" />
          <SkeletonTable rows={6} cols={4} />
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
        <PageHeader
          title="Player Management"
          icon={Users}
          actions={
            <Link
              className="mc-button"
              href="/rcon"
              onClick={() => play("click_confirm")}
              onMouseEnter={() => play("hover")}
            >
              <Shield size={16} />
              RCON Tools
            </Link>
          }
        />

        <motion.section className="mc-panel p-5" variants={cardMotion}>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <motion.span
              className="mc-chip"
              animate={{
                borderColor: status?.online ? "var(--mc-accent)" : "var(--mc-panel-border)",
              }}
            >
              {status?.online ? "Online" : "Offline"}
            </motion.span>
            <span className="mc-chip">
              Players: {status?.players?.online ?? playerList.length}
            </span>
            <span className="mc-chip">Version: {status?.version ?? "unknown"}</span>
          </div>
        </motion.section>

        <motion.section className="grid gap-6 md:grid-cols-2" variants={containerMotion}>
          <motion.div className="mc-panel p-5" variants={cardMotion}>
            <div className="font-pixel text-xs tracking-wide" style={{ color: "var(--mc-accent)" }}>
              Online Players
            </div>
            <div className="mt-4 flex flex-wrap gap-2">
              {playerList.length ? (
                playerList.map((player) => (
                  <span key={player} className="mc-chip">
                    {player}
                  </span>
                ))
              ) : (
                <span style={{ color: "var(--mc-muted)" }}>No players online</span>
              )}
            </div>
          </motion.div>

          <motion.div className="mc-panel p-5" variants={cardMotion}>
            <div className="font-pixel text-xs tracking-wide" style={{ color: "var(--mc-accent)" }}>
              Server Details
            </div>
            <div className="mt-4 grid gap-2 text-sm" style={{ color: "var(--mc-muted)" }}>
              <span>MOTD: {status?.motd ?? "—"}</span>
              <span>
                Players: {status?.players?.online ?? 0}/{status?.players?.max ?? "?"}
              </span>
              <span>Ping: {status?.ping ? `${status.ping}ms` : "—"}</span>
            </div>
          </motion.div>
        </motion.section>

        <motion.section className="mc-panel overflow-hidden p-0" variants={cardMotion}>
          <div className="border-b p-5" style={{ borderColor: "var(--mc-panel-border)" }}>
            <div className="font-pixel text-xs tracking-wide" style={{ color: "var(--mc-accent)" }}>
              User Management
            </div>
            <div className="mt-4 flex flex-wrap gap-3 text-sm">
              <div className="mc-input flex items-center gap-2 pr-2">
                <Search size={16} style={{ color: "var(--mc-muted)" }} />
                <input
                  className="bg-transparent outline-none"
                  placeholder="Search username or IP"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  style={{ color: "var(--foreground)" }}
                />
              </div>
              <div className="flex items-center gap-2">
                <Filter size={16} style={{ color: "var(--mc-muted)" }} />
                <select
                  className="mc-select text-sm"
                  value={presence}
                  onChange={(event) => setPresence(event.target.value as typeof presence)}
                >
                  <option value="all">All</option>
                  <option value="online">Online</option>
                  <option value="offline">Offline</option>
                </select>
              </div>
              <select
                className="mc-select text-sm"
                value={sort}
                onChange={(event) => setSort(event.target.value as typeof sort)}
              >
                <option value="name-asc">Name (A-Z)</option>
                <option value="last-seen-desc">Last Seen (Recent)</option>
              </select>
            </div>
          </div>
          <div className="overflow-auto">
            <table className="mc-table">
              <thead>
                <tr>
                  <th>Username</th>
                  <th>Last Seen</th>
                  <th>IP Address</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredUsers.length ? (
                  filteredUsers.map((row) => (
                    <tr key={row.username}>
                      <td className="font-semibold">
                        <div className="flex items-center gap-2">
                          {row.username}
                          {row.isOnline && (
                            <span
                              className="inline-block h-2 w-2 rounded-full animate-pulse"
                              style={{ background: "var(--mc-accent)" }}
                            />
                          )}
                        </div>
                      </td>
                      <td style={{ color: "var(--mc-muted)" }}>{row.lastSeen ?? "—"}</td>
                      <td style={{ color: "var(--mc-muted)" }}>{row.ipAddress ?? "—"}</td>
                      <td>
                        <div className="flex flex-wrap gap-1">
                          {["whitelist add", "op", "deop", "ban", "pardon", "kick"].map((cmd) => (
                            <button
                              key={cmd}
                              className="mc-button px-2 py-1 text-xs"
                              onClick={() => confirmAction(cmd, row.username)}
                              disabled={actionBusy === `${cmd}:${row.username}`}
                              onMouseEnter={() => play("hover")}
                            >
                              {cmd.split(" ").pop()}
                            </button>
                          ))}
                        </div>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={4} style={{ color: "var(--mc-muted)" }}>
                      No player data available.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </motion.section>

        <ConfirmDialog
          isOpen={confirmOpen}
          title="Confirm player action"
          description={
            pendingAction
              ? `Run "${pendingAction.command}" on ${pendingAction.username}?`
              : "Run this command?"
          }
          confirmLabel="Run command"
          cancelLabel="Cancel"
          variant="danger"
          isLoading={Boolean(actionBusy)}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={async () => {
            if (!pendingAction) {
              setConfirmOpen(false);
              return;
            }
            setConfirmOpen(false);
            await runUserCommand(pendingAction.command, pendingAction.username);
          }}
        />
      </motion.main>
    </div>
  );
}
