"use client";

// Settings → Servers: the list of server profiles (contract §2.5, §3.12) —
// open, rename, remove, add. State and IPC live in ServerProvider; this is
// presentation plus the add/rename/remove flows.
import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  Check,
  Container,
  Link2,
  Pencil,
  Plus,
  Server,
  Sparkles,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  Button,
  Card,
  Chip,
  Input,
  Label,
  Modal,
  TextField,
  toast,
} from "@heroui/react";
import ConfirmDialog from "@/app/components/ConfirmDialog";
import ContainerDeleteFields, {
  canDeleteContainer,
} from "@/app/components/ContainerDeleteFields";
import { useUISound } from "@/app/hooks/useUISound";
import {
  identityLine,
  overviewSummary,
  phaseDotClass,
  useServers,
} from "@/app/components/ServerProvider";
import {
  DEFAULT_SERVER_ID,
  deleteContainerFor,
  IpcError,
  MAX_SERVERS,
  MAX_SERVER_NAME_CHARS,
  type Mode,
  type ServerProfile,
} from "@/app/lib/ipc";

/** How a new server comes to be — and so where adding it lands you. */
type AddKind = "new-container" | "existing-container" | "managed";

const ADD_KINDS: {
  id: AddKind;
  title: string;
  description: string;
  icon: LucideIcon;
  mode: Mode;
  /** Where the next step happens once the server is open. */
  next: string;
}[] = [
  {
    id: "new-container",
    title: "New container",
    description:
      "MineUI creates an itzg/minecraft-server container for you — Vanilla, Paper, Fabric, Forge, NeoForge and more.",
    icon: Container,
    mode: "advanced",
    next: "/",
  },
  {
    id: "existing-container",
    title: "Existing container",
    description:
      "Attach to a Podman or Docker container you already run. You enter its name, ports and RCON password next.",
    icon: Link2,
    mode: "advanced",
    next: "/settings",
  },
  {
    id: "managed",
    title: "Managed vanilla",
    description:
      "No containers: MineUI downloads the official server and runs it as a process.",
    icon: Sparkles,
    mode: "simple",
    next: "/",
  },
];

const messageOf = (error: unknown, fallback: string) =>
  error instanceof IpcError ? error.message : fallback;

