"use client";

// On a create flow: back out of a server that was added but never created.
// Removing it only drops the profile (contract §3.12) - and at this point
// there is no container, instance or world behind it to worry about.
// The first ("default") server cannot be removed, so it gets no button.
import { useState } from "react";
import { Trash2 } from "lucide-react";
import { Button, toast } from "@heroui/react";
import ConfirmDialog from "@/app/components/ConfirmDialog";
import { useServers } from "@/app/components/ServerProvider";
import { useUISound } from "@/app/hooks/useUISound";
import { DEFAULT_SERVER_ID, IpcError } from "@/app/lib/ipc";

export default function DiscardServerButton({ isDisabled = false }: { isDisabled?: boolean }) {
  const { play } = useUISound();
  const { servers, active, activeId, remove } = useServers();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  if (activeId === DEFAULT_SERVER_ID) return null;

  const next = servers.find((server) => server.id === DEFAULT_SERVER_ID)?.name ?? "the first server";

  const discard = async () => {
    setBusy(true);
    try {
      // On success the provider leaves this server, which unmounts this page.
      await remove(activeId);
      play("success");
      toast.success(`${active.name} removed`);
    } catch (error) {
      play("error");
      toast.danger(error instanceof IpcError ? error.message : "Could not remove the server");
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        isDisabled={isDisabled || busy}
        onPress={() => {
          play("click_confirm");
          setConfirming(true);
        }}
        onMouseEnter={() => play("hover")}
      >
        <Trash2 size={14} />
        Remove this server
      </Button>
      <ConfirmDialog
        isOpen={confirming}
        title="Remove server"
        description={`Remove "${active.name}" from MineUI? Nothing is deleted from this computer: if it had server files or a container before, they stay where they are. You will be taken to ${next}.`}
        confirmLabel="Remove"
        variant="danger"
        isLoading={busy}
        onConfirm={discard}
        onCancel={() => setConfirming(false)}
      />
    </>
  );
}
