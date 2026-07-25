"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  toast,
  Button,
  Card,
  Chip,
  Label,
  ListBox,
  ProgressBar,
  Select,
  Slider,
} from "@heroui/react";
import { Stepper } from "@heroui-pro/react";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Coffee,
  Download,
  HardDrive,
  Loader2,
  RefreshCw,
  Rocket,
} from "lucide-react";
import { fadeUp, transition } from "@/app/lib/motion";
import { formatBytes } from "@/app/lib/format";
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

type CreateServerFlowProps = {
  defaultMemoryMb: number;
  onCreated: () => void;
};

const STEPS = ["Version", "Memory", "Requirements", "Create"] as const;

export default function CreateServerFlow({
  defaultMemoryMb,
  onCreated,
}: CreateServerFlowProps) {
  const [step, setStep] = useState(0);
  const [versions, setVersions] = useState<McVersion[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(true);
  const [includeSnapshots, setIncludeSnapshots] = useState(false);
  const [selectedVersion, setSelectedVersion] = useState<string | null>(null);
  const [memoryMb, setMemoryMb] = useState(
    Math.min(Math.max(defaultMemoryMb, MEMORY_MIN), MEMORY_MAX),
  );
  const [eulaAccepted, setEulaAccepted] = useState(false);
  const [java, setJava] = useState<JavaCheck | null>(null);
  const [javaChecking, setJavaChecking] = useState(false);
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
        toast.danger(
          error instanceof IpcError
            ? error.message
            : "Failed to load Minecraft versions.",
        );
      })
      .finally(() => setVersionsLoading(false));
  }, []);

  const recheckJava = useCallback(() => {
    setJavaChecking(true);
    javaCheck()
      .then(setJava)
      .catch(() => setJava(null))
      .finally(() => setJavaChecking(false));
  }, []);

  useEffect(() => {
    loadVersions(false);
    recheckJava();
  }, [loadVersions, recheckJava]);

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
      toast.danger(
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

  const canLeaveVersion = Boolean(selectedVersion);
  const canLeaveRequirements = eulaAccepted && !javaMissing;
  const canGoNext =
    (step === 0 && canLeaveVersion) ||
    step === 1 ||
    (step === 2 && canLeaveRequirements);

  const goNext = () => {
    if (!canGoNext || step >= STEPS.length - 1) return;
    play("click_confirm");
    setStep((s) => s + 1);
  };

  const goBack = () => {
    if (step <= 0 || creating) return;
    play("click_back");
    setStep((s) => s - 1);
  };

  return (
    <motion.section initial="hidden" animate="show" variants={fadeUp("base")}>
      <Card className="mx-auto max-w-2xl p-6">
        <Card.Header className="flex-col items-start gap-2">
          <div className="flex items-center gap-3 text-sm text-accent">
            <Rocket size={18} />
            <span className="font-display text-xs tracking-wide">
              Create your server
            </span>
          </div>
          <Card.Description>
            MineUI downloads the official server for the version you pick and
            manages it for you. No containers required.
          </Card.Description>
        </Card.Header>

        <Card.Content className="mt-2">
          <Stepper currentStep={step} size="sm">
            {STEPS.map((label) => (
              <Stepper.Step key={label}>
                <Stepper.Indicator />
                <Stepper.Content>
                  <Stepper.Title>{label}</Stepper.Title>
                </Stepper.Content>
                <Stepper.Separator />
              </Stepper.Step>
            ))}
          </Stepper>
        </Card.Content>

        <Card.Content className="mt-6 grid min-h-55 gap-6 text-sm">
          {step === 0 && (
            <div className="grid gap-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs uppercase tracking-[0.2em] text-muted">
                  Minecraft version
                </span>
                <label className="flex items-center gap-2 text-xs text-muted">
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
          )}

          {step === 1 && (
            <div className="grid gap-3">
              <span className="flex items-center gap-2 text-xs uppercase tracking-[0.2em] text-muted">
                <HardDrive size={14} />
                Memory
              </span>
              <Slider
                className="w-full"
                value={memoryMb}
                minValue={MEMORY_MIN}
                maxValue={MEMORY_MAX}
                step={MEMORY_STEP}
                isDisabled={creating}
                formatOptions={{ style: "unit", unit: "megabyte", unitDisplay: "short" }}
                onChange={(value) => setMemoryMb(value as number)}
              >
                <Label className="sr-only">Server memory in megabytes</Label>
                <Slider.Output />
                <Slider.Track>
                  <Slider.Fill />
                  <Slider.Thumb />
                </Slider.Track>
              </Slider>
              <span className="text-xs text-muted">
                JVM heap (-Xms/-Xmx). 2048 MB is a good default for a small
                vanilla server.
              </span>
            </div>
          )}

          {step === 2 && (
            <div className="grid gap-6">
              <div className="grid gap-2">
                <span className="flex items-center gap-2 text-xs uppercase tracking-[0.2em] text-muted">
                  <Coffee size={14} />
                  Java
                  <Button
                    variant="ghost"
                    size="sm"
                    isDisabled={javaChecking}
                    onPress={() => {
                      play("click_confirm");
                      recheckJava();
                    }}
                  >
                    <RefreshCw
                      size={13}
                      className={javaChecking ? "animate-spin" : undefined}
                    />
                    Re-check
                  </Button>
                </span>
                {java === null ? (
                  <span className="text-xs text-muted">Checking Java...</span>
                ) : java.found ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <Chip
                      variant="soft"
                      color={javaIncompatible ? "warning" : "success"}
                    >
                      Java {java.version ?? "?"} found
                    </Chip>
                    {java.path && (
                      <span className="truncate text-xs text-muted">
                        {java.path}
                      </span>
                    )}
                  </div>
                ) : (
                  <div className="grid gap-1">
                    <Chip variant="soft" color="warning">
                      No Java found
                    </Chip>
                    <span className="text-xs text-muted">
                      Recent Minecraft servers need Java 21+. Install it (e.g.{" "}
                      <code className="font-mono">
                        sudo apt install openjdk-21-jre-headless
                      </code>
                      ) or set a Java path override in Settings, then hit
                      Re-check.
                    </span>
                  </div>
                )}
              </div>

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
                    className="underline text-accent"
                  >
                    Minecraft End User License Agreement
                  </a>
                  .
                </span>
              </label>
            </div>
          )}

          {step === 3 && (
            <div className="grid gap-4">
              <div className="grid gap-2 rounded-lg border border-border p-4 text-xs text-muted">
                <div className="flex justify-between">
                  <span>Version</span>
                  <span className="text-foreground">{selectedVersion ?? "—"}</span>
                </div>
                <div className="flex justify-between">
                  <span>Memory</span>
                  <span className="text-foreground">{memoryMb} MB</span>
                </div>
                <div className="flex justify-between">
                  <span>Java</span>
                  <span className="text-foreground">
                    {java?.found ? `${java.version ?? "?"} found` : "not found"}
                  </span>
                </div>
              </div>

              {creating && (
                <div className="grid gap-2">
                  <div className="flex items-center justify-between text-xs text-muted">
                    <span className="flex items-center gap-2">
                      <Download size={14} />
                      {progress
                        ? `Downloading ${progress.filename}`
                        : "Preparing download..."}
                      {/* Completion tick — HeroUI's own CSS already animates
                          the fill's width (progress-bar.css), so this is a
                          separate element rather than layering a second
                          animation onto that same property. */}
                      <AnimatePresence>
                        {progressPercent === 100 && (
                          <motion.span
                            key="done"
                            initial={{ opacity: 0, scale: 0.6 }}
                            animate={{ opacity: 1, scale: 1 }}
                            exit={{ opacity: 0, scale: 0.6 }}
                            transition={transition("fast")}
                            className="inline-flex text-success"
                          >
                            <CheckCircle2 size={14} />
                          </motion.span>
                        )}
                      </AnimatePresence>
                    </span>
                    <span>
                      {progress
                        ? progress.totalBytes
                          ? `${formatBytes(progress.receivedBytes)} / ${formatBytes(progress.totalBytes)}`
                          : formatBytes(progress.receivedBytes)
                        : ""}
                    </span>
                  </div>
                  <ProgressBar
                    className="progress-bar-steps"
                    aria-label="Server download progress"
                    value={progressPercent ?? 0}
                    isIndeterminate={progressPercent === null}
                  >
                    <ProgressBar.Track>
                      <ProgressBar.Fill />
                    </ProgressBar.Track>
                  </ProgressBar>
                </div>
              )}
            </div>
          )}
        </Card.Content>

        <Card.Footer className="mt-6 flex items-center justify-between gap-3">
          <Button
            variant="secondary"
            onPress={goBack}
            isDisabled={step === 0 || creating}
            onMouseEnter={() => play("hover")}
          >
            <ArrowLeft size={16} />
            Back
          </Button>

          {step < STEPS.length - 1 ? (
            <Button
              onPress={goNext}
              isDisabled={!canGoNext}
              onMouseEnter={() => play("hover")}
            >
              Next
              <ArrowRight size={16} />
            </Button>
          ) : (
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
          )}
        </Card.Footer>
      </Card>
    </motion.section>
  );
}
