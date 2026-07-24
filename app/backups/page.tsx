"use client";

import { useCallback, useEffect, useState } from "react";
import { motion } from "motion/react";
import { Archive, ArchiveRestore, Loader2, Plus, Trash2 } from "lucide-react";
import { Button, Card, Chip, Table, toast } from "@heroui/react";
import { EmptyState } from "@heroui-pro/react";
import ConfirmDialog from "@/app/components/ConfirmDialog";
import PageHeader from "@/app/components/PageHeader";
import { SkeletonTable } from "@/app/components/Skeleton";
import { useUISound } from "@/app/hooks/useUISound";
import { listStagger, scaleIn } from "@/app/lib/motion";
import {
  createBackup,
  deleteBackup,
  listBackups,
  restoreBackup,
  IpcError,
  type BackupEntry,
} from "@/app/lib/ipc";

const formatBytes = (value: number) => {
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
};

type PendingAction =
  | { kind: "restore"; filename: string }
  | { kind: "delete"; filename: string };

export default function BackupsPage() {
  // Re-read on every render so a theme switch is picked up (docs/theme-contract.md §6).
  const containerMotion = listStagger();
  const cardMotion = scaleIn();
  const [backups, setBackups] = useState<BackupEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const { play } = useUISound();

  const refresh = useCallback(
    () =>
      listBackups()
        .then((entries) =>
          setBackups(
            [...entries].sort((a, b) => b.createdAtEpochMs - a.createdAtEpochMs),
          ),
        )
        .catch(() => setBackups([])),
    [],
  );

  useEffect(() => {
    refresh().finally(() => setLoading(false));
  }, [refresh]);

  const handleCreate = async () => {
    play("click_confirm");
    setBusy(true);
    try {
      const entry = await createBackup();
      play("success");
      toast.success(`Backup created: ${entry.filename}`);
      await refresh();
    } catch (error) {
      play("error");
      toast.danger(error instanceof IpcError ? error.message : "Backup failed");
    } finally {
      setBusy(false);
    }
  };

  const runPending = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      if (pending.kind === "restore") {
        await restoreBackup(pending.filename);
        play("success");
        toast.success("World restored. The previous world was kept alongside.");
      } else {
        await deleteBackup(pending.filename);
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
      setBusy(false);
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
        background: `radial-gradient(circle at top, color-mix(in oklab, var(--accent) 18%, transparent), transparent 60%), var(--background)`,
      }}
    >
      <motion.main
        className="page-main mx-auto flex max-w-5xl flex-col gap-6 px-4 py-10 md:px-6"
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
              {busy ? (
                <Loader2 size={16} className="animate-spin" />
              ) : (
                <Plus size={16} />
              )}
              Create backup
            </Button>
          }
        />

        <motion.section variants={cardMotion}>
          <Card className="p-5">
            <Card.Header className="flex flex-wrap items-center gap-3 text-sm">
              <Chip variant="soft" color="accent">
                {backups.length} backup{backups.length === 1 ? "" : "s"}
              </Chip>
              <span className="text-xs text-muted">
                Backups can be created while the server runs; run{" "}
                <code className="font-mono">save-all</code> first for a clean
                snapshot. Restoring requires the server to be stopped.
              </span>
            </Card.Header>
            <Card.Content className="mt-4 p-0">
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
                            {new Date(entry.createdAtEpochMs).toLocaleString()}
                          </Table.Cell>
                          <Table.Cell className="text-muted">
                            {formatBytes(entry.sizeBytes)}
                          </Table.Cell>
                          <Table.Cell>
                            <div className="flex flex-wrap gap-1">
                              <Button
                                size="sm"
                                variant="ghost"
                                isDisabled={busy}
                                onPress={() => {
                                  play("click_confirm");
                                  setPending({
                                    kind: "restore",
                                    filename: entry.filename,
                                  });
                                }}
                                onMouseEnter={() => play("hover")}
                              >
                                <ArchiveRestore size={12} />
                                Restore
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="text-danger hover:text-danger-soft-foreground"
                                isDisabled={busy}
                                onPress={() => {
                                  play("click_confirm");
                                  setPending({
                                    kind: "delete",
                                    filename: entry.filename,
                                  });
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
              ? `Restore ${pending.filename}? The server must be stopped. The current world is renamed and kept, not deleted.`
              : `Delete ${pending?.filename ?? ""}? This cannot be undone.`
          }
          confirmLabel={pending?.kind === "restore" ? "Restore" : "Delete"}
          cancelLabel="Cancel"
          variant="danger"
          isLoading={busy}
          onCancel={() => setPending(null)}
          onConfirm={runPending}
        />
      </motion.main>
    </div>
  );
}
