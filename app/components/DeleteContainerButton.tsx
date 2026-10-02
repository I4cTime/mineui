"use client";

// Server Settings → Advanced mode card footer: delete this server's container (contract
// §3.13 delete_container) — to clean up a failed server, or to create it
// again with a different loader or modpack. The server stays in MineUI and
// its dashboard goes back to the create form.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { Button, Card, toast } from "@heroui/react";
import ConfirmDialog from "@/app/components/ConfirmDialog";
import ContainerDeleteFields, {
  canDeleteContainer,
} from "@/app/components/ContainerDeleteFields";
import { useServers } from "@/app/components/ServerProvider";
import { useUISound } from "@/app/hooks/useUISound";
import { deleteContainerFor, IpcError } from "@/app/lib/ipc";

export default function DeleteContainerButton() {
  const router = useRouter();
  const { play } = useUISound();
  const { activeId, overview, refreshOverview } = useServers();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deleteData, setDeleteData] = useState(false);
  const [typed, setTyped] = useState("");

  const entry = overview.find((item) => item.id === activeId);
  const containerName = entry?.containerName ?? null;
  // Only when there is a container to delete.
  const exists =
    containerName !== null && entry?.phase !== null && entry?.phase !== "not-created";
  if (!exists || containerName === null) return null;

  const close = () => {
    setOpen(false);
    setDeleteData(false);
    setTyped("");
  };

  const confirm = async () => {
    setBusy(true);
    try {
      const done = await deleteContainerFor(activeId, deleteData);
      play("success");
      if (done.dataKept) {
        toast.warning(`${done.containerName} deleted. The data stayed: ${done.dataKept}`);
      } else if (done.deletedVolume) {
        toast.success(`${done.containerName} and its world data deleted`);
      } else {
        toast.success(`${done.containerName} deleted — the world is kept`);
      }
      close();
      await refreshOverview();
      router.push("/");
    } catch (error) {
      play("error");
      toast.danger(error instanceof IpcError ? error.message : "Could not delete the container");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card.Footer className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
      <span className="max-w-md text-xs text-muted">
        Deleting the container keeps the world unless you tick otherwise. Use
        it to start over with another loader or modpack.
      </span>
      <Button
        variant="danger"
        onPress={() => {
          play("click_confirm");
          setOpen(true);
        }}
        onMouseEnter={() => play("hover")}
      >
        <Trash2 size={16} />
        Delete container
      </Button>
      <ConfirmDialog
        isOpen={open}
        title="Delete container"
        description={`This stops and deletes the container "${containerName}". The server stays in MineUI, and you can create its container again — with another loader or modpack if you like.`}
        confirmLabel={deleteData ? "Delete container and world" : "Delete container"}
        variant="danger"
        isLoading={busy}
        isConfirmDisabled={!canDeleteContainer(deleteData, typed, containerName)}
        onConfirm={confirm}
        onCancel={close}
        footer={
          <ContainerDeleteFields
            containerName={containerName}
            deleteData={deleteData}
            onDeleteDataChange={setDeleteData}
            typed={typed}
            onTypedChange={setTyped}
            isDisabled={busy}
          />
        }
      />
    </Card.Footer>
  );
}
