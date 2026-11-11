"use client";

// Getting started: five steps with live ticks, per server. Everything comes
// from calls that already exist (server state, audit log, player history,
// backups list, instance status). Each open step has a Show me that scrolls
// to the right control. Dismissible per server. Small celebrations: a step's
// check springs in and chimes when it turns done, and the fifth step brings an
// "All done" moment before the card goes away. Each one plays once per server
// (lib/milestones.ts), never again on a reload. Reduce-motion: Motion drops
// the transforms (MotionConfig) and the sparks are not rendered at all.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { Check, Circle, PartyPopper, X } from "lucide-react";
import { Button, Card, ProgressCircle } from "@heroui/react";
import {
  announceFriendJoined,
  markCelebrated,
  readCelebrated,
  type Milestone,
} from "@/app/lib/milestones";
import { scaleIn, transition } from "@/app/lib/motion";
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

const ALL_DONE_MS = 8000;
const SPARK_COLORS = ["bg-success", "bg-accent", "bg-warning"] as const;
const SPARKS = Array.from({ length: 12 }, (_, i) => {
  const angle = (i / 12) * Math.PI * 2;
  return {
    x: Math.round(Math.cos(angle) * (56 + (i % 3) * 14)),
    y: Math.round(Math.sin(angle) * (36 + (i % 3) * 10)),
    color: SPARK_COLORS[i % SPARK_COLORS.length],
  };
});

/** Phosphor never scales or springs (theme contract), so it gets neither the
 *  check spring nor the sparks; the rest of the moment is a fade. */
const isPhosphor = () =>
  typeof document !== "undefined" && document.documentElement.dataset.theme === "phosphor";

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
  const reduceMotion = useReducedMotion();
  // Steps that turned done while the app was open: only those spring in.
  const [popped, setPopped] = useState<ReadonlySet<string>>(new Set());
  const [allDone, setAllDone] = useState(false);
  const prevDone = useRef<Map<string, boolean> | null>(null);

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

  // Celebrate a step the first time it is seen turning done (per server).
  const doneKey = steps.map((s) => (s.done ? "1" : "0")).join("");
  useEffect(() => {
    if (dismissed !== false || facts === null) return;
    const before = prevDone.current;
    const now = new Map(steps.map((s) => [s.id, s.done]));
    prevDone.current = now;
    const seen = readCelebrated(activeId);
    const fresh = steps.filter(
      (s) => s.id !== "made" && s.done && !seen.has(s.id) && (before?.get(s.id) ?? true) === false,
    );
    for (const s of fresh) markCelebrated(activeId, s.id as Milestone);
    if (fresh.length > 0) {
      setPopped((prev) => new Set([...prev, ...fresh.map((s) => s.id)]));
      play("success");
      if (fresh.some((s) => s.id === "friend")) announceFriendJoined();
    }
    if (now.size > 0 && [...now.values()].every(Boolean) && !seen.has("all")) {
      markCelebrated(activeId, "all");
      setAllDone(true);
      if (fresh.length === 0) play("success");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- doneKey stands for the done flags
  }, [doneKey, dismissed, facts, activeId, play]);

  useEffect(() => {
    if (!allDone) return;
    const timer = setTimeout(() => setAllDone(false), ALL_DONE_MS);
    return () => clearTimeout(timer);
  }, [allDone]);

  // A different server starts clean.
  useEffect(() => {
    prevDone.current = null;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset when the open server changes
    setPopped(new Set());
    setAllDone(false);
  }, [activeId]);

  if (dismissed !== false || facts === null) return null;
  const doneCount = steps.filter((s) => s.done).length;
  if (doneCount === steps.length) {
    if (!allDone) return null;
    return (
      <motion.div
        variants={scaleIn("slow", 0.9)}
        initial="hidden"
        animate="show"
        className="relative"
        data-testid="getting-started-done"
      >
        <Card className="relative overflow-visible p-5" role="status">
          {!reduceMotion && !isPhosphor() && (
            <span aria-hidden className="pointer-events-none absolute left-1/2 top-1/2">
              {SPARKS.map((spark, i) => (
                <motion.span
                  key={i}
                  className={`absolute size-2 rounded-full ${spark.color}`}
                  initial={{ x: 0, y: 0, opacity: 1, scale: 1 }}
                  animate={{ x: spark.x, y: spark.y, opacity: 0, scale: 0.4 }}
                  transition={transition("slow", { duration: 0.9, delay: i * 0.02 })}
                />
              ))}
            </span>
          )}
          <Card.Header className="flex flex-row items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-success text-success-foreground">
                <PartyPopper size={20} aria-hidden />
              </span>
              <div className="grid gap-0.5">
                <Card.Title>All done!</Card.Title>
                <Card.Description>
                  You made a server, joined it, had a friend over and saved a backup. That is
                  a real server admin move.
                </Card.Description>
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              aria-label="Close this message"
              onPress={() => setAllDone(false)}
              onMouseEnter={() => play("hover")}
            >
              <X size={14} />
              Close
            </Button>
          </Card.Header>
        </Card>
      </motion.div>
    );
  }

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
        <div className="flex items-center gap-3">
          <div className="relative inline-flex size-12 shrink-0 items-center justify-center">
            <ProgressCircle
              aria-label={`Getting started: ${doneCount} of ${steps.length} done`}
              color={doneCount === steps.length - 1 ? "success" : "accent"}
              value={(doneCount / steps.length) * 100}
            >
              <ProgressCircle.Track className="size-12">
                <ProgressCircle.TrackCircle />
                <ProgressCircle.FillCircle />
              </ProgressCircle.Track>
            </ProgressCircle>
            <span
              aria-hidden
              className="font-pixel-num absolute text-sm text-foreground"
              data-testid="getting-started-ring"
            >
              {doneCount}
            </span>
          </div>
          <div className="grid gap-1">
            <Card.Title>Getting started</Card.Title>
            <Card.Description>
              {doneCount} of {steps.length} done. A few things to try with a new server.
            </Card.Description>
          </div>
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
              <motion.span
                key={step.done ? "done" : "open"}
                className={`flex size-5 shrink-0 items-center justify-center rounded-full ${
                  step.done ? "bg-success text-success-foreground" : "text-muted"
                }`}
                aria-hidden
                initial={step.done && popped.has(step.id) && !isPhosphor() ? { scale: 0.3 } : false}
                animate={{ scale: 1 }}
                transition={{ type: "spring", stiffness: 420, damping: 14 }}
              >
                {step.done ? <Check size={13} /> : <Circle size={16} />}
              </motion.span>
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
