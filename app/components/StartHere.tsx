"use client";

// Start here: the front door for a computer with no server yet. Two plain
// questions (what to play, who plays), one sentence about what MineUI will set
// up and why, a check of what this computer needs (Java, or a container
// program), then it creates and starts the server with the SAME calls and
// defaults as the two create flows. It is not a third creation path.
import { useCallback, useState } from "react";
import { motion } from "motion/react";
import {
  CheckCircle2,
  Loader2,
  Package,
  PackageOpen,
  RefreshCw,
  Rocket,
  Sparkles,
  Users,
  Wifi,
  Globe,
  User,
  Blocks,
  Cuboid,
  TriangleAlert,
} from "lucide-react";
import { Button, Card, Input, Label, ProgressBar, TextField } from "@heroui/react";
import { TextShimmer } from "@heroui-pro/react";
import PressRipple from "@/app/components/PressRipple";
import { announceServerMade } from "@/app/lib/milestones";
import ChoiceCards from "@/app/components/ChoiceCards";
import {
  containerNameFor,
  DEFAULT_CONTAINER_NAME,
  LATEST,
  MEMORY_DEFAULT,
  MEMORY_DEFAULT_MODPACK,
  newestVersionFor,
} from "@/app/components/CreateContainerFlow";
import GetJavaForMe from "@/app/components/GetJavaForMe";
import { useMode } from "@/app/components/ModeProvider";
import ModpackPicker, { type ModpackChoice } from "@/app/components/ModpackPicker";
import OutLink from "@/app/components/OutLink";
import RuntimeInstallHelp from "@/app/components/RuntimeInstallHelp";
import { useServers } from "@/app/components/ServerProvider";
import Term from "@/app/components/Term";
import { useUISound } from "@/app/hooks/useUISound";
import { formatBytes } from "@/app/lib/format";
import { fadeUp } from "@/app/lib/motion";
import {
  createContainer,
  createInstance,
  detectRuntimes,
  getSettings,
  javaCheck,
  listMcVersions,
  onDownloadProgress,
  requiredJavaMajor,
  setSettings,
  startServer,
  IpcError,
  type DownloadProgressEvent,
  type JavaCheck,
  type Mode,
  type RuntimeProbe,
} from "@/app/lib/ipc";

type Play = "normal" | "mods";
type Who = "me" | "home" | "friends";
type ModsPath = "pack" | "none";

const MEMORY_MIN = 512;
const MEMORY_MAX = 16384;
const SERVER_NAME_DEFAULT = "My server";
const MAX_NAME = 40;

const PLAY_OPTIONS = [
  {
    id: "normal" as const,
    title: "Normal Minecraft",
    description: "The game as it comes. No mods.",
    icon: Cuboid,
  },
  {
    id: "mods" as const,
    title: "Minecraft with mods",
    description: "Your own mods, or a ready-made pack of them.",
    icon: Blocks,
  },
];

const WHO_OPTIONS = [
  {
    id: "me" as const,
    title: "Just me",
    description: "Only this computer.",
    icon: User,
  },
  {
    id: "home" as const,
    title: "People at home",
    description: "Same Wi-Fi.",
    icon: Wifi,
  },
  {
    id: "friends" as const,
    title: "Friends in other places too",
    description: "Over the internet.",
    icon: Globe,
  },
];

const MODS_OPTIONS = [
  {
    id: "pack" as const,
    title: "Pick a modpack",
    description: "A ready-made bundle of mods.",
    icon: Package,
  },
  {
    id: "none" as const,
    title: "Start with no mods",
    description: "Add them later. MineUI uses Fabric.",
    icon: PackageOpen,
  },
];

type JavaState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "ready"; major: number; check: JavaCheck }
  | { kind: "need"; major: number; check: JavaCheck | null }
  | { kind: "offline" };

const javaIsEnough = (check: JavaCheck | null, major: number) =>
  check !== null &&
  check.found &&
  check.compatible !== false &&
  (check.majorVersion ?? 0) >= major;

interface StartHereProps {
  /** Called once Start here begins changing anything, so the page keeps it
   *  on screen while the server's kind and data load again behind it. */
  onActive: () => void;
  /** The server is made and started: land on the Dashboard. */
  onDone: (options: { friends: boolean }) => void;
  /** "I know what I want": show today's create flows instead. */
  onSkip: () => void;
}

