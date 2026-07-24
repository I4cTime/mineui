"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { toast } from "sonner";
import { Coffee, Download, HardDrive, Loader2, Rocket } from "lucide-react";
import { Button, Card, Chip, Label, ListBox, Select } from "@heroui/react";
import {
  createInstance,
  javaCheck,
  listMcVersions,
  onDownloadProgress,
  IpcError,
  type DownloadProgressEvent,
  type JavaCheck,
  type McVersion,
} from "@/app/lib/ipc";
import { useUISound } from "@/app/hooks/useUISound";

const MEMORY_MIN = 512;
const MEMORY_MAX = 16384;
const MEMORY_STEP = 512;

const formatBytes = (value: number) => {
  const units = ["B", "KB", "MB", "GB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
};

type CreateServerFlowProps = {
  defaultMemoryMb: number;
  onCreated: () => void;
};

export default function CreateServerFlow({
  defaultMemoryMb,
  onCreated,
}: CreateServerFlowProps) {
  const [versions, setVersions] = useState<McVersion[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(true);
  const [includeSnapshots, setIncludeSnapshots] = useState(false);
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null);
  const [memoryMb, setMemoryMb] = useState(
    Math.min(Math.max(defaultMemoryMb, MEMORY_MIN), MEMORY_MAX),
  );
  const [eulaAccepted, setEulaAccepted] = useState(false);
  const [java, setJava] = useState<JavaCheck | null>(null);
  const [creating, setCreating] = useState(false);
  const [progress, setProgress] = useState<DownloadProgressEvent | null>(null);
  const createdRef = useRef(false);
  const { play } = useUISound();

  const loadVersions = useCallback((snapshots: boolean) => {
    setVersionsLoading(true);
    listMcVersions(snapshots || undefined)
      .then((list) => {
        setVersions(list);
        setSelectedVersion(
          (current) =>
            current ?? list.find((v) => v.latest && v.type === "release")?.id ?? null,
        );
      })
      .catch((error: unknown) => {
        toast.error(
          error instanceof IpcError
            ? error.message
            : "Failed to load Minecraft versions.",
        );
      })
      .finally(() => setVersionsLoading(false));
  }, []);

  useEffect(() => {
    loadVersions(false);
    javaCheck()
      .then(setJava)
      .catch(() => setJava(null));
  }, [loadVersions]);

  const handleCreate = async () => {
    if (!selectedVersion || !eulaAccepted || creating) return;
    play("click_confirm");
    setCreating(true);
    setProgress(null);
    const unlisten = await onDownloadProgress((event) => {
      if (event.kind === "server-jar") setProgress(event);
    });
    try {
      await createInstance({
        mcVersion: selectedVersion,
        acceptEula: true,
        memoryMb,
      });
      play("success");
      toast.success(`Server ${selectedVersion} created`);
      createdRef.current = true;
      onCreated();
    } catch (error) {
      play("error");
      toast.error(
        error instanceof IpcError ? error.message : "Failed to create server.",
      );
    } finally {
      unlisten();
      setCreating(false);
    }
  };

  const progressPercent =
    progress && progress.totalBytes
      ? Math.min(100, (progress.receivedBytes / progress.totalBytes) * 100)
      : null;

  const javaMissing = java !== null && !java.found;
  const javaIncompatible = java?.compatible === false;

  return (
    <motion.section
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35 }}
    >
      <Card className="mx-auto max-w-2xl p-6">
        <Card.Header className="flex-col items-start gap-2">
          <div className="flex items-center gap-3 text-sm text-[var(--accent)]">
            <Rocket size={18} />
            <span className="font-pixel text-xs tracking-wide">
              Create your server
            </span>
          </div>
          <Card.Description>
            MineUI downloads the official server for the version you pick and
            manages it for you. No containers required.
          </Card.Description>
        </Card.Header>

        <Card.Content className="mt-4 grid gap-6 text-sm">
          {/* Version picker */}
          <div className="grid gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs uppercase tracking-[0.2em] text-[var(--muted)]">
                Minecraft version
              </span>
              <label className="flex items-center gap-2 text-xs text-[var(--muted)]">
                <input
                  type="checkbox"
                  checked={includeSnapshots}
                  onChange={(event) => {
                    setIncludeSnapshots(event.target.checked);
                    loadVersions(event.target.checked);
                  }}
                />
                Include snapshots
              </label>
            </div>
            <Select
              className="w-full text-sm"
              placeholder={versionsLoading ? "Loading versions..." : "Pick a version"}
              value={selectedVersion}
              onChange={(value) => {
                if (value === null) return;
                play("click_confirm");
                setSelectedVersion(String(value));
              }}
              isDisabled={versionsLoading || creating}
            >
              <Label className="sr-only">Minecraft version</Label>
              <Select.Trigger onMouseEnter={() => play("hover")}>
                <Select.Value />
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover>
                <ListBox className="max-h-72 overflow-auto">
                  {versions.map((version) => (
                    <ListBox.Item
                      key={version.id}
                      id={version.id}
                      textValue={version.id}
                    >
                      {version.id}
                      {version.latest ? " (latest)" : ""}
                      {version.type !== "release" ? ` — ${version.type}` : ""}
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  ))}
                </ListBox>
              </Select.Popover>
            </Select>
          </div>

          {/* Memory */}
          <div className="grid gap-2">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2 text-xs uppercase tracking-[0.2em] text-[var(--muted)]">
                <HardDrive size={14} />
                Memory
              </span>
              <Chip variant="soft" color="accent">
                {memoryMb} MB
              </Chip>
            </div>
            <input
              type="range"
              min={MEMORY_MIN}
              max={MEMORY_MAX}
              step={MEMORY_STEP}
              value={memoryMb}
              disabled={creating}
              onChange={(event) => setMemoryMb(event.target.valueAsNumber)}
              className="w-full accent-[var(--accent)]"
              aria-label="Server memory in megabytes"
            />
            <span className="text-xs text-[var(--muted)]">
              JVM heap (-Xms/-Xmx). 2048 MB is a good default for a small
              vanilla server.
            </span>
          </div>

          {/* Java check */}
          <div className="grid gap-2">
            <span className="flex items-center gap-2 text-xs uppercase tracking-[0.2em] text-[var(--muted)]">
              <Coffee size={14} />
              Java
            </span>
            {java === null ? (
              <span className="text-xs text-[var(--muted)]">Checking Java...</span>
            ) : java.found ? (
              <div className="flex flex-wrap items-center gap-2">
                <Chip
                  variant="soft"
                  color={javaIncompatible ? "warning" : "success"}
                >
                  Java {java.version ?? "?"} found
                </Chip>
                {java.path && (
                  <span className="truncate text-xs text-[var(--muted)]">
                    {java.path}
                  </span>
                )}
              </div>
            ) : (
              <div className="grid gap-1">
                <Chip variant="soft" color="warning">
                  No Java found
                </Chip>
                <span className="text-xs text-[var(--muted)]">
                  Recent Minecraft servers need Java 21+. Install it (e.g.{" "}
                  <code className="font-mono">
                    sudo apt install openjdk-21-jre-headless
                  </code>
                  ) or set a Java path override in Settings, then try again.
                </span>
              </div>
            )}
          </div>

          {/* EULA */}
          <label className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={eulaAccepted}
              disabled={creating}
              onChange={(event) => {
                play(event.target.checked ? "toggle_on" : "click_back");
                setEulaAccepted(event.target.checked);
              }}
            />
            <span>
              I accept the{" "}
              <a
                href="https://aka.ms/MinecraftEULA"
                target="_blank"
                rel="noreferrer"
                className="underline text-[var(--accent)]"
              >
                Minecraft End User License Agreement
              </a>
              .
            </span>
          </label>

          {/* Download progress */}
          {creating && (
            <div className="grid gap-2">
              <div className="flex items-center justify-between text-xs text-[var(--muted)]">
                <span className="flex items-center gap-2">
                  <Download size={14} />
                  {progress
                    ? `Downloading ${progress.filename}`
                    : "Preparing download..."}
                </span>
                <span>
                  {progress
                    ? progress.totalBytes
                      ? `${formatBytes(progress.receivedBytes)} / ${formatBytes(progress.totalBytes)}`
                      : formatBytes(progress.receivedBytes)
                    : ""}
                </span>
              </div>
              <div
                className="h-2 w-full overflow-hidden rounded-full"
                style={{ background: "var(--border)" }}
                role="progressbar"
                aria-valuenow={progressPercent ?? undefined}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <motion.div
                  className="h-full rounded-full"
                  style={{ background: "var(--accent)" }}
                  animate={{
                    width:
                      progressPercent !== null ? `${progressPercent}%` : "100%",
                    opacity: progressPercent !== null ? 1 : [0.3, 0.8, 0.3],
                  }}
                  transition={
                    progressPercent !== null
                      ? { duration: 0.2 }
                      : { duration: 1.4, repeat: Infinity }
                  }
                />
              </div>
            </div>
          )}
        </Card.Content>

        <Card.Footer className="mt-6 flex items-center justify-end gap-3">
          <Button
            onPress={handleCreate}
            isDisabled={
              !eulaAccepted ||
              !selectedVersion ||
              creating ||
              javaMissing ||
              createdRef.current
            }
            isPending={creating}
            onMouseEnter={() => play("hover")}
          >
            {creating ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                Creating...
              </>
            ) : (
              <>
                <Rocket size={16} />
                Create server
              </>
            )}
          </Button>
        </Card.Footer>
      </Card>
    </motion.section>
  );
}
