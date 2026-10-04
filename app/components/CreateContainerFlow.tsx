"use client";

// Dashboard onboarding for an advanced-mode server that has no container
// yet: create one from the itzg/minecraft-server image (contract §3.13) —
// pick a server type or a modpack, MineUI does the `run` and wires the
// server up. Without Podman or Docker it explains how to get one instead.
// The simple-mode counterpart is CreateServerFlow.
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { motion } from "motion/react";
import { Boxes, Container, HardDrive, Loader2, Package, Rocket, type LucideIcon } from "lucide-react";
import {
  Button,
  Card,
  Input,
  Label,
  ListBox,
  ProgressBar,
  Select,
  Slider,
  Switch,
  TextField,
  toast,
} from "@heroui/react";
import DiscardServerButton from "@/app/components/DiscardServerButton";
import ModpackPicker, { type ModpackChoice } from "@/app/components/ModpackPicker";
import RuntimeInstallHelp from "@/app/components/RuntimeInstallHelp";
import OutLink from "@/app/components/OutLink";
import { useUISound } from "@/app/hooks/useUISound";
import { fadeUp } from "@/app/lib/motion";
import {
  createContainer,
  detectRuntimes,
  listMcVersions,
  IpcError,
  type ContainerLoader,
  type McVersion,
  type RuntimeProbe,
  type Settings,
} from "@/app/lib/ipc";

const LATEST = "LATEST";
const DEFAULT_CONTAINER_NAME = "minecraft-server";
const MEMORY_MIN = 1024;
const MEMORY_MAX = 16384;
const MEMORY_STEP = 512;
const MEMORY_DEFAULT = 4096;
/** Modpacks are heavier than a bare loader. */
const MEMORY_DEFAULT_MODPACK = 6144;

/** What the new container runs. */
type Kind = "type" | "modpack";

const KINDS: { id: Kind; title: string; description: string; icon: LucideIcon }[] = [
  {
    id: "type",
    title: "A server type",
    description: "Vanilla, Paper, Fabric, Forge… You add mods or plugins yourself afterwards.",
    icon: Boxes,
  },
  {
    id: "modpack",
    title: "A modpack",
    description: "A ready-made pack from Modrinth or CurseForge, installed with its loader and mods.",
    icon: Package,
  },
];

const LOADERS: { id: ContainerLoader; label: string; hint: string }[] = [
  { id: "vanilla", label: "Vanilla", hint: "Mojang's own server. No mods or plugins." },
  { id: "paper", label: "Paper", hint: "Plugins (Bukkit/Spigot), tuned for performance." },
  { id: "purpur", label: "Purpur", hint: "Paper with extra gameplay switches." },
  { id: "fabric", label: "Fabric", hint: "Lightweight mod loader for Fabric mods." },
  { id: "quilt", label: "Quilt", hint: "Fabric-compatible mod loader." },
  { id: "forge", label: "Forge", hint: "The classic mod loader; most large modpacks." },
  { id: "neoforge", label: "NeoForge", hint: "Forge's successor, for 1.20.2 and newer." },
];

/** "Fabric survival" → "mc-fabric-survival" (container-name grammar). */
const containerNameFor = (serverName: string) => {
  const slug = serverName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug ? `mc-${slug}` : DEFAULT_CONTAINER_NAME;
};

const numberFrom = (event: React.ChangeEvent<HTMLInputElement>) => {
  const value = event.target.valueAsNumber;
  return Number.isFinite(value) ? value : 0;
};

interface CreateContainerFlowProps {
  serverName: string;
  settings: Settings;
  onCreated: () => void;
}

