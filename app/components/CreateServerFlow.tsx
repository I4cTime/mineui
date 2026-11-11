"use client";

import { announceServerMade } from "@/app/lib/milestones";
import { TextShimmer } from "@heroui-pro/react";
import PressRipple from "@/app/components/PressRipple";
import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  toast,
  Button,
  Card,
  Chip,
  Disclosure,
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
  ChevronDown,
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
  requiredJavaMajor,
  IpcError,
  type DownloadProgressEvent,
  type JavaCheck,
  type McVersion,
} from "@/app/lib/ipc";
import DiscardServerButton from "@/app/components/DiscardServerButton";
import GetJavaForMe from "@/app/components/GetJavaForMe";
import OutLink from "@/app/components/OutLink";
import Term from "@/app/components/Term";
import { useUISound } from "@/app/hooks/useUISound";

const MEMORY_MIN = 512;
const MEMORY_MAX = 16384;
const MEMORY_STEP = 512;

type CreateServerFlowProps = {
  defaultMemoryMb: number;
  onCreated: () => void;
};

const STEPS = ["Version", "Requirements", "Create"] as const;

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
  const [moreOpen, setMoreOpen] = useState(false);
  // The Java major the chosen version needs; null = not known (offline).
  const [javaMajor, setJavaMajor] = useState<number | null>(null);
  const [majorChecked, setMajorChecked] = useState(false);
  const [progress, setProgress] = useState<DownloadProgressEvent | null>(null);
  const [created, setCreated] = useState(false);
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
    // eslint-disable-next-line react-hooks/set-state-in-effect -- IPC fetch-on-mount: the loader flips its loading flag synchronously by design
    loadVersions(false);
    recheckJava();
  }, [loadVersions, recheckJava]);

  useEffect(() => {
    if (!selectedVersion) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset while the new answer loads
    setMajorChecked(false);
    requiredJavaMajor(selectedVersion)
      .then((major) => {
        if (!cancelled) setJavaMajor(major);
      })
      .catch(() => {
        if (!cancelled) setJavaMajor(null);
      })
      .finally(() => {
        if (!cancelled) setMajorChecked(true);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedVersion]);

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
      announceServerMade(`Server ${selectedVersion} is ready. Press Start when you are.`);
      setCreated(true);
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
  const javaTooOld =
    java?.found === true &&
    javaMajor !== null &&
    java.majorVersion !== null &&
    java.majorVersion < javaMajor;
  const javaIncompatible = java?.compatible === false || javaTooOld;
  const needsJava = javaMissing || javaIncompatible;

  const canLeaveVersion = Boolean(selectedVersion);
  const canLeaveRequirements = eulaAccepted && !javaMissing;
  const canGoNext =
    (step === 0 && canLeaveVersion) || (step === 1 && canLeaveRequirements);

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
        <Card.Header className="flex-col items-stretch gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-3 text-sm text-accent">
              <Rocket size={18} />
              <span className="font-display text-xs tracking-wide">
                Create your server
              </span>
            </div>
            {/* An extra server added by mistake can be dropped from here;
                renders nothing for the first server. */}
            <DiscardServerButton isDisabled={creating} />
          </div>
          <Card.Description>
            MineUI downloads the official (plain,{" "}
            <Term term="Vanilla">vanilla</Term>) server for the version you pick
            and runs it on this computer. If your computer has no{" "}
            <Term term="Java">Java</Term>, MineUI can get it for you. Want mods,
            plugins or a <Term term="modpack">modpack</Term> instead? Add a{" "}
            <em>Modded or modpack server</em> in App Settings → Servers.
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
            <div className="grid gap-6">
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
                          {version.type !== "release" ? ` - ${version.type}` : ""}
                          <ListBox.ItemIndicator />
                        </ListBox.Item>
                      ))}
                    </ListBox>
                  </Select.Popover>
                </Select>
              </div>
              <Disclosure
                isExpanded={moreOpen}
                onExpandedChange={(open) => {
                  play(open ? "toggle_on" : "toggle_off");
                  setMoreOpen(open);
                }}
              >
                <Disclosure.Heading>
                  <Disclosure.Trigger
                    className="flex w-fit items-center gap-1.5 text-sm font-medium text-accent focus-visible:outline-2 focus-visible:outline-offset-2"
                    style={{ outlineColor: "var(--focus)" }}
                  >
                    More options
                    <Disclosure.Indicator className="ms-0 size-auto">
                      <ChevronDown size={14} />
                    </Disclosure.Indicator>
                  </Disclosure.Trigger>
                </Disclosure.Heading>
                <Disclosure.Content>
                  <Disclosure.Body style={{ padding: "0.75rem 0 0" }}>
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
                        How much of this computer&apos;s RAM the server may use. 2048 MB is a
                        good default for a small server.
                      </span>
                    </div>
                  </Disclosure.Body>
                </Disclosure.Content>
              </Disclosure>
            </div>
          )}

          {step === 1 && (
            <div className="grid gap-6">
              <div className="grid gap-2">
                <span className="flex items-center gap-2 text-xs uppercase tracking-[0.2em] text-muted">
                  <Coffee size={14} />
                  <Term term="Java">Java</Term>
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
                ) : (
                  <div className="grid gap-3">
                    <div className="flex flex-wrap items-center gap-2">
                      {java.found ? (
                        <>
                          <Chip
                            variant="soft"
                            color={javaIncompatible ? "warning" : "success"}
                          >
                            {java.managed
                              ? `Using Java MineUI downloaded (${java.majorVersion ?? java.version ?? "?"})`
                              : `Java ${java.version ?? "?"} found`}
                          </Chip>
                          {java.path && (
                            <span className="truncate text-xs text-muted">
                              {java.path}
                            </span>
                          )}
                        </>
                      ) : (
                        <Chip variant="soft" color="warning">
                          No Java found
                        </Chip>
                      )}
                    </div>
                    {needsJava && (
                      <div className="grid gap-3 rounded-lg border border-border p-4">
                        <p className="text-xs text-muted">
                          {javaMissing
                            ? "This computer has no Java, and the server needs it to run."
                            : `This Java is too old. Minecraft ${selectedVersion ?? ""} needs Java ${javaMajor ?? "a newer version"}.`}
                        </p>
                        {javaMajor !== null ? (
                          <GetJavaForMe
                            major={javaMajor}
                            isDisabled={creating}
                            onInstalled={(check) => setJava(check)}
                          />
                        ) : majorChecked ? (
                          <p className="text-xs text-muted">
                            MineUI cannot check which Java this version needs
                            right now. Check your internet and press Re-check.
                          </p>
                        ) : (
                          <span className="text-xs text-muted">Looking up which Java to get...</span>
                        )}
                        <details className="text-xs text-muted">
                          <summary className="w-fit cursor-pointer text-accent">
                            Or install it yourself
                          </summary>
                          <p className="mt-2">
                            On Windows and macOS, download it from{" "}
                            <OutLink
                              href="https://adoptium.net/temurin/releases/"
                              className="text-accent underline"
                            >
                              adoptium.net
                            </OutLink>
                            ; on Linux use your package manager (for example{" "}
                            <code className="font-mono">
                              sudo apt install openjdk-21-jre-headless
                            </code>
                            ). Then press Re-check. If Java is installed but not found,
                            set its location in this server&apos;s Settings → Advanced.
                          </p>
                        </details>
                      </div>
                    )}
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
                  <OutLink href="https://aka.ms/MinecraftEULA" className="underline text-accent">
                    Minecraft End User License Agreement
                  </OutLink>
                  .{" "}
                  <span className="text-muted">
                    Mojang&apos;s rules for running a server (
                    <Term term="EULA">what&apos;s the EULA?</Term>). Every Minecraft
                    server has to agree to them.
                  </span>
                </span>
              </label>
            </div>
          )}

          {step === 2 && (
            <div className="grid gap-4">
              <div className="grid gap-2 rounded-lg border border-border p-4 text-xs text-muted">
                <div className="flex justify-between">
                  <span>Version</span>
                  <span className="text-foreground">{selectedVersion ?? "-"}</span>
                </div>
                <div className="flex justify-between">
                  <span>Memory</span>
                  <span className="text-foreground">{memoryMb} MB</span>
                </div>
                <div className="flex justify-between">
                  <span>Java</span>
                  <span className="text-foreground">
                    {java?.found
                      ? java.managed
                        ? `MineUI's own Java ${java.majorVersion ?? java.version ?? "?"}`
                        : `${java.version ?? "?"} found`
                      : "not found"}
                  </span>
                </div>
              </div>

              {creating && (
                <div className="grid gap-2">
                  <div className="flex items-center justify-between text-xs text-muted">
                    <span className="flex items-center gap-2">
                      <Download size={14} />
                      <TextShimmer>
                        {progress
                          ? `Downloading ${progress.filename}`
                          : "Preparing download..."}
                      </TextShimmer>
                      {/* Completion tick - HeroUI's own CSS already animates
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
                created
              }
              isPending={creating}
              onMouseEnter={() => play("hover")}
            >
              <PressRipple />
              {creating ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  <TextShimmer>Creating...</TextShimmer>
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
