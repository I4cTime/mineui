"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { motion } from "motion/react";
import {
  Archive,
  ArchiveRestore,
  CheckCircle2,
  Loader2,
  Plus,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { Button, Card, Chip, Table, toast } from "@heroui/react";
import { EmptyState } from "@heroui-pro/react";
import ConfirmDialog from "@/app/components/ConfirmDialog";
import PageHeader from "@/app/components/PageHeader";
import ServerStateNotice from "@/app/components/ServerStateNotice";
import { useServers } from "@/app/components/ServerProvider";
import { formatBytes, formatDateTime } from "@/app/lib/format";
import { SkeletonTable } from "@/app/components/Skeleton";
import { useUISound } from "@/app/hooks/useUISound";
import { usePageMotion } from "@/app/lib/motion";
import {
  createBackup,
  deleteBackup,
  getSettings,
  listBackups,
  restoreBackup,
  IpcError,
  type BackupEntry,
  type BackupSettings,
} from "@/app/lib/ipc";

type PendingAction =
  | { kind: "restore"; entry: BackupEntry }
  | { kind: "delete"; entry: BackupEntry };

// createBackup() may also report which old backups the retention setting
// removed; older backends only return the new entry.
type CreatedBackup = BackupEntry & { pruned?: string[] };

export default function BackupsPage() {
  const { containerMotion, cardMotion } = usePageMotion();
  const [backups, setBackups] = useState<BackupEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [working, setWorking] = useState(false);
  const busy = creating || working;
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [restoredNote, setRestoredNote] = useState<string | null>(null);
  const [retention, setRetention] = useState<BackupSettings | null>(null);
  const { play } = useUISound();
  const { overview, activeId } = useServers();
  const phase = overview.find((item) => item.id === activeId)?.phase;
  // Restoring swaps the world folder under a running server: stopped only.
  const canRestore = phase === "stopped" || phase === "crashed";
  const restoreBlockedReason = "The server has to be stopped to restore a backup.";

  const refresh = useCallback(
    () =>
      listBackups()
        .then((entries) => {
          setBackups(
            [...entries].sort((a, b) => b.createdAtEpochMs - a.createdAtEpochMs),
          );
          setListError(null);
        })
        .catch((error) => {
          // An unreadable list is not an empty list.
          setListError(error instanceof IpcError ? error.message : "The list could not be read.");
        }),
    [],
  );

  useEffect(() => {
    refresh().finally(() => setLoading(false));
    getSettings()
      .then((settings) => setRetention(settings.backups))
      .catch(() => setRetention(null));
  }, [refresh]);

  const handleCreate = async () => {
    play("click_confirm");
    setCreating(true);
    setRestoredNote(null);
    try {
      const result: CreatedBackup = await createBackup();
      const pruned = result.pruned ?? [];
      play("success");
      if (pruned.length) {
        const keeping = retention?.keepLast ? ` (keeping ${retention.keepLast})` : "";
        toast.success(
          pruned.length === 1
            ? `Backup created. Oldest backup ${pruned[0]} was removed${keeping}.`
            : `Backup created. ${pruned.length} oldest backups were removed${keeping}: ${pruned.join(", ")}.`,
        );
      } else {
        toast.success(`Backup created: ${result.filename}`);
      }
      await refresh();
    } catch (error) {
      play("error");
      toast.danger(error instanceof IpcError ? error.message : "Backup failed");
    } finally {
      setCreating(false);
    }
  };

  const runPending = async () => {
    if (!pending) return;
    setWorking(true);
    try {
      if (pending.kind === "restore") {
        await restoreBackup(pending.entry.filename);
        play("success");
        const note = `World restored from ${formatDateTime(pending.entry.createdAtEpochMs)}. Start the server to play. The previous world was kept as a '.pre-restore' folder in the server's data.`;
        setRestoredNote(note);
        toast.success(note);
      } else {
        await deleteBackup(pending.entry.filename);
        play("success");
        toast.success("Backup deleted");
      }
      await refresh();
    } catch (error) {
      play("error");
      toast.danger(
        error instanceof IpcError
          ? error.message
          : `${pending.kind === "restore" ? "Restore" : "Delete"} failed`,
      );
    } finally {
      setWorking(false);
      setPending(null);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-background">
        <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 px-4 py-10 md:px-6">
          <div className="h-16" />
          <SkeletonTable rows={4} cols={4} />
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
        className="page-main mx-auto flex max-w-5xl flex-col gap-6 px-4 pt-5 pb-10 md:px-6"
        initial="hidden"
        animate="show"
        variants={containerMotion}
      >
        <PageHeader
          title="World Backups"
          icon={Archive}
          actions={
            <Button
              onPress={handleCreate}
              isDisabled={busy}
              onMouseEnter={() => play("hover")}
            >
              {creating ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <Plus size={16} />
              )}
              {creating ? "Backing up…" : "Create backup"}
            </Button>
          }
        />

        {restoredNote && (
          <motion.section variants={cardMotion} initial="hidden" animate="show">
            <div
              role="status"
              className="flex items-start gap-2 rounded-lg border border-success p-3 text-sm"
            >
              <CheckCircle2 size={16} className="mt-0.5 shrink-0 text-success" />
              <span>{restoredNote}</span>
            </div>
          </motion.section>
        )}

        {backups.length > 0 && !canRestore && (
          <ServerStateNotice need="stopped" what="to restore a backup" />
        )}

        <motion.section variants={cardMotion}>
          <Card className="p-5">
            <Card.Header className="flex flex-col items-start gap-2 text-sm">
              <div className="flex flex-wrap items-center gap-3">
                {!listError && (
                  <Chip variant="soft" color="accent">
                    {backups.length} backup{backups.length === 1 ? "" : "s"}
                  </Chip>
                )}
                {creating && (
                  <span role="status" className="text-xs text-muted">
                    Large worlds can take a few minutes. You can keep using the app.
                  </span>
                )}
              </div>
              {retention && (
                <div className="flex flex-col gap-1 text-xs text-muted">
                  <span>
                    {retention.keepLast > 0
                      ? `Keeps the newest ${retention.keepLast} - older backups are deleted automatically. `
                      : "Keeps every backup. "}
                    {retention.keepLast > 0 && (
                      <>
                        Change in{" "}
                        <Link href="/settings" className="text-accent underline">
                          Server Settings
                        </Link>
                      </>
                    )}
                  </span>
                  <span>
                    {retention.copyDir ? (
                      `Also copied to ${retention.copyDir}`
                    ) : (
                      <>
                        No second copy set up - add a folder in{" "}
                        <Link href="/settings" className="text-accent underline">
                          Server Settings
                        </Link>
                      </>
                    )}
                  </span>
                </div>
              )}
              <span className="text-xs text-muted">
                Backups are stored with the server&apos;s own files. You can make one while
                the server runs; restoring needs it stopped.
              </span>
            </Card.Header>
            <Card.Content className="mt-4 p-0">
              {listError ? (
                <div
                  role="alert"
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-danger p-3 text-sm"
                >
                  <span className="flex items-start gap-2">
                    <TriangleAlert size={16} className="mt-0.5 shrink-0 text-danger" />
                    <span>Couldn&apos;t read the backups: {listError}</span>
                  </span>
                  <Button
                    size="sm"
                    variant="secondary"
                    onPress={() => {
                      play("click_confirm");
                      void refresh();
                    }}
                    onMouseEnter={() => play("hover")}
                  >
                    Try again
                  </Button>
                </div>
              ) : (
              <Table>
                <Table.ScrollContainer>
                  <Table.Content aria-label="World backups" className="min-w-180">
                    <Table.Header>
                      <Table.Column isRowHeader>Filename</Table.Column>
                      <Table.Column>Created</Table.Column>
                      <Table.Column>Size</Table.Column>
                      <Table.Column>Actions</Table.Column>
                    </Table.Header>
                    <Table.Body
                      items={backups}
                      renderEmptyState={() => (
                        <EmptyState size="sm">
                          <EmptyState.Description>
                            No backups yet. Create one to protect your world.
                          </EmptyState.Description>
                        </EmptyState>
                      )}
                    >
                      {(entry) => (
                        <Table.Row id={entry.filename}>
                          <Table.Cell className="font-mono text-xs">
                            {entry.filename}
                          </Table.Cell>
                          <Table.Cell className="text-muted">
                            {formatDateTime(entry.createdAtEpochMs)}
                          </Table.Cell>
                          <Table.Cell className="text-muted">
                            {formatBytes(entry.sizeBytes)}
                          </Table.Cell>
                          <Table.Cell>
                            <div className="flex flex-wrap gap-1">
                              <span title={canRestore ? undefined : restoreBlockedReason}>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  isDisabled={busy || !canRestore}
                                  onPress={() => {
                                    play("click_confirm");
                                    setPending({ kind: "restore", entry });
                                  }}
                                  onMouseEnter={() => play("hover")}
                                >
                                  <ArchiveRestore size={12} />
                                  Restore
                                </Button>
                              </span>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="text-danger hover:text-danger-soft-foreground"
                                isDisabled={busy}
                                onPress={() => {
                                  play("click_confirm");
                                  setPending({ kind: "delete", entry });
                                }}
                                onMouseEnter={() => play("hover")}
                              >
                                <Trash2 size={12} />
                                Delete
                              </Button>
                            </div>
                          </Table.Cell>
                        </Table.Row>
                      )}
                    </Table.Body>
                  </Table.Content>
                </Table.ScrollContainer>
              </Table>
              )}
            </Card.Content>
          </Card>
        </motion.section>

        <ConfirmDialog
          isOpen={pending !== null}
          title={
            pending?.kind === "restore" ? "Restore this backup?" : "Delete backup?"
          }
          description={
            pending?.kind === "restore"
              ? `Restore the backup from ${formatDateTime(pending.entry.createdAtEpochMs)} (${formatBytes(pending.entry.sizeBytes)})? The world goes back to how it was then - anything built since is no longer in the live world. The current world is not deleted: it is kept next to it as a folder named '<world>.pre-restore-<time>'.`
              : `Delete ${pending?.entry.filename ?? ""}? This cannot be undone.`
          }
          confirmLabel={pending?.kind === "restore" ? "Restore" : "Delete"}
          cancelLabel="Cancel"
          variant="danger"
          isLoading={working}
          isConfirmDisabled={pending?.kind === "restore" && !canRestore}
          onCancel={() => setPending(null)}
          onConfirm={runPending}
        />
      </motion.main>
    </div>
  );
}
