"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Filter, Search, Shield, Users } from "lucide-react";

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

export default function PlayersPage() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [users, setUsers] = useState<UsersResponse | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [presence, setPresence] = useState<"all" | "online" | "offline">("all");
  const [sort, setSort] = useState<"name-asc" | "last-seen-desc">("name-asc");

  useEffect(() => {
    fetchJson<StatusResponse>("/api/status")
      .then(setStatus)
      .catch((error) => {
        setStatus({
          online: false,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      });
    fetchJson<UsersResponse>("/api/rcon/users")
      .then(setUsers)
      .catch((error) => {
        setUsers({
          ok: false,
          users: [],
          online: [],
          raw: null,
          error: error instanceof Error ? error.message : "Unknown error",
        });
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
    setActionError(null);
    try {
      const res = await fetch("/api/rcon/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: `${command} ${username}` }),
      });
      const payload = await res.json();
      if (!res.ok || !payload.ok) {
        setActionError(payload.error ?? "Command failed.");
      } else {
        const updated = await fetchJson<UsersResponse>("/api/rcon/users");
        setUsers(updated);
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Command failed.");
    } finally {
      setActionBusy(null);
    }
  };

  const sendCommand = async () => {
    if (!command.trim()) return;
    setSending(true);
    setCommandError(null);
    setCommandOutput(null);
    try {
      const res = await fetch("/api/rcon/command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command }),
      });
      const payload = await res.json();
      if (!res.ok || !payload.ok) {
        setCommandError(payload.error ?? "Command failed.");
      } else {
        setCommandOutput(payload.output ?? "OK");
      }
    } catch (error) {
      setCommandError(
        error instanceof Error ? error.message : "Command failed.",
      );
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(29,68,38,0.55),_transparent_60%)] mc-grid">
      <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-6 px-6 py-10">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Users size={20} className="text-emerald-200" />
            <h1 className="mc-title mc-glow">Player Management</h1>
          </div>
          <div className="flex flex-wrap gap-3">
            <Link className="mc-button" href="/rcon">
              <Shield size={16} />
              RCON Tools
            </Link>
            <Link className="mc-button" href="/">
              <ArrowLeft size={16} />
              Back to dashboard
            </Link>
          </div>
        </header>

        <section className="mc-panel p-5">
          <div className="flex flex-wrap items-center gap-3 text-sm text-emerald-200/80">
            <span className="mc-chip">
              Status: {status?.online ? "online" : "offline"}
            </span>
            <span className="mc-chip">
              Players: {status?.players?.online ?? playerList.length}
            </span>
            <span className="mc-chip">
              Version: {status?.version ?? "unknown"}
            </span>
            {status?.error ? (
              <span className="mc-chip text-amber-200">{status.error}</span>
            ) : null}
          </div>
        </section>

        <section className="grid gap-6 md:grid-cols-2">
          <div className="mc-panel p-5">
            <div className="text-xs uppercase tracking-[0.25em] text-emerald-200/60">
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
                <span className="text-emerald-200/70">No players online</span>
              )}
            </div>
          </div>

          <div className="mc-panel p-5">
            <div className="text-xs uppercase tracking-[0.25em] text-emerald-200/60">
              Server Details
            </div>
            <div className="mt-4 grid gap-2 text-sm text-emerald-200/80">
              <span>MOTD: {status?.motd ?? "—"}</span>
              <span>
                Players: {status?.players?.online ?? 0}/
                {status?.players?.max ?? "?"}
              </span>
              <span>Ping: {status?.ping ? `${status.ping}ms` : "—"}</span>
            </div>
          </div>
        </section>

        <section className="mc-panel overflow-hidden p-0">
          <div className="border-b border-emerald-900/60 p-5">
            <div className="text-xs uppercase tracking-[0.25em] text-emerald-200/60">
              User Management
            </div>
            {actionError ? (
              <div className="mt-2 text-sm text-amber-200">{actionError}</div>
            ) : null}
            <div className="mt-4 flex flex-wrap gap-3 text-sm text-emerald-100">
              <div className="flex items-center gap-2 rounded-lg border border-emerald-900/60 bg-black/40 px-3 py-2">
                <Search size={16} />
                <input
                  className="bg-transparent outline-none placeholder:text-emerald-200/50"
                  placeholder="Search username or IP"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
              <div className="flex items-center gap-2">
                <Filter size={16} />
                <select
                  className="rounded-lg border border-emerald-900/60 bg-black/60 px-2 py-1 text-sm"
                  value={presence}
                  onChange={(event) =>
                    setPresence(event.target.value as typeof presence)
                  }
                >
                  <option value="all">All</option>
                  <option value="online">Online</option>
                  <option value="offline">Offline</option>
                </select>
              </div>
              <div className="flex items-center gap-2">
                <select
                  className="rounded-lg border border-emerald-900/60 bg-black/60 px-2 py-1 text-sm"
                  value={sort}
                  onChange={(event) =>
                    setSort(event.target.value as typeof sort)
                  }
                >
                  <option value="name-asc">Name (A-Z)</option>
                  <option value="last-seen-desc">Last Seen (Recent)</option>
                </select>
              </div>
            </div>
          </div>
          <div className="overflow-auto">
            <table className="w-full text-left text-sm text-emerald-100/90">
              <thead className="bg-black/70 text-xs uppercase tracking-[0.2em] text-emerald-200/70">
                <tr>
                  <th className="px-4 py-3">Username</th>
                  <th className="px-4 py-3">Last Seen</th>
                  <th className="px-4 py-3">IP Address</th>
                  <th className="px-4 py-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredUsers.length ? (
                  filteredUsers.map((row) => (
                    <tr
                      key={row.username}
                      className="border-t border-emerald-900/60"
                    >
                      <td className="px-4 py-3 font-semibold">
                        <div className="flex items-center gap-2">
                          <span>{row.username}</span>
                          {row.isOnline ? (
                            <span className="mc-chip">online</span>
                          ) : null}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-emerald-200/70">
                        {row.lastSeen ?? "—"}
                      </td>
                      <td className="px-4 py-3 text-emerald-200/70">
                        {row.ipAddress ?? "—"}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-2">
                          <button
                            className="mc-button px-2 py-1 text-xs"
                            onClick={() =>
                              runUserCommand("whitelist add", row.username)
                            }
                            disabled={actionBusy === `whitelist add:${row.username}`}
                          >
                            Whitelist
                          </button>
                          <button
                            className="mc-button px-2 py-1 text-xs"
                            onClick={() => runUserCommand("op", row.username)}
                            disabled={actionBusy === `op:${row.username}`}
                          >
                            Op
                          </button>
                          <button
                            className="mc-button px-2 py-1 text-xs"
                            onClick={() => runUserCommand("deop", row.username)}
                            disabled={actionBusy === `deop:${row.username}`}
                          >
                            Deop
                          </button>
                          <button
                            className="mc-button px-2 py-1 text-xs"
                            onClick={() => runUserCommand("ban", row.username)}
                            disabled={actionBusy === `ban:${row.username}`}
                          >
                            Ban
                          </button>
                          <button
                            className="mc-button px-2 py-1 text-xs"
                            onClick={() => runUserCommand("pardon", row.username)}
                            disabled={actionBusy === `pardon:${row.username}`}
                          >
                            Pardon
                          </button>
                          <button
                            className="mc-button px-2 py-1 text-xs"
                            onClick={() => runUserCommand("kick", row.username)}
                            disabled={actionBusy === `kick:${row.username}`}
                          >
                            Kick
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td
                      className="px-4 py-6 text-emerald-200/70"
                      colSpan={4}
                    >
                      No player data available.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
}
