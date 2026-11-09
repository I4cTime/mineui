"use client";

// Getting started: five steps with live ticks, per server. Everything comes
// from calls that already exist (server state, audit log, player history,
// backups list, instance status). Each open step has a Show me that scrolls
// to the right control. Dismissible per server; gone once all five are done.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Circle, X } from "lucide-react";
import { Button, Card } from "@heroui/react";
import { useServers } from "@/app/components/ServerProvider";
import { useUISound } from "@/app/hooks/useUISound";
import {
  getAuditLog,
  getPlayerHistory,
  getServerState,
  instanceStatus,
  listBackups,
  type Mode,
  type ServerPhase,
} from "@/app/lib/ipc";

export const GETTING_STARTED_KEY = "mineui-getting-started-dismissed";
const POLL_MS = 10000;

/** Page element ids the Show me buttons point at. */
export const TARGET_START = "start-server-button";
export const TARGET_JOIN = "join-info";
export const TARGET_BACKUP = "backup-button";

type Facts = {
  started: boolean;
  players: number;
  backups: number;
};

const dismissedKey = (serverId: string) => `${GETTING_STARTED_KEY}:${serverId}`;

function readDismissed(serverId: string): boolean {
  try {
    return window.localStorage.getItem(dismissedKey(serverId)) === "1";
  } catch {
    return false;
  }
}

/** Scroll to an element on the Dashboard and give it the keyboard focus. */
function showMe(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  const focusable = el.matches("button, a, input, [tabindex]")
    ? el
    : el.querySelector<HTMLElement>("button, a, input, [tabindex]");
  (focusable ?? el).focus({ preventScroll: true });
}

interface GettingStartedCardProps {
  mode: Mode;
  /** The open server's phase; a change re-reads the facts. */
  phase: ServerPhase | undefined;
}

export default function GettingStartedCard({ mode, phase }: GettingStartedCardProps) {
  const { play } = useUISound();
  const { activeId } = useServers();
  const [dismissed, setDismissed] = useState<boolean | null>(null);
  const [facts, setFacts] = useState<Facts | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage exists only in the browser, so it is read after mount
    setDismissed(readDismissed(activeId));
  }, [activeId]);

  const load = useCallback(async () => {
    const [state, audit, history, backups, instance] = await Promise.allSettled([
      getServerState(),
      getAuditLog(200),
      getPlayerHistory(),
      listBackups(),
      mode === "simple" ? instanceStatus() : Promise.resolve(null),
    ]);
    setFacts((prev) => {
      let started = prev?.started ?? false;
      // "Started at least once": any sign the server has run - its phase, a
      // start time on the container or process, an exit code, a start in the
      // audit log, or a world folder on this computer.
      if (state.status === "fulfilled") {
        const s = state.value;
        started =
          started ||
          (s.phase !== "not-created" && s.phase !== "stopped") ||
          Boolean(s.container?.startedAt) ||
          Boolean(s.process?.startedAt) ||
          (s.process?.lastExitCode ?? null) !== null;
      }
      if (audit.status === "fulfilled") {
        started =
          started ||
          audit.value.entries.some((e) => e.action === "server.start" && e.ok);
      }
      if (instance.status === "fulfilled" && instance.value?.worldExists) started = true;
      const names =
        history.status === "fulfilled"
          ? new Set(history.value.users.map((u) => u.username.toLowerCase())).size
          : (prev?.players ?? 0);
      const backupCount =
        backups.status === "fulfilled" ? backups.value.length : (prev?.backups ?? 0);
      return { started, players: names, backups: backupCount };
    });
  }, [mode]);

  useEffect(() => {
    if (dismissed !== false) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- IPC fetch-on-mount: re-read on a phase change, then lightly poll
    void load();
    const interval = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(interval);
  }, [dismissed, load, phase]);

  const steps = useMemo(
    () => [
      {
        id: "made",
        title: "Your server is made",
        hint: "Done the moment it appears here.",
        done: true,
        target: null as string | null,
      },
      {
        id: "started",
        title: "Start your server",
        hint: "Press Start. The first start can take a minute or two.",
        done: facts?.started ?? false,
        target: TARGET_START,
      },
      {
        id: "joined",
        title: "Join it yourself",
        hint: "Open Minecraft and use the address under How players join.",
        done: (facts?.players ?? 0) >= 1,
        target: TARGET_JOIN,
      },
      {
        id: "friend",
        title: "A friend joins",
        hint: "Send a friend the address under How players join.",
        done: (facts?.players ?? 0) >= 2,
        target: TARGET_JOIN,
      },
      {
        id: "backup",
        title: "Make your first backup",
        hint: "A backup is a saved copy of your world, in case something goes wrong.",
        done: (facts?.backups ?? 0) >= 1,
        target: TARGET_BACKUP,
      },
    ],
    [facts],
  );

  if (dismissed !== false || facts === null) return null;
  const doneCount = steps.filter((s) => s.done).length;
  if (doneCount === steps.length) return null;

  const dismiss = () => {
    play("click_back");
    try {
      window.localStorage.setItem(dismissedKey(activeId), "1");
    } catch {
      // Not remembered across restarts, still hidden for this session.
    }
    setDismissed(true);
  };

  return (
    <Card className="p-5" data-testid="getting-started">
      <Card.Header className="flex flex-row items-start justify-between gap-3">
        <div className="grid gap-1">
          <Card.Title>Getting started</Card.Title>
          <Card.Description>
            {doneCount} of {steps.length} done. A few things to try with a new server.
          </Card.Description>
        </div>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Hide Getting started"
          onPress={dismiss}
          onMouseEnter={() => play("hover")}
        >
          <X size={14} />
          Hide
        </Button>
      </Card.Header>
      <Card.Content className="mt-3">
        <ol className="grid gap-2">
          {steps.map((step) => (
            <li
              key={step.id}
              data-step={step.id}
              data-done={step.done ? "true" : "false"}
              className="flex flex-wrap items-center gap-3 rounded-lg border border-border px-3 py-2 text-sm"
            >
              <span
                className={`flex size-5 shrink-0 items-center justify-center rounded-full ${
                  step.done ? "bg-success text-success-foreground" : "text-muted"
                }`}
                aria-hidden
              >
                {step.done ? <Check size={13} /> : <Circle size={16} />}
              </span>
              <span className="sr-only">{step.done ? "Done: " : "Not done yet: "}</span>
              <div className="grid min-w-0 flex-1 gap-0.5">
                <span className={step.done ? "text-muted line-through" : "font-medium"}>
                  {step.title}
                </span>
                {!step.done && <span className="text-xs text-muted">{step.hint}</span>}
              </div>
              {!step.done && step.target !== null && (
                <Button
                  variant="secondary"
                  size="sm"
                  onPress={() => {
                    play("click_confirm");
                    showMe(step.target as string);
                  }}
                  onMouseEnter={() => play("hover")}
                >
                  Show me
                </Button>
              )}
            </li>
          ))}
        </ol>
      </Card.Content>
    </Card>
  );
}
