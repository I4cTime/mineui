"use client";

// Dashboard strip: every server profile at a glance (contract §3.12
// get_servers_overview) - state, players, start/stop - without leaving the
// server that is open. Rendered only when there is more than one server.
// Never taller than two rows of cards: beyond that the strip scrolls, so the
// log and KPIs below stay in reach however many servers there are.
import { useLayoutEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { Layers, Play, Square } from "lucide-react";
import { Button, Card, Chip, ScrollShadow, toast } from "@heroui/react";
import { useUISound } from "@/app/hooks/useUISound";
import { usePageMotion } from "@/app/lib/motion";
import {
  identityLine,
  phaseDotClass,
  phaseText,
  useServers,
} from "@/app/components/ServerProvider";
import {
  IpcError,
  startServerById,
  stopServerById,
  type ServerOverview,
} from "@/app/lib/ipc";

const MAX_VISIBLE_ROWS = 2;

const isUp = (entry: ServerOverview | undefined) =>
  entry?.phase === "running" || entry?.phase === "starting";

export default function ServersOverview() {
  const { play } = useUISound();
  const { cardMotion } = usePageMotion();
  const { servers, activeId, overview, switching, switchTo, refreshOverview } =
    useServers();
  const [busyId, setBusyId] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [maxHeight, setMaxHeight] = useState<number | undefined>(undefined);
  const manyServers = servers.length >= 2;

  // Height of MAX_VISIBLE_ROWS rows, measured rather than assumed: a card's
  // height depends on the theme's fonts and on how the identity line wraps
  // at the current column width. Rows are equal height (auto-rows-fr), so
  // one card stands for all. The observer also fires once on observe().
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const observer = new ResizeObserver(() => {
      const card = grid.firstElementChild;
      if (!(card instanceof HTMLElement)) return;
      const gap = parseFloat(getComputedStyle(grid).rowGap) || 0;
      setMaxHeight(
        Math.ceil(card.offsetHeight * MAX_VISIBLE_ROWS + gap * (MAX_VISIBLE_ROWS - 1)),
      );
    });
    observer.observe(grid);
    return () => observer.disconnect();
  }, [manyServers]);

  if (!manyServers) return null;

  const runLifecycle = async (
    id: string,
    name: string,
    action: (id: string) => Promise<void>,
    verb: string,
  ) => {
    play("click_confirm");
    setBusyId(id);
    try {
      await action(id);
      play("success");
      toast.success(`${name}: ${verb}`);
    } catch (error) {
      play("error");
      toast.danger(
        error instanceof IpcError ? `${name}: ${error.message}` : `${name}: failed`,
      );
    } finally {
      setBusyId(null);
      refreshOverview();
    }
  };

  return (
    <motion.section variants={cardMotion} initial="hidden" animate="show">
      <Card className="p-5">
        <Card.Header className="flex flex-row items-center gap-3 text-sm text-accent">
          <Layers size={18} />
          <span className="font-pixel text-xs tracking-wide">All Servers</span>
          <span className="font-pixel-num text-xs text-muted">{servers.length}</span>
        </Card.Header>
        <Card.Content className="mt-4">
          <ScrollShadow
            className="overflow-y-auto"
            style={{ maxHeight }}
            aria-label="All servers"
            tabIndex={0}
          >
            <div
              ref={gridRef}
              className="grid auto-rows-fr gap-3 sm:grid-cols-2 lg:grid-cols-3"
            >
              {servers.map((server) => {
                const entry = overview.find((item) => item.id === server.id);
                const isOpen = server.id === activeId;
                const up = isUp(entry);
                const canAct = entry !== undefined && entry.phase !== "not-created" && entry.phase !== null;
                return (
                  <div
                    key={server.id}
                    className={`flex flex-col gap-3 rounded-lg border p-4 ${
                      isOpen ? "border-accent" : "border-border"
                    }`}
                    style={{ background: "var(--surface-secondary)" }}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2">
                        <span
                          aria-hidden
                          className={`size-2 shrink-0 rounded-full ${phaseDotClass(entry?.phase)}`}
                        />
                        <span className="truncate text-sm font-semibold">{server.name}</span>
                      </div>
                      <Chip size="sm" variant="soft" color={isOpen ? "accent" : "default"}>
                        {isOpen ? "Open" : entry?.mode === "simple" ? "Simple" : "Advanced"}
                      </Chip>
                    </div>

                    <div className="grid gap-1 text-xs text-muted">
                      <span>{entry ? phaseText(entry.phase) : "Checking…"}</span>
                      <span className="font-mono wrap-anywhere">
                        {entry?.error ?? (identityLine(entry) || "-")}
                      </span>
                      <span>
                        Players:{" "}
                        <span className="font-pixel-num text-foreground">
                          {entry?.status.online
                            ? `${entry.status.players.online}/${entry.status.players.max}`
                            : "-"}
                        </span>
                      </span>
                    </div>

                    <div className="mt-auto flex flex-wrap gap-2">
                      {up ? (
                        <Button
                          size="sm"
                          variant="danger"
                          isDisabled={busyId !== null || !canAct}
                          isPending={busyId === server.id}
                          onPress={() => runLifecycle(server.id, server.name, stopServerById, "stopped")}
                          onMouseEnter={() => play("hover")}
                        >
                          <Square size={14} />
                          Stop
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          isDisabled={busyId !== null || !canAct}
                          isPending={busyId === server.id}
                          onPress={() => runLifecycle(server.id, server.name, startServerById, "started")}
                          onMouseEnter={() => play("hover")}
                        >
                          <Play size={14} />
                          Start
                        </Button>
                      )}
                      {!isOpen && (
                        <Button
                          size="sm"
                          variant="secondary"
                          isDisabled={switching}
                          onPress={() => {
                            play("click_confirm");
                            switchTo(server.id);
                          }}
                          onMouseEnter={() => play("hover")}
                        >
                          Open
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </ScrollShadow>
        </Card.Content>
      </Card>
    </motion.section>
  );
}
