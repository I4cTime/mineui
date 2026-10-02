"use client";

// Mods → "Add mod or plugin". One flow, top to bottom:
//   1. what it is (mod or plugin — decides the folder),
//   2. where it comes from (a link, or a file on this computer),
//   3. what happened (progress, errors in place, what was added so far).
// The dialog stays open after a success so several files can be added in a
// row. IPC: upload_mod / download_mod (contract §3.5).
import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Blocks,
  CheckCircle2,
  Download,
  FolderOpen,
  Link2,
  Plug,
  type LucideIcon,
} from "lucide-react";
import {
  Button,
  Description,
  FieldError,
  Input,
  Label,
  Modal,
  ProgressBar,
  Tabs,
  TextField,
} from "@heroui/react";
import { useUISound } from "@/app/hooks/useUISound";
import { identityLine, useServers } from "@/app/components/ServerProvider";
import { pickModFile } from "@/app/lib/dialog";
import { formatBytes } from "@/app/lib/format";
import {
  downloadMod,
  onDownloadProgress,
  uploadMod,
  IpcError,
  type DownloadProgressEvent,
  type ModTarget,
} from "@/app/lib/ipc";

type Source = "link" | "file";

const TARGETS: {
  id: ModTarget;
  title: string;
  description: string;
  icon: LucideIcon;
}[] = [
  {
    id: "mods",
    title: "Mod",
    description: "For Forge, NeoForge, Fabric and Quilt. Goes in the mods folder.",
    icon: Blocks,
  },
  {
    id: "plugins",
    title: "Plugin",
    description: "For Paper, Purpur and Spigot. Goes in the plugins folder.",
    icon: Plug,
  },
];

/** Which folder each known server type actually loads from. */
const LOADS: Record<string, ModTarget | null> = {
  forge: "mods",
  neoforge: "mods",
  fabric: "mods",
  quilt: "mods",
  paper: "plugins",
  purpur: "plugins",
  spigot: "plugins",
  bukkit: "plugins",
  folia: "plugins",
  vanilla: null,
};

const LOADER_NAMES: Record<string, string> = {
  forge: "Forge",
  neoforge: "NeoForge",
  fabric: "Fabric",
  quilt: "Quilt",
  paper: "Paper",
  purpur: "Purpur",
  spigot: "Spigot",
  bukkit: "Bukkit",
  folia: "Folia",
  vanilla: "vanilla",
};

const hasModExtension = (name: string) => /\.(jar|zip)$/i.test(name);

/** The link, if it is one MineUI can download from. */
const parseLink = (value: string): URL | null => {
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
};

/** The file name the link itself carries, when it is a usable one. */
const nameFromLink = (url: URL | null): string | null => {
  if (!url) return null;
  let base = url.pathname.split("/").pop() ?? "";
  try {
    base = decodeURIComponent(base);
  } catch {
    // keep the raw segment
  }
  return hasModExtension(base) ? base : null;
};

interface AddModDialogProps {
  isOpen: boolean;
  onClose: () => void;
  /** A file landed on the server — refresh the list behind the dialog. */
  onInstalled: () => void;
}

