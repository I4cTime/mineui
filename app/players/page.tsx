"use client";

import { useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import { Filter, Search, Users } from "lucide-react";
import {
  Button,
  Card,
  Chip,
  Label,
  ListBox,
  Select,
  Table,
  TextField,
  Input,
  toast,
} from "@heroui/react";
import { EmptyState } from "@heroui-pro/react";
import ConfirmDialog from "@/app/components/ConfirmDialog";
import PageHeader from "@/app/components/PageHeader";
import { formatDateTime } from "@/app/lib/format";
import { SkeletonTable } from "@/app/components/Skeleton";
import { useUISound } from "@/app/hooks/useUISound";
import { usePageMotion } from "@/app/lib/motion";
import {
  getPlayerHistory,
  getServerStatus,
  runRconCommand,
  IpcError,
  type PlayerHistoryRow,
  type ServerStatus,
} from "@/app/lib/ipc";

export default function PlayersPage() {
  const { containerMotion, cardMotion } = usePageMotion();
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
      toast.danger(
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
      <div className="min-h-screen bg-background">
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
              <Card.Header className="font-pixel text-xs tracking-wide text-accent">
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
                  <span className="text-sm text-muted">No players online</span>
                )}
              </Card.Content>
            </Card>
          </motion.div>

          <motion.div variants={cardMotion}>
            <Card className="p-5">
              <Card.Header className="font-pixel text-xs tracking-wide text-accent">
                Server Details
              </Card.Header>
              <Card.Content className="mt-4 grid gap-2 text-sm text-muted">
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
            <Card.Header className="border-b border-border p-5">
              <div className="font-pixel text-xs tracking-wide text-accent">
                User Management
              </div>
              <div className="mt-4 flex flex-wrap gap-3 text-sm">
                <div className="flex items-center gap-2">
                  <Search size={16} className="text-muted" />
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
                  <Filter size={16} className="text-muted" />
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
            <Card.Content className="p-0">
              <Table>
                <Table.ScrollContainer>
                  <Table.Content aria-label="Player history" className="min-w-180">
                    <Table.Header>
                      <Table.Column isRowHeader>Username</Table.Column>
                      <Table.Column>Last Seen</Table.Column>
                      <Table.Column>IP Address</Table.Column>
                      <Table.Column>Actions</Table.Column>
                    </Table.Header>
                    <Table.Body
                      items={filteredUsers}
                      renderEmptyState={() => (
                        <EmptyState size="sm">
                          <EmptyState.Description>
                            No player data available.
                          </EmptyState.Description>
                        </EmptyState>
                      )}
                    >
                      {(row) => (
                        <Table.Row id={row.username}>
                          <Table.Cell>
                            <div className="flex items-center gap-2 font-semibold">
                              {row.username}
                              {row.isOnline && (
                                // Static, not animate-pulse: the dashboard's
                                // online-status dot is the one ambient loop
                                // this app budgets (docs/theme-contract.md §6);
                                // a pulsing dot per online player here would
                                // multiply that on a single screen.
                                <span className="inline-block h-2 w-2 rounded-full bg-accent" />
                              )}
                            </div>
                          </Table.Cell>
                          <Table.Cell className="text-muted">
                            {formatDateTime(row.lastSeenEpochMs)}
                          </Table.Cell>
                          <Table.Cell className="text-muted">
                            {row.ipAddress ?? "—"}
                          </Table.Cell>
                          <Table.Cell>
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