export default function CreateContainerFlow({
  serverName,
  settings,
  onCreated,
}: CreateContainerFlowProps) {
  const router = useRouter();
  const { play } = useUISound();
  const [kind, setKind] = useState<Kind>("type");
  const [modpack, setModpack] = useState<ModpackChoice | null>(null);
  const [runtime, setRuntime] = useState<RuntimeProbe | null>(null);
  const [runtimeChecking, setRuntimeChecking] = useState(false);
  const [loader, setLoader] = useState<ContainerLoader>("vanilla");
  const [versions, setVersions] = useState<McVersion[]>([]);
  const [version, setVersion] = useState(LATEST);
  const [containerName, setContainerName] = useState(
    settings.advanced.containerName !== DEFAULT_CONTAINER_NAME
      ? settings.advanced.containerName
      : containerNameFor(serverName),
  );
  const [memoryMb, setMemoryMb] = useState(MEMORY_DEFAULT);
  // Follow the kind's default until the user moves the slider themselves.
  const [memoryTouched, setMemoryTouched] = useState(false);
  const [gamePort, setGamePort] = useState(settings.advanced.queryPort);
  const [rconPort, setRconPort] = useState(settings.advanced.rconPort);
  const [exposeToNetwork, setExposeToNetwork] = useState(true);
  const [eulaAccepted, setEulaAccepted] = useState(false);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    // The list is a convenience — "Latest release" works without it.
    listMcVersions()
      .then(setVersions)
      .catch(() => setVersions([]));
  }, []);

  const checkRuntime = useCallback(() => {
    setRuntimeChecking(true);
    detectRuntimes()
      .then(setRuntime)
      .catch(() => setRuntime(null))
      .finally(() => setRuntimeChecking(false));
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- IPC fetch-on-mount: the loader flips its loading flag synchronously by design
    checkRuntime();
  }, [checkRuntime]);

  // Known to be missing (not merely unchecked): explain, and block Create.
  const noRuntime = runtime !== null && runtime.resolved === null;

  const changeKind = (next: Kind) => {
    if (next === kind || creating) return;
    play("toggle_on");
    setKind(next);
    setModpack(null);
    // A modpack needs a concrete version; a server type can take the latest.
    setVersion(next === "modpack" ? "" : LATEST);
    if (!memoryTouched) {
      setMemoryMb(next === "modpack" ? MEMORY_DEFAULT_MODPACK : MEMORY_DEFAULT);
    }
  };

  const changeModpack = (choice: ModpackChoice | null) => {
    setModpack(choice);
    if (choice === null) {
      setVersion("");
    } else if (choice.source === "modrinth" || choice.source === "curseforge-zip") {
      // The pack says which versions it has builds for (a zip: exactly one,
      // from its manifest); start on the newest.
      setVersion(choice.gameVersions[0] ?? "");
    } else if (modpack?.source !== "curseforge") {
      setVersion("");
    }
  };

  // Which Minecraft versions can be chosen, and whether "latest" is one.
  const packVersions =
    modpack?.source === "modrinth" || modpack?.source === "curseforge-zip"
      ? modpack.gameVersions
      : null;
  const versionIds = packVersions ?? versions.map((item) => item.id);
  const versionHint =
    kind === "type"
      ? "Mod loaders can trail the newest release — for a modded server, pick the version your mods are built for."
      : modpack === null
        ? "Choose the modpack first."
        : modpack.source === "modrinth"
          ? "The versions this pack has builds for. MineUI installs its newest release for the one you pick."
          : modpack.source === "curseforge-zip"
            ? "From the pack's manifest."
            : "The Minecraft version the pack is made for — it decides which Java the server gets, and a pack on the wrong Java does not start.";

  const loaderMeta = LOADERS.find((item) => item.id === loader);
  const workloadReady =
    kind === "type" || (modpack !== null && version !== "" && version !== LATEST);
  const canCreate =
    eulaAccepted &&
    containerName.trim() !== "" &&
    gamePort > 0 &&
    rconPort > 0 &&
    workloadReady &&
    !noRuntime &&
    !creating;

  const handleCreate = async () => {
    if (!canCreate) return;
    play("click_confirm");
    setCreating(true);
    try {
      await createContainer({
        loader,
        mcVersion: version,
        containerName: containerName.trim(),
        memoryMb,
        gamePort,
        rconPort,
        exposeToNetwork,
        acceptEula: true,
        modpack:
          kind === "modpack" && modpack
            ? { source: modpack.source, project: modpack.project }
            : null,
      });
      play("success");
      toast.success(`${containerName.trim()} created — the server is installing`);
      onCreated();
    } catch (error) {
      play("error");
      toast.danger(
        error instanceof IpcError ? error.message : "Failed to create the container.",
      );
      setCreating(false);
    }
  };

  return (
    <motion.section initial="hidden" animate="show" variants={fadeUp("base")}>
      <Card className="mx-auto max-w-2xl p-6">
        <Card.Header className="flex-col items-stretch gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-3 text-sm text-accent">
              <Container size={18} />
              <span className="font-display text-xs tracking-wide">
                Create this server
              </span>
            </div>
            {/* Added by mistake, or changed your mind: back out from here. */}
            <DiscardServerButton isDisabled={creating} />
          </div>
          <Card.Description>
            {serverName} is not set up yet. Pick what it should run and MineUI
            creates the server in a container (the widely used{" "}
            <code className="font-mono">itzg/minecraft-server</code> image) and
            connects to it. Only want plain Minecraft with nothing to install? Add
            a <em>Plain Minecraft server</em> in App Settings → Servers instead.
          </Card.Description>
        </Card.Header>

        {noRuntime && (
          <Card.Content className="mt-4">
            <RuntimeInstallHelp onRecheck={checkRuntime} checking={runtimeChecking} />
          </Card.Content>
        )}

        <Card.Content className="mt-4 grid gap-5 text-sm md:grid-cols-2">
          <div
            role="radiogroup"
            aria-label="What the server runs"
            className="grid gap-2 sm:grid-cols-2 md:col-span-2"
          >
            {KINDS.map((option) => {
              const selected = option.id === kind;
              const Icon = option.icon;
              return (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={creating}
                  onClick={() => changeKind(option.id)}
                  onMouseEnter={() => play("hover")}
                  className="flex items-start gap-3 rounded-lg border p-3 text-left focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-60"
                  style={{
                    borderColor: selected ? "var(--accent)" : "var(--border)",
                    background: selected
                      ? "color-mix(in oklab, var(--accent) 8%, transparent)"
                      : "var(--surface-secondary)",
                    outlineColor: "var(--focus)",
                    transition:
                      "border-color var(--motion-fast) var(--motion-ease), background var(--motion-fast) var(--motion-ease)",
                  }}
                >
                  <Icon size={16} className="mt-0.5 shrink-0 text-accent" />
                  <span className="flex-1">
                    <span className="block text-sm font-semibold">{option.title}</span>
                    <span className="mt-0.5 block text-xs text-muted">{option.description}</span>
                  </span>
                </button>
              );
            })}
          </div>

          {kind === "modpack" && (
            <div className="md:col-span-2">
              <ModpackPicker value={modpack} onChange={changeModpack} isDisabled={creating} />
            </div>
          )}

          {kind === "type" && (
          <div className="flex flex-col gap-2">
            <Label>Server type</Label>
            <Select
              className="w-full text-sm"
              value={loader}
              isDisabled={creating}
              onChange={(value) => {
                if (value === null) return;
                play("click_confirm");
                setLoader(value as ContainerLoader);
              }}
            >
              <Label className="sr-only">Server type</Label>
              <Select.Trigger onMouseEnter={() => play("hover")}>
                <Select.Value />
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover>
                <ListBox>
                  {LOADERS.map((item) => (
                    <ListBox.Item key={item.id} id={item.id} textValue={item.label}>
                      {item.label}
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  ))}
                </ListBox>
              </Select.Popover>
            </Select>
            <span className="text-xs text-muted">{loaderMeta?.hint}</span>
          </div>
          )}

          <div className={`flex flex-col gap-2 ${kind === "modpack" ? "md:col-span-2" : ""}`}>
            <Label>Minecraft version</Label>
            <Select
              className="w-full text-sm"
              placeholder={
                kind === "modpack" && modpack === null ? "Choose the modpack first" : "Pick the version"
              }
              value={version === "" ? null : version}
              isDisabled={creating || (kind === "modpack" && modpack === null)}
              onChange={(value) => {
                if (value === null) return;
                play("click_confirm");
                setVersion(String(value));
              }}
            >
              <Label className="sr-only">Minecraft version</Label>
              <Select.Trigger onMouseEnter={() => play("hover")}>
                <Select.Value />
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover>
                <ListBox className="max-h-72 overflow-auto">
                  {kind === "type" && (
                    <ListBox.Item id={LATEST} textValue="Latest release">
                      Latest release
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  )}
                  {versionIds.map((id) => (
                    <ListBox.Item key={id} id={id} textValue={id}>
                      {id}
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  ))}
                </ListBox>
              </Select.Popover>
            </Select>
            <span className="text-xs text-muted">{versionHint}</span>
          </div>

          <TextField
            className="flex flex-col gap-2"
            value={containerName}
            onChange={setContainerName}
            isDisabled={creating}
          >
            <Label>Container name</Label>
            <Input className="font-mono" />
          </TextField>

          <div className="grid grid-cols-2 gap-3">
            <TextField className="flex flex-col gap-2" isDisabled={creating}>
              <Label>Game port</Label>
              <Input
                type="number"
                min={1}
                max={65535}
                value={gamePort}
                onChange={(event) => setGamePort(numberFrom(event))}
              />
            </TextField>
            <TextField className="flex flex-col gap-2" isDisabled={creating}>
              <Label>RCON port</Label>
              <Input
                type="number"
                min={1}
                max={65535}
                value={rconPort}
                onChange={(event) => setRconPort(numberFrom(event))}
              />
            </TextField>
          </div>

          <div className="grid gap-2 md:col-span-2">
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
              onChange={(value) => {
                setMemoryTouched(true);
                setMemoryMb(value as number);
              }}
            >
              <Label className="sr-only">Server memory in megabytes</Label>
              <Slider.Output />
              <Slider.Track>
                <Slider.Fill />
                <Slider.Thumb />
              </Slider.Track>
            </Slider>
            <span className="text-xs text-muted">
              JVM heap. 2048 MB suits a small vanilla server; modded servers
              usually want 4096 MB or more, large modpacks 6144–8192 MB.
            </span>
          </div>

          <div className="grid gap-3 md:col-span-2">
            <Switch
              isSelected={exposeToNetwork}
              isDisabled={creating}
              onChange={(selected: boolean) => {
                play(selected ? "toggle_on" : "toggle_off");
                setExposeToNetwork(selected);
              }}
            >
              <Switch.Content>
                <Switch.Control>
                  <Switch.Thumb />
                </Switch.Control>
                <Label>Let other devices join</Label>
              </Switch.Content>
            </Switch>
            <span className="text-xs text-muted">
              {exposeToNetwork
                ? `The game port (${gamePort}) is opened on every network interface of this machine.`
                : "Only this computer can connect. Choose this for a test server."}{" "}
              RCON — the channel MineUI itself uses to send commands — always stays
              on this computer, with a password MineUI generates.
            </span>

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
                <OutLink href="https://aka.ms/MinecraftEULA" className="text-accent underline">
                  Minecraft End User License Agreement
                </OutLink>
                .{" "}
                <span className="text-muted">
                  Mojang&apos;s rules for running a server — every Minecraft server has to
                  agree to them.
                </span>
              </span>
            </label>
          </div>

          {creating && (
            <div className="grid gap-2 md:col-span-2">
              <span className="text-xs text-muted">
                Creating the container… The first time, the server image
                (about 1 GB) is downloaded, which can take a few minutes.
              </span>
              <ProgressBar
                className="progress-bar-steps"
                aria-label="Creating the container"
                isIndeterminate
              >
                <ProgressBar.Track>
                  <ProgressBar.Fill />
                </ProgressBar.Track>
              </ProgressBar>
            </div>
          )}
        </Card.Content>

        <Card.Footer className="mt-6 flex flex-wrap items-center justify-between gap-3">
          <Button
            variant="ghost"
            isDisabled={creating}
            onPress={() => {
              play("click_confirm");
              router.push("/settings");
            }}
            onMouseEnter={() => play("hover")}
          >
            Use a container I already run instead
          </Button>
          <div className="flex flex-wrap items-center gap-3">
            {!canCreate && !creating && (
              <span className="text-xs text-muted">
                {noRuntime
                  ? "Install Podman or Docker first (see above)."
                  : !workloadReady
                    ? kind === "modpack" && modpack === null
                      ? "Pick a modpack."
                      : "Pick the Minecraft version."
                    : containerName.trim() === ""
                      ? "Give the container a name."
                      : !eulaAccepted
                        ? "Accept the EULA to continue."
                        : "Check the ports."}
              </span>
            )}
          <Button
            onPress={handleCreate}
            isDisabled={!canCreate}
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
          </div>
        </Card.Footer>
      </Card>
    </motion.section>
  );
}
