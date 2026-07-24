"use client";

import { useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import { toast } from "sonner";
import { Filter, Search, Users } from "lucide-react";
import {
  Button,
  Card,
  Chip,
  Label,
  ListBox,
  Select,
  TextField,
  Input,
} from "@heroui/react";
import ConfirmDialog from "@/app/components/ConfirmDialog";
import PageHeader from "@/app/components/PageHeader";
import { SkeletonTable } from "@/app/components/Skeleton";
import { useUISound } from "@/app/hooks/useUISound";
import {
  getPlayerHistory,
  getServerStatus,
  runRconCommand,
  IpcError,
  type PlayerHistoryRow,
  type ServerStatus,
} from "@/app/lib/ipc";

const containerMotion = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.1 } },
};

const cardMotion = {
  hidden: { opacity: 0, y: 20 },
  show: { opacity: 1, y: 0 },
};

// Timestamps arrive as epoch ms (contract §7) — format client-side.
const formatLastSeen = (epochMs: number | null) =>
  epochMs === null ? "—" : new Date(epochMs).toLocaleString();

export default function PlayersPage() {
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [users, setUsers] = useState<PlayerHistoryRow[]>([]);
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
    Promise.allSettled([getServerStatus(), getPlayerHistory()]).then(
      ([statusRes, usersRes]) => {
        if (statusRes.status === "fulfilled") setStatus(statusRes.value);
        if (usersRes.status === "fulfilled") setUsers(usersRes.value.users);
        setLoading(false);
      },
    );
  }, []);

  const playerList = useMemo(() => {
    const sample = status?.players.sample ?? [];
    return sample.map((player) => player.name);
  }, [status]);

  const normalize = (value: string) => value.toLowerCase().trim();

  const filteredUsers = useMemo(() => {
    const needle = normalize(query);
    return users
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
          return (b.lastSeenEpochMs ?? 0) - (a.lastSeenEpochMs ?? 0);
        }
        return a.username.localeCompare(b.username);
      });
  }, [users, query, presence, sort]);

  const runUserCommand = async (command: string, username: string) => {
    setActionBusy(`${command}:${username}`);
    try {
      await runRconCommand(`${command} ${username}`);
      play("success");
      toast.success(`${command} ${username} completed`);
      const updated = await getPlayerHistory();
      setUsers(updated.users);
    } catch (error) {
      play("error");
      toast.error(
        error instanceof IpcError ? error.message : "Command failed.",
      );
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
      <div className="min-h-screen" style={{ background: "var(--background)" }}>
        <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-6 px-4 py-10 md:px-6">
          <div className="h-16" />
          <SkeletonTable rows={6} cols={4} />
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
        <PageHeader
          title="Player Management"
          icon={Users}
          actions={null}
        />

        <motion.section variants={cardMotion}>
          <Card className="p-5">
            <Card.Content className="flex sm:flex-col md:flex-row justify-center gap-3 text-sm">
              <Chip
                variant="soft"
                color={status?.online ? "success" : "warning"}
              >
                {status?.online ? "Online" : "Offline"}
              </Chip>
              <Chip variant="soft">
                Players: {status?.players.online ?? playerList.length}
              </Chip>
              <Chip variant="soft">Version: {status?.version ?? "unknown"}</Chip>
            </Card.Content>
          </Card>
        </motion.section>

        <motion.section className="grid gap-6 md:grid-cols-2" variants={containerMotion}>
          <motion.div variants={cardMotion}>
            <Card className="p-5 h-full">
              <Card.Header className="font-pixel text-xs tracking-wide text-[var(--accent)]">
                Online Players
              </Card.Header>
              <Card.Content className="mt-4 flex flex-wrap gap-2">
                {playerList.length ? (
                  playerList.map((player) => (
                    <Chip key={player} variant="soft">
                      {player}
                    </Chip>
                  ))
                ) : (
                  <span className="text-sm text-[var(--muted)]">No players online</span>
                )}
              </Card.Content>
            </Card>
          </motion.div>

          <motion.div variants={cardMotion}>
            <Card className="p-5">
              <Card.Header className="font-pixel text-xs tracking-wide text-[var(--accent)]">
                Server Details
              </Card.Header>
              <Card.Content className="mt-4 grid gap-2 text-sm text-[var(--muted)]">
                <span>MOTD: {status?.motd ?? "—"}</span>
                <span>
                  Players: {status?.players.online ?? 0}/{status?.players.max ?? "?"}
                </span>
                <span>Ping: {status?.pingMs != null ? `${status.pingMs}ms` : "—"}</span>
              </Card.Content>
            </Card>
          </motion.div>
        </motion.section>

        <motion.section variants={cardMotion}>
          <Card className="overflow-hidden">
            <Card.Header className="border-b p-5" style={{ borderColor: "var(--border)" }}>
              <div className="font-pixel text-xs tracking-wide text-[var(--accent)]">
                User Management
              </div>
              <div className="mt-4 flex flex-wrap gap-3 text-sm">
                <div className="flex items-center gap-2">
                  <Search size={16} className="text-[var(--muted)]" />
                  <TextField className="w-56">
                    <Label className="sr-only">Search</Label>
                    <Input
                      placeholder="Search username or IP"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                    />
                  </TextField>
                </div>
                <div className="flex items-center gap-2">
                  <Filter size={16} className="text-[var(--muted)]" />
                  <Select
                    className="w-32 text-sm"
                    placeholder="Presence"
                    value={presence}
                    onChange={(value) => setPresence(value as typeof presence)}
                  >
                    <Label className="sr-only">Presence</Label>
                    <Select.Trigger>
                      <Select.Value />
                      <Select.Indicator />
                    </Select.Trigger>
                    <Select.Popover>
                      <ListBox>
                        <ListBox.Item id="all">All</ListBox.Item>
                        <ListBox.Item id="online">Online</ListBox.Item>
                        <ListBox.Item id="offline">Offline</ListBox.Item>
                      </ListBox>
                    </Select.Popover>
                  </Select>
                </div>
                <Select
                  className="w-44 text-sm"
                  placeholder="Sort"
                  value={sort}
                  onChange={(value) => setSort(value as typeof sort)}
                >
                  <Label className="sr-only">Sort</Label>
                  <Select.Trigger>
                    <Select.Value />
                    <Select.Indicator />
                  </Select.Trigger>
                  <Select.Popover>
                    <ListBox>
                      <ListBox.Item id="name-asc">Name (A-Z)</ListBox.Item>
                      <ListBox.Item id="last-seen-desc">Last Seen (Recent)</ListBox.Item>
                    </ListBox>
                  </Select.Popover>
                </Select>
              </div>
            </Card.Header>
            <Card.Content className="overflow-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="bg-[var(--surface)] text-[var(--muted)]">
                  <tr>
                    <th className="px-4 py-3 text-xs uppercase tracking-[0.2em]">Username</th>
                    <th className="px-4 py-3 text-xs uppercase tracking-[0.2em]">Last Seen</th>
                    <th className="px-4 py-3 text-xs uppercase tracking-[0.2em]">IP Address</th>
                    <th className="px-4 py-3 text-xs uppercase tracking-[0.2em]">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredUsers.length ? (
                    filteredUsers.map((row) => (
                      <tr key={row.username} className="border-t" style={{ borderColor: "var(--border)" }}>
                        <td className="px-4 py-3 font-semibold">
                          <div className="flex items-center gap-2">
                            {row.username}
                            {row.isOnline && (
                              <span
                                className="inline-block h-2 w-2 rounded-full animate-pulse"
                                style={{ background: "var(--accent)" }}
                              />
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-[var(--muted)]">
                          {formatLastSeen(row.lastSeenEpochMs)}
                        </td>
                        <td className="px-4 py-3 text-[var(--muted)]">{row.ipAddress ?? "—"}</td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap gap-1">
                            {["whitelist add", "op", "deop", "ban", "pardon", "kick"].map((cmd) => (
                              <Button
                                key={cmd}
                                size="sm"
                                variant="ghost"
                                onPress={() => confirmAction(cmd, row.username)}
                                isDisabled={actionBusy === `${cmd}:${row.username}`}
                                onMouseEnter={() => play("hover")}
                              >
                                {cmd.split(" ").pop()}
                              </Button>
                            ))}
                          </div>
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={4} className="px-4 py-6 text-[var(--muted)]">
                        No player data available.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </Card.Content>
          </Card>
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
