"use client";

// Dashboard onboarding for an advanced-mode server that has no container
// yet: create one from the itzg/minecraft-server image (contract §3.13) —
// pick a loader and version, MineUI does the `run` and wires the server up.
// The simple-mode counterpart is CreateServerFlow.
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { motion } from "motion/react";
import { Container, HardDrive, Loader2, Rocket } from "lucide-react";
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
import { useUISound } from "@/app/hooks/useUISound";
import { fadeUp } from "@/app/lib/motion";
import {
  createContainer,
  listMcVersions,
  IpcError,
  type ContainerLoader,
  type McVersion,
  type Settings,
} from "@/app/lib/ipc";

const LATEST = "LATEST";
const DEFAULT_CONTAINER_NAME = "minecraft-server";
const MEMORY_MIN = 1024;
const MEMORY_MAX = 16384;
const MEMORY_STEP = 512;

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
  const [loader, setLoader] = useState<ContainerLoader>("vanilla");
  const [versions, setVersions] = useState<McVersion[]>([]);
  const [version, setVersion] = useState(LATEST);
  const [containerName, setContainerName] = useState(
    settings.advanced.containerName !== DEFAULT_CONTAINER_NAME
      ? settings.advanced.containerName
      : containerNameFor(serverName),
  );
  const [memoryMb, setMemoryMb] = useState(4096);
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

  const loaderMeta = LOADERS.find((item) => item.id === loader);
  const canCreate =
    eulaAccepted && containerName.trim() !== "" && gamePort > 0 && rconPort > 0 && !creating;

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
        <Card.Header className="flex-col items-start gap-2">
          <div className="flex items-center gap-3 text-sm text-accent">
            <Container size={18} />
            <span className="font-display text-xs tracking-wide">
              Create this server
            </span>
          </div>
          <Card.Description>
            {serverName} has no container yet. MineUI can create one from the{" "}
            <code className="font-mono">itzg/minecraft-server</code> image and
            connect to it — pick what it should run.
          </Card.Description>
        </Card.Header>

        <Card.Content className="mt-4 grid gap-5 text-sm md:grid-cols-2">
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

          <div className="flex flex-col gap-2">
            <Label>Minecraft version</Label>
            <Select
              className="w-full text-sm"
              value={version}
              isDisabled={creating}
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
                  <ListBox.Item id={LATEST} textValue="Latest release">
                    Latest release
                    <ListBox.ItemIndicator />
                  </ListBox.Item>
                  {versions.map((item) => (
                    <ListBox.Item key={item.id} id={item.id} textValue={item.id}>
                      {item.id}
                      <ListBox.ItemIndicator />
                    </ListBox.Item>
                  ))}
                </ListBox>
              </Select.Popover>
            </Select>
            <span className="text-xs text-muted">
              Mod loaders can trail the newest release — for a modded server,
              pick the version your mods are built for.
            </span>
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
              JVM heap. 2048 MB suits a small vanilla server; modded servers
              usually want 4096 MB or more.
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
              RCON always stays local, with a password MineUI generates.
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
                <a
                  href="https://aka.ms/MinecraftEULA"
                  target="_blank"
                  rel="noreferrer"
                  className="text-accent underline"
                >
                  Minecraft End User License Agreement
                </a>
                .
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
            Attach an existing container instead
          </Button>
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
        </Card.Footer>
      </Card>
    </motion.section>
  );
}