export default function ServersCard() {
  const router = useRouter();
  const { play } = useUISound();
  const { servers, activeId, overview, switching, switchTo, add, rename, remove } =
    useServers();
  const [busy, setBusy] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newKind, setNewKind] = useState<AddKind>("new-container");
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [removeTarget, setRemoveTarget] = useState<ServerProfile | null>(null);
  // Removing a server can take its container along (contract §3.13) — off
  // by default, and the world only goes with a second tick and its name typed.
  const [alsoContainer, setAlsoContainer] = useState(false);
  const [deleteData, setDeleteData] = useState(false);
  const [typedName, setTypedName] = useState("");

  const atLimit = servers.length >= MAX_SERVERS;

  // What removing costs depends on whether anything exists behind the profile.
  const removeDescription = (server: ServerProfile) => {
    const state = overview.find((entry) => entry.id === server.id);
    const consequence =
      state?.phase === "not-created"
        ? "Nothing has been created for it yet, so nothing is lost."
        : state?.containerName
          ? "Unless you tick the box below, the server itself is untouched: its container, world and backups stay where they are."
          : "The server itself is untouched: its world and backups stay where they are.";
    const leaving =
      server.id === activeId
        ? ` It is the server you have open; MineUI will move to ${
            servers.find((item) => item.id === DEFAULT_SERVER_ID)?.name ?? "the first server"
          }.`
        : "";
    return `MineUI will forget "${server.name}" and its settings. ${consequence}${leaving}`;
  };

  const openAdd = () => {
    play("click_confirm");
    setNewName("");
    setNewKind("new-container");
    setAddOpen(true);
  };

  const submitAdd = async () => {
    if (!newName.trim() || busy) return;
    setBusy(true);
    try {
      const kind = ADD_KINDS.find((item) => item.id === newKind) ?? ADD_KINDS[0];
      const created = await add(newName, kind.mode);
      play("success");
      toast.success(`${created.name} added`);
      setAddOpen(false);
      // The new server is open now; go where its next step is (the create
      // flows live on the dashboard, attaching happens in its settings).
      router.push(kind.next);
    } catch (error) {
      play("error");
      toast.danger(messageOf(error, "Could not add the server"));
    } finally {
      setBusy(false);
    }
  };

  const submitRename = async () => {
    if (!editing || busy) return;
    const current = servers.find((server) => server.id === editing.id);
    if (!editing.name.trim() || editing.name.trim() === current?.name) {
      setEditing(null);
      return;
    }
    setBusy(true);
    try {
      await rename(editing.id, editing.name);
      play("success");
      setEditing(null);
    } catch (error) {
      play("error");
      toast.danger(messageOf(error, "Rename failed"));
    } finally {
      setBusy(false);
    }
  };

  const closeRemove = () => {
    setRemoveTarget(null);
    setAlsoContainer(false);
    setDeleteData(false);
    setTypedName("");
  };

  // The container behind the server being removed, when there is one.
  const removeState = removeTarget
    ? overview.find((entry) => entry.id === removeTarget.id)
    : undefined;
  const removeContainer =
    removeState?.containerName &&
    removeState.phase !== null &&
    removeState.phase !== "not-created"
      ? removeState.containerName
      : null;

  const confirmRemove = async () => {
    if (!removeTarget) return;
    setBusy(true);
    try {
      let outcome = `${removeTarget.name} removed from MineUI`;
      if (alsoContainer && removeContainer) {
        // First the container: if that fails, the server stays listed so it
        // can be tried again.
        const done = await deleteContainerFor(removeTarget.id, deleteData);
        if (done.dataKept) {
          toast.warning(`${done.containerName} deleted. The data stayed: ${done.dataKept}`);
        }
        outcome += done.deletedVolume
          ? `; its container and world data were deleted`
          : `; its container was deleted, the world is kept`;
      }
      await remove(removeTarget.id);
      play("success");
      toast.success(outcome);
    } catch (error) {
      play("error");
      toast.danger(messageOf(error, "Remove failed"));
    } finally {
      setBusy(false);
      closeRemove();
    }
  };

  return (
    <Card className="scroll-mt-24 p-6" id="servers">
      <Card.Header className="flex-col items-start gap-1">
        <div className="flex items-center gap-2">
          <Server size={16} className="text-accent" />
          <Card.Title>Servers</Card.Title>
        </div>
        <Card.Description>
          MineUI manages every server listed here at the same time — scheduled
          tasks and backups keep running for all of them. Per-server settings
          live on each server&apos;s Settings page.
        </Card.Description>
      </Card.Header>

      <Card.Content className="mt-4 grid gap-2">
        {servers.map((server) => {
          const state = overview.find((entry) => entry.id === server.id);
          const isOpen = server.id === activeId;
          const isEditing = editing?.id === server.id;
          // The open server can be removed too: MineUI then moves to the
          // first server. Only that first server is permanent.
          const removeBlocked = server.id === DEFAULT_SERVER_ID;
          return (
            <div
              key={server.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3"
              style={{ background: "var(--surface-secondary)" }}
            >
              <div className="flex min-w-0 flex-1 items-center gap-3">
                <span
                  aria-hidden
                  className={`size-2 shrink-0 rounded-full ${phaseDotClass(state?.phase)}`}
                />
                {isEditing ? (
                  <TextField
                    className="min-w-0 flex-1"
                    aria-label={`New name for ${server.name}`}
                    value={editing.name}
                    onChange={(name: string) => setEditing({ id: server.id, name })}
                  >
                    <Input
                      autoFocus
                      maxLength={MAX_SERVER_NAME_CHARS}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") submitRename();
                        if (event.key === "Escape") setEditing(null);
                      }}
                    />
                  </TextField>
                ) : (
                  <div className="flex min-w-0 flex-col">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{server.name}</span>
                      {isOpen && (
                        <Chip size="sm" variant="soft" color="accent">
                          Open
                        </Chip>
                      )}
                    </span>
                    <span className="truncate text-xs text-muted">
                      {state?.error ?? overviewSummary(state)}
                    </span>
                    {state && (
                      <span className="truncate font-mono text-xs text-muted">
                        {identityLine(state)}
                      </span>
                    )}
                  </div>
                )}
              </div>

              <div className="flex items-center gap-1">
                {isEditing ? (
                  <>
                    <Button
                      size="sm"
                      variant="ghost"
                      isIconOnly
                      aria-label="Save name"
                      isDisabled={busy}
                      onPress={submitRename}
                    >
                      <Check size={14} />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      isIconOnly
                      aria-label="Cancel rename"
                      onPress={() => setEditing(null)}
                    >
                      <X size={14} />
                    </Button>
                  </>
                ) : (
                  <>
                    {!isOpen && (
                      <Button
                        size="sm"
                        variant="secondary"
                        isDisabled={switching || busy}
                        onPress={() => {
                          play("click_confirm");
                          switchTo(server.id);
                        }}
                        onMouseEnter={() => play("hover")}
                      >
                        Open
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      isIconOnly
                      aria-label={`Rename ${server.name}`}
                      isDisabled={busy}
                      onPress={() => setEditing({ id: server.id, name: server.name })}
                      onMouseEnter={() => play("hover")}
                    >
                      <Pencil size={14} />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      isIconOnly
                      aria-label={
                        server.id === DEFAULT_SERVER_ID
                          ? "The first server cannot be removed"
                          : `Remove ${server.name}`
                      }
                      isDisabled={removeBlocked || busy}
                      onPress={() => {
                        play("click_confirm");
                        setRemoveTarget(server);
                      }}
                      onMouseEnter={() => play("hover")}
                    >
                      <Trash2 size={14} />
                    </Button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </Card.Content>

      <Card.Footer className="mt-4 items-center justify-between gap-3">
        <span className="text-xs text-muted">
          <span className="font-pixel-num">
            {servers.length}/{MAX_SERVERS}
          </span>{" "}
          servers
        </span>
        <Button
          variant="secondary"
          onPress={openAdd}
          isDisabled={atLimit || switching}
          onMouseEnter={() => play("hover")}
        >
          <Plus size={16} />
          Add server
        </Button>
      </Card.Footer>

      {/* Controlled: Backdrop without the <Modal> root, whose DialogTrigger
          expects a pressable child and warns when there is none. */}
      <Modal.Backdrop
        isOpen={addOpen}
        onOpenChange={(open) => {
          if (!busy) setAddOpen(open);
        }}
        variant="blur"
      >
        <Modal.Container>
          <Modal.Dialog className="sm:max-w-[440px]">
            <Modal.CloseTrigger />
            <Modal.Header>
              <Modal.Heading className="font-pixel text-sm uppercase tracking-[0.2em]">
                Add server
              </Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              <form
                className="flex flex-col gap-4 p-1"
                onSubmit={(event) => {
                  event.preventDefault();
                  submitAdd();
                }}
              >
                <TextField
                  className="flex flex-col gap-2"
                  value={newName}
                  onChange={setNewName}
                  isRequired
                >
                  <Label>Name</Label>
                  <Input
                    autoFocus
                    placeholder="Fabric survival"
                    maxLength={MAX_SERVER_NAME_CHARS}
                  />
                </TextField>

                <div
                  role="radiogroup"
                  aria-label="How this server is set up"
                  className="flex flex-col gap-2"
                >
                  {ADD_KINDS.map((kind) => {
                    const selected = kind.id === newKind;
                    const Icon = kind.icon;
                    return (
                      <button
                        key={kind.id}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        onClick={() => {
                          play("toggle_on");
                          setNewKind(kind.id);
                        }}
                        onMouseEnter={() => play("hover")}
                        className="flex items-start gap-3 rounded-lg border p-3 text-left focus-visible:outline-2 focus-visible:outline-offset-2"
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
                          <span className="block text-sm font-semibold">{kind.title}</span>
                          <span className="mt-0.5 block text-xs text-muted">
                            {kind.description}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </form>
            </Modal.Body>
            <Modal.Footer>
              <Button variant="tertiary" isDisabled={busy} onPress={() => setAddOpen(false)}>
                Cancel
              </Button>
              <Button
                isDisabled={!newName.trim() || busy}
                isPending={busy}
                onPress={submitAdd}
              >
                Add and open
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>

      <ConfirmDialog
        isOpen={removeTarget !== null}
        title="Remove server"
        description={removeTarget ? removeDescription(removeTarget) : undefined}
        confirmLabel={
          alsoContainer && removeContainer
            ? deleteData
              ? "Remove and delete everything"
              : "Remove and delete container"
            : "Remove"
        }
        variant="danger"
        isLoading={busy}
        isConfirmDisabled={
          alsoContainer &&
          removeContainer !== null &&
          !canDeleteContainer(deleteData, typedName, removeContainer)
        }
        onConfirm={confirmRemove}
        onCancel={closeRemove}
        footer={
          removeContainer ? (
            <div className="flex flex-col gap-3">
              <label className="flex items-start gap-3 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={alsoContainer}
                  disabled={busy}
                  onChange={(event) => {
                    setAlsoContainer(event.target.checked);
                    if (!event.target.checked) {
                      setDeleteData(false);
                      setTypedName("");
                    }
                  }}
                />
                <span>
                  Also delete its container{" "}
                  <span className="font-mono">{removeContainer}</span>
                  <span className="mt-0.5 block text-xs text-muted">
                    Left unticked, the container keeps running and can be
                    attached again later.
                  </span>
                </span>
              </label>
              {alsoContainer && (
                <div className="pl-7">
                  <ContainerDeleteFields
                    containerName={removeContainer}
                    deleteData={deleteData}
                    onDeleteDataChange={(value) => {
                      setDeleteData(value);
                      setTypedName("");
                    }}
                    typed={typedName}
                    onTypedChange={setTypedName}
                    isDisabled={busy}
                  />
                </div>
              )}
            </div>
          ) : undefined
        }
      />
    </Card>
  );
}
