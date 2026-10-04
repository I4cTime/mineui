"use client";

// Server Settings (Simple) → Change Minecraft version (contract §3.6,
// change_instance_version): swap the server program in place, keeping the
// world. The backend backs the world up first and refuses to run while the
// server is up; a move to an older version needs an explicit extra tick,
// because an older Minecraft usually cannot open a newer world.
import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, TriangleAlert } from "lucide-react";
import { Label, ListBox, Select, toast } from "@heroui/react";
import ConfirmDialog from "@/app/components/ConfirmDialog";
import { useUISound } from "@/app/hooks/useUISound";
import {
  changeInstanceVersion,
  listMcVersions,
  IpcError,
  type ChangedInstanceVersion,
  type McVersion,
} from "@/app/lib/ipc";

interface ChangeVersionDialogProps {
  isOpen: boolean;
  serverName: string;
  currentVersion: string;
  onClose: () => void;
  onChanged: (result: ChangedInstanceVersion) => void;
}

export default function ChangeVersionDialog({
  isOpen,
  serverName,
  currentVersion,
  onClose,
  onChanged,
}: ChangeVersionDialogProps) {
  const { play } = useUISound();
  const [versions, setVersions] = useState<McVersion[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [allowDowngrade, setAllowDowngrade] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    listMcVersions()
      .then((list) => {
        if (!cancelled) {
          setVersions(list);
          setLoadError(null);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setLoadError(error instanceof IpcError ? error.message : "Could not load the version list.");
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  // Older or newer than what the server runs now? By release date; when
  // either date is unknown the backend treats it as a downgrade, so do we.
  const direction = useMemo<"up" | "down" | null>(() => {
    if (!target || !versions) return null;
    const from = versions.find((v) => v.id === currentVersion)?.releaseTime;
    const to = versions.find((v) => v.id === target)?.releaseTime;
    if (!from || !to) return "down";
    return Date.parse(to) > Date.parse(from) ? "up" : "down";
  }, [target, versions, currentVersion]);

  const close = () => {
    if (busy) return;
    setTarget(null);
    setAllowDowngrade(false);
    onClose();
  };

  const confirm = async () => {
    if (!target) return;
    setBusy(true);
    try {
      const result = await changeInstanceVersion(target, direction === "down" ? allowDowngrade : undefined);
      play("success");
      toast.success(
        result.backup
          ? `${serverName} is now on Minecraft ${result.toVersion}. The world was backed up first (${result.backup}).`
          : `${serverName} is now on Minecraft ${result.toVersion}.`,
      );
      setTarget(null);
      setAllowDowngrade(false);
      onChanged(result);
    } catch (error) {
      play("error");
      toast.danger(error instanceof IpcError ? error.message : "Could not change the version");
    } finally {
      setBusy(false);
    }
  };

  const choices = (versions ?? []).filter((v) => v.id !== currentVersion);

  return (
    <ConfirmDialog
      isOpen={isOpen}
      title="Change Minecraft version"
      description={`${serverName} runs Minecraft ${currentVersion}. MineUI downloads the server for the version you pick, makes a backup of the world, and switches — the world, settings and backups stay. Players need the same version to join.`}
      confirmLabel={busy ? "Working…" : target ? `Change to ${target}` : "Change version"}
      cancelLabel="Cancel"
      variant={direction === "down" ? "danger" : "default"}
      isLoading={busy}
      isConfirmDisabled={!target || (direction === "down" && !allowDowngrade)}
      onCancel={close}
      onConfirm={confirm}
      footer={
        <div className="grid gap-3">
          {loadError ? (
            <p role="alert" className="text-xs text-danger">
              {loadError}
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              <Label>New version</Label>
              <Select
                className="w-full text-sm"
                placeholder={versions === null ? "Loading versions…" : "Pick a version"}
                value={target}
                isDisabled={busy || versions === null}
                onChange={(value) => {
                  if (value === null) return;
                  play("click_confirm");
                  setTarget(String(value));
                  setAllowDowngrade(false);
                }}
              >
                <Label className="sr-only">New Minecraft version</Label>
                <Select.Trigger onMouseEnter={() => play("hover")}>
                  <Select.Value />
                  <Select.Indicator />
                </Select.Trigger>
                <Select.Popover>
                  <ListBox>
                    {choices.map((item) => (
                      <ListBox.Item key={item.id} id={item.id} textValue={item.id}>
                        {item.id}
                        {item.latest ? " (latest)" : ""}
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                    ))}
                  </ListBox>
                </Select.Popover>
              </Select>
            </div>
          )}

          {direction === "up" && (
            <p className="flex items-start gap-2 text-xs text-muted">
              <ArrowUp size={14} className="mt-0.5 shrink-0 text-success" />
              <span>
                Newer than {currentVersion}. Minecraft upgrades the world when the server next
                starts; after that the world cannot go back to {currentVersion} except by restoring
                the backup made now.
              </span>
            </p>
          )}
          {direction === "down" && (
            <>
              <p className="flex items-start gap-2 text-xs text-danger">
                <TriangleAlert size={14} className="mt-0.5 shrink-0" />
                <span>
                  <ArrowDown size={12} className="inline" /> Older than {currentVersion}. An older
                  Minecraft usually cannot open a world saved by a newer one — it may refuse to
                  start or damage the world. Only do this if the world was created on {target} or
                  earlier, or you plan to start a new world.
                </span>
              </p>
              <label className="flex items-start gap-3 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={allowDowngrade}
                  disabled={busy}
                  onChange={(event) => setAllowDowngrade(event.target.checked)}
                />
                <span>I understand — switch to the older version anyway</span>
              </label>
            </>
          )}
          {busy && (
            <p className="text-xs text-muted">
              Downloading the server and backing up the world — this can take a minute. Keep
              MineUI open.
            </p>
          )}
        </div>
      }
    />
  );
}
