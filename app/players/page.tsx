"use client";

import { useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import {
  Check,
  Ellipsis,
  Filter,
  Pencil,
  RefreshCw,
  Search,
  Users,
  X,
} from "lucide-react";
import {
  Button,
  Card,
  Chip,
  Dropdown,
  Input,
  Label,
  ListBox,
  Select,
  Table,
  TextField,
  toast,
} from "@heroui/react";
import { EmptyState } from "@heroui-pro/react";
import ConfirmDialog from "@/app/components/ConfirmDialog";
import PageHeader from "@/app/components/PageHeader";
import ServerStateNotice from "@/app/components/ServerStateNotice";
import { useServers } from "@/app/components/ServerProvider";
import { formatDateTime } from "@/app/lib/format";
import { SkeletonTable } from "@/app/components/Skeleton";
import { useUISound } from "@/app/hooks/useUISound";
import { usePageMotion } from "@/app/lib/motion";
import {
  getPlayerHistory,
  getPlayerNotes,
  runRconCommand,
  setPlayerNote,
  IpcError,
  type PlayerHistoryRow,
  type PlayerNote,
} from "@/app/lib/ipc";

type ActionId = "whitelist" | "op" | "deop" | "ban" | "pardon" | "kick";

type ActionSpec = {
  label: string;
  command: string;
  /** Present = ask first. */
  confirm?: {
    title: (name: string) => string;
    description: (name: string) => string;
    label: (name: string) => string;
    danger: boolean;
  };
};

const ACTIONS: Record<ActionId, ActionSpec> = {
  whitelist: { label: "Whitelist", command: "whitelist add" },
  op: {
    label: "Make admin",
    command: "op",
    confirm: {
      title: () => "Make admin",
      description: (name) =>
        `Make ${name} an admin? Admins can run any command, including stopping the server and changing the world.`,
      label: () => "Make admin",
      danger: true,
    },
  },
  deop: { label: "Remove admin", command: "deop" },
  ban: {
    label: "Ban",
    command: "ban",
    confirm: {
      title: (name) => `Ban ${name}`,
      description: (name) =>
        `Ban ${name}? They are disconnected and cannot rejoin until you unban them.`,
      label: (name) => `Ban ${name}`,
      danger: true,
    },
  },
  pardon: { label: "Unban", command: "pardon" },
  kick: {
    label: "Kick",
    command: "kick",
    confirm: {
      title: (name) => `Kick ${name}`,
      description: (name) =>
        `Kick ${name}? They are disconnected now and can rejoin straight away.`,
      label: () => "Kick",
      danger: false,
    },
  },
};

// Vanilla replies that mean the change happened ("Added X to the whitelist",
// "Banned X: ...", "Kicked X: ..."). Anything else is shown neutrally, e.g.
// "Nothing changed. The player is already whitelisted".
const SUCCESS_REPLY = /^(added|removed|made|de-opped|banned|unbanned|kicked)\b/i;

const NOT_RUNNING_REASON = "Start the server to use this";

export default function PlayersPage() {
  const { containerMotion, cardMotion } = usePageMotion();
  const { activeId, overview } = useServers();
  const phase = overview.find((entry) => entry.id === activeId)?.phase ?? null;
  const running = phase === "running";
  const { play } = useUISound();

  const [users, setUsers] = useState<PlayerHistoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [presence, setPresence] = useState<"all" | "online" | "offline">("all");
  const [sort, setSort] = useState<"name-asc" | "last-seen-desc">("name-asc");
  const [pending, setPending] = useState<{ action: ActionId; username: string } | null>(null);
  // Operator notes (contract §3.11), keyed by lowercase username.
  const [notes, setNotes] = useState<Record<string, PlayerNote>>({});
  const [editingNote, setEditingNote] = useState<{ username: string; text: string } | null>(null);
  const [noteSaving, setNoteSaving] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);

  // Load on mount, when the server changes, when its phase changes, and when
  // a refresh is requested (reloadTick).
  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([getPlayerHistory(), getPlayerNotes()]).then(([usersRes, notesRes]) => {
      if (cancelled) return;
      const noteMap =
        notesRes.status === "fulfilled"
          ? Object.fromEntries(
              notesRes.value.notes.map((note) => [note.username.toLowerCase(), note]),
            )
          : null;
      if (noteMap) setNotes(noteMap);
      if (usersRes.status === "fulfilled") {
        setUsers(usersRes.value.users);
      } else {
        // Server unreachable (RCON_UNAVAILABLE): still show everyone we hold
        // a note for so notes stay readable and editable.
        const reason = usersRes.reason;
        if (!(reason instanceof IpcError && reason.code === "RCON_UNAVAILABLE")) {
          toast.danger(reason instanceof IpcError ? reason.message : "Could not load players.");
        }
        setUsers(
          Object.values(noteMap ?? {}).map((note) => ({
            username: note.username,
            lastSeenEpochMs: null,
            ipAddress: null,
            isOnline: false,
          })),
        );
      }
      setLoading(false);
      setRefreshing(false);
    });
    return () => {
      cancelled = true;
    };
  }, [activeId, phase, reloadTick]);

  const reload = () => setReloadTick((tick) => tick + 1);

  const refresh = () => {
    play("click_confirm");
    setRefreshing(true);
    reload();
  };

  const noteFor = (username: string) => notes[username.toLowerCase()];

  const saveNote = async (): Promise<boolean> => {
    if (!editingNote) return true;
    const { username, text } = editingNote;
    setNoteSaving(true);
    try {
      const saved = await setPlayerNote(username, text);
      setNotes((prev) => {
        const next = { ...prev };
        const key = username.toLowerCase();
        if (saved) next[key] = saved;
        else delete next[key];
        return next;
      });
      play("success");
      toast.success(saved ? "Note saved" : "Note cleared");
      setEditingNote(null);
      return true;
    } catch (error) {
      play("error");
      toast.danger(error instanceof IpcError ? error.message : "Could not save note");
      return false;
    } finally {
      setNoteSaving(false);
    }
  };

  const startEditingNote = async (username: string) => {
    play("click_confirm");
    if (editingNote && editingNote.username !== username) {
      // Never silently drop an unsaved edit: save it first, and stay on it if
      // that fails.
      const dirty = editingNote.text.trim() !== (noteFor(editingNote.username)?.note ?? "").trim();
      if (dirty && !(await saveNote())) return;
    }
    setEditingNote({ username, text: noteFor(username)?.note ?? "" });
  };

  const runAction = async (action: ActionId, username: string) => {
    const spec = ACTIONS[action];
    setActionBusy(true);
    try {
      const { output } = await runRconCommand(`${spec.command} ${username}`);
      const reply = output.trim();
      if (reply && SUCCESS_REPLY.test(reply)) {
        play("success");
        toast.success(reply);
      } else {
        play("click_confirm");
        toast(reply || "Done");
      }
    } catch (error) {
      play("error");
      toast.danger(
        error instanceof IpcError && error.code === "RCON_UNAVAILABLE"
          ? "The server isn't reachable - is it running?"
          : error instanceof Error
            ? error.message
            : "Command failed.",
      );
    } finally {
      setActionBusy(false);
      reload();
    }
  };

  const requestAction = (action: ActionId, username: string) => {
    if (ACTIONS[action].confirm) setPending({ action, username });
    else void runAction(action, username);
  };

  const onlineNames = useMemo(
    () =>
      users
        .filter((row) => row.isOnline)
        .map((row) => row.username)
        .sort((a, b) => a.localeCompare(b)),
    [users],
  );

  const filteredUsers = useMemo(() => {
    const needle = query.toLowerCase().trim();
    return users
      .filter((row) => {
        if (presence === "online") return row.isOnline;
        if (presence === "offline") return !row.isOnline;
        return true;
      })
      .filter((row) => {
        if (!needle) return true;
        return (
          row.username.toLowerCase().includes(needle) ||
          (row.ipAddress ?? "").toLowerCase().includes(needle)
        );
      })
      .sort((a, b) => {
        if (sort === "last-seen-desc") {
          return (b.lastSeenEpochMs ?? 0) - (a.lastSeenEpochMs ?? 0);
        }
        return a.username.localeCompare(b.username);
      });
  }, [users, query, presence, sort]);

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

  const actionsDisabled = !running || actionBusy;
  const disabledHint = running ? undefined : NOT_RUNNING_REASON;

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
        <PageHeader
          title="Players"
          icon={Users}
          actions={
            <Button size="sm" variant="secondary" onPress={refresh} isDisabled={refreshing}>
              <RefreshCw size={14} className={refreshing ? "animate-spin" : undefined} />
              Refresh
            </Button>
          }
        />

        <ServerStateNotice need="running" what="to see who is online and manage players" />

        <motion.section variants={cardMotion}>
          <Card className="p-5">
            <Card.Header className="font-pixel text-xs tracking-wide text-accent">
              Online now
            </Card.Header>
            <Card.Content className="mt-4">
              <div className="flex flex-wrap items-center gap-2">
                {onlineNames.length ? (
                  onlineNames.map((name) => (
                    <Chip key={name} variant="soft">
                      {name}
                    </Chip>
                  ))
                ) : (
                  <span className="text-sm text-muted">
                    {running ? "Nobody is online" : "The server isn't running"}
                  </span>
                )}
              </div>
            </Card.Content>
          </Card>
        </motion.section>

        <motion.section variants={cardMotion}>
          <Card className="overflow-hidden">
            <Card.Header className="border-b border-border p-5">
              <div className="font-pixel text-xs tracking-wide text-accent">Players</div>
              <p className="mt-2 text-xs text-muted">
                <strong className="font-semibold text-foreground">Whitelist</strong>: only
                whitelisted players can join when the whitelist is on.{" "}
                <strong className="font-semibold text-foreground">Admin (op)</strong>: can run any
                command, including stopping the server.
              </p>
              <div className="mt-4 flex flex-wrap gap-3 text-sm">
                <div className="flex items-center gap-2">
                  <Search size={16} className="text-muted" />
                  <TextField className="w-56">
                    <Label className="sr-only">Search</Label>
                    <Input
                      placeholder="Search name or IP"
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
                  <Table.Content aria-label="Players" className="min-w-180">
                    <Table.Header>
                      <Table.Column isRowHeader>Player</Table.Column>
                      <Table.Column>Last Seen</Table.Column>
                      <Table.Column>IP Address</Table.Column>
                      <Table.Column>Note</Table.Column>
                      <Table.Column>Actions</Table.Column>
                    </Table.Header>
                    {/* `dependencies`: react-aria caches the rows the render
                        function returns and only re-runs it when `items` or
                        these change. The cells read page state (note being
                        edited, notes, busy flags), so they must be listed or
                        the rows never update. */}
                    <Table.Body
                      items={filteredUsers}
                      dependencies={[editingNote, notes, noteSaving, actionsDisabled]}
                      renderEmptyState={() => (
                        <EmptyState size="sm">
                          <EmptyState.Description>
                            {users.length
                              ? "No players match your filters."
                              : "No players recorded yet. They appear here after they join."}
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
                                // this app budgets (docs/theme-contract.md §6).
                                <span
                                  role="img"
                                  aria-label="Online"
                                  title="Online"
                                  className="inline-block h-2 w-2 rounded-full bg-accent"
                                />
                              )}
                            </div>
                          </Table.Cell>
                          <Table.Cell className="text-muted">
                            {formatDateTime(row.lastSeenEpochMs)}
                          </Table.Cell>
                          <Table.Cell className="text-muted">{row.ipAddress ?? "-"}</Table.Cell>
                          <Table.Cell>
                            {editingNote?.username === row.username ? (
                              <div className="flex items-center gap-1">
                                <TextField className="w-56">
                                  <Label className="sr-only">Note for {row.username}</Label>
                                  <Input
                                    autoFocus
                                    maxLength={2000}
                                    placeholder="Add a note"
                                    value={editingNote.text}
                                    onChange={(event) =>
                                      setEditingNote({
                                        username: row.username,
                                        text: event.target.value,
                                      })
                                    }
                                    onKeyDown={(event) => {
                                      if (event.key === "Enter") void saveNote();
                                      if (event.key === "Escape") setEditingNote(null);
                                    }}
                                  />
                                </TextField>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  isIconOnly
                                  aria-label="Save note"
                                  onPress={() => void saveNote()}
                                  isDisabled={noteSaving}
                                  isPending={noteSaving}
                                >
                                  <Check size={14} />
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  isIconOnly
                                  aria-label="Cancel"
                                  onPress={() => setEditingNote(null)}
                                  isDisabled={noteSaving}
                                >
                                  <X size={14} />
                                </Button>
                              </div>
                            ) : (
                              <button
                                type="button"
                                className="group flex max-w-64 items-center gap-2 text-left text-sm"
                                onClick={() => void startEditingNote(row.username)}
                                onMouseEnter={() => play("hover")}
                                aria-label={`Edit note for ${row.username}`}
                              >
                                <span
                                  className={noteFor(row.username) ? "truncate" : "text-muted"}
                                >
                                  {noteFor(row.username)?.note ?? "Add note"}
                                </span>
                                <Pencil
                                  size={12}
                                  className="shrink-0 text-muted opacity-60 group-hover:opacity-100"
                                />
                              </button>
                            )}
                          </Table.Cell>
                          <Table.Cell>
                            <div className="flex items-center gap-1" title={disabledHint}>
                              <Button
                                size="sm"
                                variant="ghost"
                                isDisabled={actionsDisabled}
                                onPress={() => requestAction("whitelist", row.username)}
                                onMouseEnter={() => play("hover")}
                              >
                                Whitelist
                              </Button>
                              {row.isOnline && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  isDisabled={actionsDisabled}
                                  onPress={() => requestAction("kick", row.username)}
                                  onMouseEnter={() => play("hover")}
                                >
                                  Kick
                                </Button>
                              )}
                              <Button
                                size="sm"
                                variant="ghost"
                                isDisabled={actionsDisabled}
                                onPress={() => requestAction("ban", row.username)}
                                onMouseEnter={() => play("hover")}
                              >
                                Ban
                              </Button>
                              <Dropdown>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  isIconOnly
                                  isDisabled={actionsDisabled}
                                  aria-label={`More actions for ${row.username}`}
                                >
                                  <Ellipsis size={16} />
                                </Button>
                                <Dropdown.Popover>
                                  <Dropdown.Menu
                                    aria-label={`More actions for ${row.username}`}
                                    onAction={(key) => requestAction(key as ActionId, row.username)}
                                  >
                                    <Dropdown.Item id="op" textValue="Make admin">
                                      <Label>Make admin</Label>
                                    </Dropdown.Item>
                                    <Dropdown.Item id="deop" textValue="Remove admin">
                                      <Label>Remove admin</Label>
                                    </Dropdown.Item>
                                    <Dropdown.Item id="pardon" textValue="Unban">
                                      <Label>Unban</Label>
                                    </Dropdown.Item>
                                  </Dropdown.Menu>
                                </Dropdown.Popover>
                              </Dropdown>
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
          isOpen={pending !== null}
          title={pending ? (ACTIONS[pending.action].confirm?.title(pending.username) ?? "") : ""}
          description={
            pending ? ACTIONS[pending.action].confirm?.description(pending.username) : undefined
          }
          confirmLabel={
            pending ? ACTIONS[pending.action].confirm?.label(pending.username) : "Confirm"
          }
          cancelLabel="Cancel"
          variant={pending && ACTIONS[pending.action].confirm?.danger ? "danger" : "default"}
          onCancel={() => setPending(null)}
          onConfirm={() => {
            const current = pending;
            setPending(null);
            if (current) void runAction(current.action, current.username);
          }}
        />
      </motion.main>
    </div>
  );
}