export default function StartHere({ onActive, onDone, onSkip }: StartHereProps) {
  const { play } = useUISound();
  const { active, rename } = useServers();
  const { refresh: refreshMode } = useMode();

  const [what, setWhat] = useState<Play | "">("");
  const [who, setWho] = useState<Who | "">("");
  const [name, setName] = useState(SERVER_NAME_DEFAULT);
  const [java, setJava] = useState<JavaState>({ kind: "idle" });
  const [runtime, setRuntime] = useState<RuntimeProbe | null>(null);
  const [runtimeChecking, setRuntimeChecking] = useState(false);
  const [modsPath, setModsPath] = useState<ModsPath | "">("");
  const [modpack, setModpack] = useState<ModpackChoice | null>(null);
  const [eula, setEula] = useState(false);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<"idle" | "making" | "starting">("idle");
  const [progress, setProgress] = useState<DownloadProgressEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The server exists but did not start: Try again only starts it.
  const [made, setMade] = useState(false);
  // Once the server is made its answers are fixed: changing them could not
  // change the server Try again starts.
  const locked = busy || made;

  const checkJava = useCallback(async () => {
    setJava({ kind: "checking" });
    try {
      const major = await requiredJavaMajor(LATEST);
      if (major === null) {
        setJava({ kind: "offline" });
        return;
      }
      const check = await javaCheck().catch(() => null);
      setJava(
        javaIsEnough(check, major)
          ? { kind: "ready", major, check: check as JavaCheck }
          : { kind: "need", major, check },
      );
    } catch {
      setJava({ kind: "offline" });
    }
  }, []);

  const checkRuntime = useCallback(() => {
    setRuntimeChecking(true);
    detectRuntimes()
      .then(setRuntime)
      .catch(() => setRuntime(null))
      .finally(() => setRuntimeChecking(false));
  }, []);

  const chooseWhat = (next: Play) => {
    setWhat(next);
    setError(null);
    if (next === "normal") void checkJava();
    else checkRuntime();
  };

  const noRuntime = runtime !== null && runtime.resolved === null;
  const runtimeReady = runtime !== null && runtime.resolved !== null;
  const packVersion =
    modpack && modpack.gameVersions.length > 0 ? modpack.gameVersions[0] : "";

  // Everything the Create button needs, in the order it is asked for.
  const missing: string | null = (() => {
    if (what === "" || who === "") return "Answer both questions.";
    if (what === "normal") {
      if (java.kind === "checking" || java.kind === "idle") return "Checking this computer...";
      if (java.kind === "offline") return "MineUI cannot check this computer right now.";
      if (java.kind === "need") return "This computer needs Java first (see above).";
    } else {
      if (runtime === null) return "Checking this computer...";
      if (noRuntime) return "This computer needs Podman or Docker first (see above).";
      if (modsPath === "") return "Choose a modpack or start with no mods.";
      if (modsPath === "pack" && modpack === null) return "Pick a modpack.";
      if (modsPath === "pack" && packVersion === "") {
        return "MineUI cannot tell which Minecraft version this pack uses. Use \"I know what I want\" below to pick it.";
      }
    }
    if (!eula) return "Agree to the Minecraft rules to continue.";
    return null;
  })();

  const reasonSentence = (
    <>
      {what === "normal" ? (
        <>
          MineUI will run a normal Minecraft server on this computer, because it is the
          simplest way to play with no mods.
        </>
      ) : (
        <>
          MineUI will run a server with mods in a <Term term="container">container</Term> (a
          sealed box that keeps the server tidy), because mods need their own setup and the
          box keeps it apart from your other files.
        </>
      )}
      {what === "mods" && modsPath === "pack" && modpack && (
        <> It will start from {modpack.title}.</>
      )}
      {what === "mods" && modsPath === "none" && (
        <>
          {" "}
          It will start with no mods, on <Term term="Fabric">Fabric</Term>, so you can add
          mods later.
        </>
      )}
      {who === "me" && what === "mods" && <> Only this computer can join it.</>}
      {who === "home" && what === "mods" && <> Other devices on your Wi-Fi can join it.</>}
      {who === "friends" && what === "mods" && (
        <> Other devices can join it, and MineUI will show the steps for friends elsewhere.</>
      )}
      {who === "me" && what === "normal" && <> Only you will play, so there is nothing else to set up.</>}
      {who === "home" && what === "normal" && (
        <> When it is ready, MineUI shows the address people at home type to join.</>
      )}
      {who === "friends" && what === "normal" && (
        <> When it is ready, MineUI shows the address and the steps for friends elsewhere.</>
      )}
    </>
  );

  const run = async () => {
    if (missing !== null || busy || what === "" || who === "") return;
    play("click_confirm");
    setBusy(true);
    setError(null);
    setProgress(null);
    onActive();
    let unlisten: (() => void) | null = null;
    try {
      if (!made) {
        setStep("making");
        const wanted = name.trim().slice(0, MAX_NAME);
        let serverName = active.name;
        if (wanted !== "" && wanted !== active.name) {
          try {
            await rename(active.id, wanted);
            serverName = wanted;
          } catch {
            // A name that does not stick must not stop the server.
          }
        }

        // Normal Minecraft runs On this computer, mods run In a container.
        const wantMode: Mode = what === "normal" ? "simple" : "advanced";
        const current = await getSettings();
        if (current.activeMode !== wantMode) {
          await setSettings({ ...current, activeMode: wantMode });
          await refreshMode();
        }

        if (what === "normal") {
          unlisten = await onDownloadProgress((event) => {
            if (event.kind === "server-jar") setProgress(event);
          });
          const versions = await listMcVersions();
          const latest = versions.find((v) => v.latest && v.type === "release")?.id;
          if (!latest) {
            throw new IpcError("DOWNLOAD_FAILED", "MineUI could not find the newest Minecraft version.");
          }
          const memoryMb = Math.min(
            Math.max(current.simple.memoryMb || 2048, MEMORY_MIN),
            MEMORY_MAX,
          );
          await createInstance({ mcVersion: latest, acceptEula: true, memoryMb });
        } else {
          const containerName =
            current.advanced.containerName !== DEFAULT_CONTAINER_NAME
              ? current.advanced.containerName
              : containerNameFor(serverName);
          const withPack = modsPath === "pack" && modpack !== null;
          // No pack: the newest concrete version Fabric has a build for
          // (LATEST only when Fabric's list cannot be had, contract 3.13).
          const mcVersion = withPack ? packVersion : await newestVersionFor("fabric");
          await createContainer({
            loader: "fabric",
            mcVersion,
            containerName,
            memoryMb: withPack ? MEMORY_DEFAULT_MODPACK : MEMORY_DEFAULT,
            gamePort: current.advanced.queryPort,
            rconPort: current.advanced.rconPort,
            exposeToNetwork: who !== "me",
            extraPorts: [],
            acceptEula: true,
            modpack: withPack ? { source: modpack.source, project: modpack.project } : null,
          });
        }
        setMade(true);
      }

      setStep("starting");
      await startServer();
      play("success");
      announceServerMade("It is starting now. Give it a minute.");
      onDone({ friends: who === "friends" });
    } catch (e) {
      play("error");
      setError(
        e instanceof IpcError
          ? e.message
          : "Something went wrong. Nothing was lost, you can try again.",
      );
      setStep("idle");
      setBusy(false);
    } finally {
      unlisten?.();
    }
  };

  const percent =
    progress && progress.totalBytes
      ? Math.min(100, (progress.receivedBytes / progress.totalBytes) * 100)
      : null;

  const needsPanel = what !== "";

  return (
    <motion.section initial="hidden" animate="show" variants={fadeUp("base")}>
      <Card className="mx-auto max-w-2xl p-6" data-testid="start-here">
        <Card.Header className="flex-col items-stretch gap-2">
          <div className="flex items-center gap-3 text-sm text-accent">
            <Sparkles size={18} />
            <span className="font-display text-xs tracking-wide">Start here</span>
          </div>
          <Card.Title className="text-xl">Welcome to MineUI</Card.Title>
          <Card.Description>
            Let&apos;s make a Minecraft server for you and your friends. Answer two
            questions and MineUI does the rest.
          </Card.Description>
        </Card.Header>

        <Card.Content className="mt-4 grid gap-6 text-sm">
          <fieldset className="grid gap-2" disabled={locked}>
            <legend className="mb-2 text-sm font-semibold">1. What do you want to play?</legend>
            <ChoiceCards
              ripple
              aria-label="What do you want to play?"
              className="sm:grid-cols-2"
              options={PLAY_OPTIONS}
              value={what as Play}
              isDisabled={locked}
              onChange={chooseWhat}
            />
          </fieldset>

          <fieldset className="grid gap-2" disabled={locked}>
            <legend className="mb-2 text-sm font-semibold">2. Who will play?</legend>
            <ChoiceCards
              ripple
              aria-label="Who will play?"
              className="sm:grid-cols-3"
              options={WHO_OPTIONS}
              value={who as Who}
              isDisabled={locked}
              onChange={(next) => {
                setWho(next);
                setError(null);
              }}
            />
          </fieldset>

          {what !== "" && who !== "" && (
            <>
              <div
                className="flex items-start gap-3 rounded-lg border border-border p-4"
                data-testid="start-here-plan"
              >
                <Users size={18} className="mt-0.5 shrink-0 text-accent" />
                <p>{reasonSentence}</p>
              </div>

              <TextField
                className="flex max-w-sm flex-col gap-2"
                value={name}
                onChange={setName}
                isDisabled={locked}
                maxLength={MAX_NAME}
              >
                <Label>Name your server (you can change it later)</Label>
                <Input />
              </TextField>
            </>
          )}

          {needsPanel && what === "normal" && (
            <div className="grid gap-3" aria-live="polite" data-testid="start-here-needs">
              <span className="text-xs uppercase tracking-[0.2em] text-muted">
                What this computer needs
              </span>
              {(java.kind === "checking" || java.kind === "idle") && (
                <span className="flex items-center gap-2 text-muted">
                  <Loader2 size={14} className="animate-spin" />
                  Checking for <Term term="Java">Java</Term>...
                </span>
              )}
              {java.kind === "ready" && (
                <div className="flex flex-wrap items-center gap-2">
                  <CheckCircle2 size={16} className="text-success" />
                  <span>
                    {java.check.managed
                      ? `Using Java MineUI downloaded (${java.check.majorVersion ?? java.major})`
                      : `Java ${java.check.version ?? java.major} is on this computer. You are good to go.`}
                  </span>
                </div>
              )}
              {java.kind === "need" && (
                <div className="grid gap-3 rounded-lg border border-border p-4">
                  <p>
                    The newest Minecraft needs <Term term="Java">Java</Term> {java.major}.{" "}
                    {java.check?.found
                      ? "The Java on this computer is too old."
                      : "This computer does not have it yet."}{" "}
                    MineUI can get it for you.
                  </p>
                  <GetJavaForMe
                    major={java.major}
                    isDisabled={locked}
                    onInstalled={(check) =>
                      setJava(
                        javaIsEnough(check, java.major)
                          ? { kind: "ready", major: java.major, check }
                          : { kind: "need", major: java.major, check },
                      )
                    }
                  />
                </div>
              )}
              {java.kind === "offline" && (
                <div className="grid gap-2 rounded-lg border border-border p-4">
                  <p className="flex items-start gap-2">
                    <TriangleAlert size={16} className="mt-0.5 shrink-0 text-warning" />
                    MineUI cannot check what your computer needs right now. Check your
                    internet connection and try again.
                  </p>
                  <div>
                    <Button variant="secondary" size="sm" onPress={() => void checkJava()}>
                      <RefreshCw size={14} />
                      Try again
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}

          {needsPanel && what === "mods" && (
            <div className="grid gap-4" aria-live="polite" data-testid="start-here-needs">
              <span className="text-xs uppercase tracking-[0.2em] text-muted">
                What this computer needs
              </span>
              {runtime === null && (
                <span className="flex items-center gap-2 text-muted">
                  <Loader2 size={14} className="animate-spin" />
                  Looking for a program that runs <Term term="container">containers</Term>...
                </span>
              )}
              {noRuntime && (
                <div className="grid gap-2">
                  <p className="text-muted">
                    Servers with mods run in a container, and a container needs a free
                    program called <Term term="Podman">Podman</Term> or{" "}
                    <Term term="Docker">Docker</Term>. This computer does not have one yet.
                  </p>
                  <RuntimeInstallHelp onRecheck={checkRuntime} checking={runtimeChecking} />
                </div>
              )}
              {runtimeReady && (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <CheckCircle2 size={16} className="text-success" />
                    <span>
                      {runtime.resolved === "podman" ? "Podman" : "Docker"} is ready. You are
                      good to go.
                    </span>
                  </div>
                  <fieldset className="grid gap-2" disabled={locked}>
                    <legend className="mb-2 text-sm font-semibold">
                      Which mods do you want?
                    </legend>
                    <ChoiceCards
              ripple
                      aria-label="Which mods do you want?"
                      className="sm:grid-cols-2"
                      options={MODS_OPTIONS}
                      value={modsPath as ModsPath}
                      isDisabled={locked}
                      onChange={(next) => {
                        setModsPath(next);
                        if (next === "none") setModpack(null);
                      }}
                    />
                  </fieldset>
                  {modsPath === "pack" && (
                    <ModpackPicker value={modpack} onChange={setModpack} isDisabled={locked} />
                  )}
                </>
              )}
            </div>
          )}

          {what !== "" && who !== "" && (
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                className="mt-1"
                checked={eula}
                disabled={locked}
                onChange={(event) => {
                  play(event.target.checked ? "toggle_on" : "click_back");
                  setEula(event.target.checked);
                }}
              />
              <span>
                I agree to the{" "}
                <OutLink href="https://aka.ms/MinecraftEULA" className="text-accent underline">
                  Minecraft End User License Agreement
                </OutLink>
                .{" "}
                <span className="text-muted">
                  These are Mojang&apos;s rules for running a server (
                  <Term term="EULA">what&apos;s the EULA?</Term>). Every Minecraft server has
                  to agree to them.
                </span>
              </span>
            </label>
          )}

          {busy && (
            <div className="grid gap-2" role="status" data-testid="start-here-progress">
              <span className="flex items-center gap-2 text-xs text-muted">
                <Loader2 size={14} className="animate-spin" />
                <TextShimmer>
                  {step === "starting"
                    ? "Starting your server..."
                    : what === "mods"
                      ? "Making your server. The first time, MineUI downloads the server files (about 1 GB), which can take a few minutes."
                      : progress
                        ? `Downloading ${progress.filename}`
                        : "Making your server..."}
                </TextShimmer>
                {step !== "starting" && what === "normal" && progress?.totalBytes
                  ? ` ${formatBytes(progress.receivedBytes)} / ${formatBytes(progress.totalBytes)}`
                  : ""}
              </span>
              <ProgressBar
                className="progress-bar-steps"
                aria-label="Setting up your server"
                value={percent ?? 0}
                isIndeterminate={step === "starting" || what === "mods" || percent === null}
              >
                <ProgressBar.Track>
                  <ProgressBar.Fill />
                </ProgressBar.Track>
              </ProgressBar>
            </div>
          )}

          {error && (
            <div
              className="grid gap-2 rounded-lg border border-danger p-4"
              role="alert"
              data-testid="start-here-error"
            >
              <p className="font-semibold text-danger">That did not work.</p>
              <p>{error}</p>
              {made && (
                <p className="text-muted">
                  Your server is already made, so the answers above are locked. Only
                  starting it failed, and Try again just starts it.
                </p>
              )}
            </div>
          )}
        </Card.Content>

        <Card.Footer className="mt-6 flex flex-wrap items-center justify-between gap-3">
          <Button
            variant="ghost"
            isDisabled={busy}
            onPress={() => {
              play("click_confirm");
              onSkip();
            }}
            onMouseEnter={() => play("hover")}
          >
            I know what I want
          </Button>
          <div className="flex flex-wrap items-center gap-3">
            {missing !== null && !busy && what !== "" && who !== "" && (
              <span className="max-w-xs text-xs text-muted">{missing}</span>
            )}
            {what !== "" && who !== "" && (
              <Button
                onPress={run}
                isDisabled={missing !== null || busy}
                isPending={busy}
                onMouseEnter={() => play("hover")}
              >
                <PressRipple />
                {busy ? (
                  <>
                    <Loader2 size={16} className="animate-spin" />
                    <TextShimmer>Working...</TextShimmer>
                  </>
                ) : (
                  <>
                    <Rocket size={16} />
                    {error ? "Try again" : "Make my server"}
                  </>
                )}
              </Button>
            )}
          </div>
        </Card.Footer>
      </Card>
    </motion.section>
  );
}
