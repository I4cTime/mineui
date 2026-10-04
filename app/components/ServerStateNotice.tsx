"use client";

// "This page needs the server running / stopped - and here is the button."
// Pages that only work in one state used to show raw backend errors or an
// empty list instead (UX review 2026-10, findings on Players, RCON, Backups).
// The phase comes from ServerProvider's live overview, the same source the
// page header's status dot uses, so the two never disagree.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Play, Square } from "lucide-react";
import { Alert, Button, toast } from "@heroui/react";
import ConfirmDialog from "@/app/components/ConfirmDialog";
import { useServers } from "@/app/components/ServerProvider";
import { useUISound } from "@/app/hooks/useUISound";
import { IpcError, startServer, stopServer } from "@/app/lib/ipc";

interface ServerStateNoticeProps {
  /** What the page needs the server to be. */
  need: "running" | "stopped";
  /** Why, as the end of a sentence: "to read the player list". */
  what: string;
}

export default function ServerStateNotice({ need, what }: ServerStateNoticeProps) {
  const { active, activeId, overview, refreshOverview } = useServers();
  const { play } = useUISound();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const entry = overview.find((item) => item.id === activeId);
  // Unknown until the first overview poll lands: say nothing rather than guess.
  if (!entry) return null;
  const phase = entry.phase;
  const satisfied =
    need === "running" ? phase === "running" : phase === "stopped" || phase === "crashed";
  if (satisfied) return null;

  const run = async (action: () => Promise<void>, failure: string) => {
    setBusy(true);
    try {
      await action();
      play("success");
      await refreshOverview();
    } catch (error) {
      play("error");
      toast.danger(error instanceof IpcError ? error.message : failure);
    } finally {
      setBusy(false);
    }
  };

  let message: string;
  let action: React.ReactNode = null;
  if (phase === null) {
    message = `MineUI can't reach ${active.name} right now - ${entry.error ?? "its state is unknown"}.`;
    action = (
      <Button size="sm" variant="secondary" onPress={() => router.push("/")}>
        Open the dashboard
      </Button>
    );
  } else if (phase === "not-created") {
    message = `${active.name} has not been set up yet.`;
    action = (
      <Button size="sm" variant="secondary" onPress={() => router.push("/")}>
        Set it up
      </Button>
    );
  } else if (phase === "starting" || phase === "stopping") {
    message =
      phase === "starting"
        ? `${active.name} is starting - it has to be ${need} ${what}. This updates by itself.`
        : `${active.name} is stopping - it has to be ${need} ${what}. This updates by itself.`;
  } else if (need === "running") {
    message = `${active.name} is ${phase === "crashed" ? "not running (it crashed)" : "stopped"}. It has to be running ${what}.`;
    action = (
      <Button
        size="sm"
        isDisabled={busy}
        onPress={() => {
          play("click_confirm");
          void run(startServer, "Could not start the server.");
        }}
        onMouseEnter={() => play("hover")}
      >
        {busy ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
        Start server
      </Button>
    );
  } else {
    message = `${active.name} is running. It has to be stopped ${what}.`;
    action = (
      <Button
        size="sm"
        variant="danger"
        isDisabled={busy}
        onPress={() => {
          play("click_confirm");
          setConfirmStop(true);
        }}
        onMouseEnter={() => play("hover")}
      >
        {busy ? <Loader2 size={14} className="animate-spin" /> : <Square size={14} />}
        Stop server
      </Button>
    );
  }

  return (
    <Alert
      status="warning"
      role="status"
      className="flex-wrap items-center justify-between gap-3 rounded-lg border border-warning bg-transparent p-3 shadow-none"
    >
      <Alert.Indicator className="p-0 text-warning" />
      <Alert.Content className="min-w-0 flex-1">
        <Alert.Description className="text-sm text-foreground">{message}</Alert.Description>
      </Alert.Content>
      {action}
      <ConfirmDialog
        isOpen={confirmStop}
        title={`Stop ${active.name}`}
        description="Everyone playing is disconnected. The world is saved first."
        confirmLabel="Stop server"
        cancelLabel="Cancel"
        variant="danger"
        onCancel={() => setConfirmStop(false)}
        onConfirm={() => {
          setConfirmStop(false);
          void run(stopServer, "Could not stop the server.");
        }}
      />
    </Alert>
  );
}