export default function AddModDialog({ isOpen, onClose, onInstalled }: AddModDialogProps) {
  // Owned here so the backdrop can refuse to close mid-transfer; everything
  // else lives in the form, which remounts (and so resets) on every open.
  const [busy, setBusy] = useState(false);
  return (
    <Modal.Backdrop
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      variant="blur"
    >
      <Modal.Container>
        <Modal.Dialog className="sm:max-w-[540px]">
          <AddModForm busy={busy} setBusy={setBusy} onClose={onClose} onInstalled={onInstalled} />
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

function AddModForm({
  busy,
  setBusy,
  onClose,
  onInstalled,
}: {
  busy: boolean;
  setBusy: (busy: boolean) => void;
  onClose: () => void;
  onInstalled: () => void;
}) {
  const { play } = useUISound();
  const { active, activeId, overview } = useServers();
  const server = overview.find((entry) => entry.id === activeId);
  const loader = server?.loader ?? null;
  const loads = loader !== null && loader in LOADS ? LOADS[loader] : undefined;

  const [target, setTarget] = useState<ModTarget>(loads ?? "mods");
  const [source, setSource] = useState<Source>("link");
  const [link, setLink] = useState("");
  const [saveAs, setSaveAs] = useState("");
  const [progress, setProgress] = useState<DownloadProgressEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<{ filename: string; target: ModTarget }[]>([]);

  // A transfer cut short by unmount must not leave the backdrop locked.
  useEffect(() => () => setBusy(false), [setBusy]);

  const url = parseLink(link);
  const linkName = nameFromLink(url);
  const typedName = saveAs.trim();
  const linkInvalid = link.trim() !== "" && url === null;
  const nameInvalid = typedName !== "" && !hasModExtension(typedName);
  const nameRequired = url !== null && linkName === null;
  const canDownload =
    !busy && url !== null && !nameInvalid && (linkName !== null || typedName !== "");

  // Says so when the choice above cannot work on this server.
  const loaderName = loader ? (LOADER_NAMES[loader] ?? loader) : null;
  const mismatch =
    loads === null
      ? `${active.name} is a vanilla server, which loads neither mods nor plugins. The file is kept for when it runs a modded server.`
      : loads !== undefined && loads !== target
        ? `${active.name} runs ${loaderName}, which loads ${loads}, not ${target}.`
        : null;

  const finish = (filename: string) => {
    play("success");
    setAdded((list) => [{ filename, target }, ...list]);
    onInstalled();
  };

  const fail = (err: unknown, fallback: string) => {
    play("error");
    setError(err instanceof IpcError ? err.message : fallback);
  };

  const handleDownload = async () => {
    if (!canDownload || url === null) return;
    play("click_confirm");
    setBusy(true);
    setError(null);
    setProgress(null);
    const unlisten = await onDownloadProgress((event) => {
      if (event.kind === "mod") setProgress(event);
    });
    try {
      const { filename } = await downloadMod(url.toString(), target, typedName || undefined);
      finish(filename);
      setLink("");
      setSaveAs("");
    } catch (err) {
      fail(err, "The download failed.");
    } finally {
      unlisten();
      setProgress(null);
      setBusy(false);
    }
  };

  // No multipart upload in v2: the Tauri dialog yields a host path, the
  // backend copies it into the server (upload_mod).
  const handleChooseFile = async () => {
    if (busy) return;
    play("click_confirm");
    setBusy(true);
    setError(null);
    try {
      const sourcePath = await pickModFile();
      if (sourcePath === null) return; // cancelled
      const { filename } = await uploadMod(sourcePath, target);
      finish(filename);
    } catch (err) {
      fail(err, "The file could not be added.");
    } finally {
      setBusy(false);
    }
  };

  const percent =
    progress && progress.totalBytes
      ? Math.min(100, (progress.receivedBytes / progress.totalBytes) * 100)
      : null;
  const downloading = busy && source === "link";

  return (
    <>
      <Modal.CloseTrigger />
      <Modal.Header>
        <Modal.Heading className="font-pixel text-sm uppercase tracking-[0.2em]">
          Add a mod or plugin
        </Modal.Heading>
        <p className="mt-1.5 truncate text-xs text-muted">
          To <span className="font-semibold text-foreground">{active.name}</span>
          {server && <span className="font-mono"> · {identityLine(server)}</span>}
        </p>
      </Modal.Header>

      <Modal.Body className="flex flex-col gap-5 px-1 pt-3 pb-1 text-sm">
        {/* 1 — what it is */}
        <section className="flex flex-col gap-2">
          <span id="add-mod-kind" className="text-xs uppercase tracking-[0.2em] text-muted">
            1 · What are you adding?
          </span>
          <div
            role="radiogroup"
            aria-labelledby="add-mod-kind"
            className="grid gap-2 sm:grid-cols-2"
          >
            {TARGETS.map((option) => {
              const selected = option.id === target;
              const Icon = option.icon;
              return (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={busy}
                  onClick={() => {
                    play("toggle_on");
                    setTarget(option.id);
                  }}
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
          {mismatch && (
            <p className="flex items-start gap-2 text-xs text-warning">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>{mismatch}</span>
            </p>
          )}
        </section>

        {/* 2 — where it comes from */}
        <section className="flex flex-col gap-2">
          <span className="text-xs uppercase tracking-[0.2em] text-muted">
            2 · Where is the file?
          </span>
          <Tabs
            selectedKey={source}
            onSelectionChange={(key) => {
              if (busy) return;
              setSource(key as Source);
              setError(null);
            }}
          >
            <Tabs.ListContainer>
              <Tabs.List aria-label="Where the file comes from">
                <Tabs.Tab id="link" isDisabled={busy}>
                  <span className="flex items-center gap-1.5">
                    <Link2 size={14} />A link
                  </span>
                  <Tabs.Indicator />
                </Tabs.Tab>
                <Tabs.Tab id="file" isDisabled={busy}>
                  <span className="flex items-center gap-1.5">
                    <FolderOpen size={14} />
                    This computer
                  </span>
                  <Tabs.Indicator />
                </Tabs.Tab>
              </Tabs.List>
            </Tabs.ListContainer>

            <Tabs.Panel id="link" className="flex flex-col gap-4 pt-4">
              <TextField
                className="flex flex-col gap-2"
                value={link}
                onChange={(value: string) => {
                  setLink(value);
                  setError(null);
                }}
                isDisabled={busy}
                isInvalid={linkInvalid}
              >
                <Label>Download link</Label>
                <Input
                  autoFocus
                  type="url"
                  placeholder="https://cdn.modrinth.com/data/…/sodium.jar"
                  onKeyDown={(event) => {
                    if (event.key === "Enter") handleDownload();
                  }}
                />
                <Description>
                  The direct link to a .jar or .zip — on Modrinth or CurseForge,
                  copy the address of the file&apos;s Download button.
                </Description>
                <FieldError>
                  That is not a link MineUI can download — it must start with
                  http:// or https://.
                </FieldError>
              </TextField>

              <TextField
                className="flex flex-col gap-2"
                value={saveAs}
                onChange={setSaveAs}
                isDisabled={busy}
                isInvalid={nameInvalid}
                isRequired={nameRequired}
              >
                <Label>{nameRequired ? "File name" : "File name (optional)"}</Label>
                <Input
                  className="font-mono"
                  placeholder={linkName ?? "my-mod-1.0.jar"}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") handleDownload();
                  }}
                />
                <Description>
                  {nameRequired
                    ? "This link does not end in a file name, so give the file one ending in .jar or .zip."
                    : linkName
                      ? `Leave empty to keep "${linkName}".`
                      : "Leave empty to keep the name from the link."}
                </Description>
                <FieldError>The file name must end in .jar or .zip.</FieldError>
              </TextField>
            </Tabs.Panel>

            <Tabs.Panel id="file" className="pt-4">
              <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border p-6 text-center">
                <FolderOpen size={22} className="text-accent" />
                <p className="text-sm">Pick a .jar or .zip from this computer.</p>
                <p className="text-xs text-muted">
                  MineUI copies it into the server&apos;s {target} folder. Your
                  original file stays where it is.
                </p>
              </div>
            </Tabs.Panel>
          </Tabs>
        </section>

        {/* 3 — what happened */}
        {downloading && (
          <div className="grid gap-1.5" role="status">
            <div className="flex items-center justify-between gap-3 text-xs text-muted">
              <span className="truncate">
                Downloading {progress?.filename ?? (typedName || linkName || "…")}
              </span>
              <span className="shrink-0 font-pixel-num">
                {progress
                  ? progress.totalBytes
                    ? `${formatBytes(progress.receivedBytes)} / ${formatBytes(progress.totalBytes)}`
                    : formatBytes(progress.receivedBytes)
                  : ""}
              </span>
            </div>
            <ProgressBar
              className="progress-bar-steps"
              aria-label="Download progress"
              size="sm"
              value={percent ?? 0}
              isIndeterminate={percent === null}
            >
              <ProgressBar.Track>
                <ProgressBar.Fill />
              </ProgressBar.Track>
            </ProgressBar>
          </div>
        )}

        {error && (
          <p role="alert" className="flex items-start gap-2 rounded-lg border border-danger p-3 text-xs text-danger">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>{error}</span>
          </p>
        )}

        {added.length > 0 && (
          <div
            className="flex flex-col gap-2 rounded-lg border border-border p-3"
            style={{ background: "var(--surface-secondary)" }}
            role="status"
          >
            <ul className="flex flex-col gap-1.5">
              {added.map((item) => (
                <li key={`${item.target}/${item.filename}`} className="flex items-center gap-2 text-xs">
                  <CheckCircle2 size={14} className="shrink-0 text-success" />
                  <span className="truncate font-mono">{item.filename}</span>
                  <span className="shrink-0 text-muted">added to {item.target}</span>
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted">
              Restart the server for it to load new files. You can add another, or close this.
            </p>
          </div>
        )}
      </Modal.Body>

      <Modal.Footer>
        <Button
          variant="tertiary"
          isDisabled={busy}
          onPress={() => {
            play("click_back");
            onClose();
          }}
          onMouseEnter={() => play("hover")}
        >
          {added.length > 0 ? "Done" : "Cancel"}
        </Button>
        {source === "link" ? (
          <Button
            isDisabled={!canDownload}
            isPending={busy}
            onPress={handleDownload}
            onMouseEnter={() => play("hover")}
          >
            <Download size={16} />
            {busy ? "Downloading…" : `Download ${target === "mods" ? "mod" : "plugin"}`}
          </Button>
        ) : (
          <Button
            isDisabled={busy}
            isPending={busy}
            onPress={handleChooseFile}
            onMouseEnter={() => play("hover")}
          >
            <FolderOpen size={16} />
            {busy ? "Adding…" : "Choose file…"}
          </Button>
        )}
      </Modal.Footer>
    </>
  );
}
