"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import {
  Boxes,
  Filter,
  Info,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
  TriangleAlert,
} from "lucide-react";
import {
  Accordion,
  Button,
  Card,
  Chip,
  Label,
  ListBox,
  Select,
  TextField,
  Input,
  toast,
} from "@heroui/react";
import AddModDialog from "@/app/components/AddModDialog";
import ConfirmDialog from "@/app/components/ConfirmDialog";
import ModCard from "@/app/components/ModCard";
import PageHeader from "@/app/components/PageHeader";
import { useServers } from "@/app/components/ServerProvider";
import { formatDateTime } from "@/app/lib/format";
import { SkeletonCard } from "@/app/components/Skeleton";
import { useUISound } from "@/app/hooks/useUISound";
import { useMode } from "@/app/components/ModeProvider";
import { usePageMotion } from "@/app/lib/motion";
import {
  deleteMod,
  listMods,
  restartServer,
  IpcError,
  type ModEntry,
  type ModTarget,
  type ModsList,
} from "@/app/lib/ipc";

export default function ModsPage() {
  const { containerMotion, cardMotion } = usePageMotion();
  const [mods, setMods] = useState<ModsList | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const { active, activeId, overview, refreshOverview } = useServers();
  const serverEntry = overview.find((item) => item.id === activeId);
  const phase = serverEntry?.phase;
  const serverLoader = serverEntry?.loader ?? null;
  // Files changed while the server was running: it only reads them at start.
  const [needsRestart, setNeedsRestart] = useState(false);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<{ item: ModEntry; kind: ModTarget } | null>(null);
  const addedInDialog = useRef(false);
  // Shared app-wide mode (app/components/ModeProvider.tsx) — reacts live to a
  // navbar toggle instead of the old per-mount getServerState() snapshot.
  const { mode } = useMode();
  const isSimpleMode = mode === "simple";
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "mods" | "plugins">("all");
  const [sort, setSort] = useState<"name-asc" | "name-desc" | "size-desc" | "updated-desc">("name-asc");
  const [copied, setCopied] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [pageSize, setPageSize] = useState(24);
  const [showUpload, setShowUpload] = useState(false);
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set(["mods", "plugins"]));
  const { play } = useUISound();

  const refreshMods = useCallback(
    () =>
      listMods()
        .then((list) => {
          setMods(list);
          setListError(null);
        })
        .catch((error) => {
          // Keep the last good list; an error must not read as "no mods".
          setListError(error instanceof IpcError ? error.message : "The list could not be read.");
        }),
    [],
  );

  // The banner lives exactly as long as the server keeps running: a stop or a
  // restart (phase leaves "running") means the files were picked up.
  const [seenPhase, setSeenPhase] = useState(phase);
  if (phase !== seenPhase) {
    setSeenPhase(phase);
    if (phase !== undefined && phase !== "running") setNeedsRestart(false);
  }

  useEffect(() => {
    refreshMods().finally(() => setLoading(false));
  }, [refreshMods]);

  const normalize = (value: string) => value.toLowerCase().trim();
  const matchesQuery = useCallback(
    (entry: ModEntry) => {
      const needle = normalize(query);
      if (!needle) return true;
      return normalize(entry.name).includes(needle) || normalize(entry.filename).includes(needle);
    },
    [query],
  );

  const sortEntries = useCallback(
    (items: ModEntry[]) => {
      const next = [...items];
      switch (sort) {
        case "name-desc":
          return next.sort((a, b) => b.name.localeCompare(a.name));
        case "size-desc":
          return next.sort((a, b) => b.sizeBytes - a.sizeBytes);
        case "updated-desc":
          return next.sort((a, b) => b.updatedAtEpochMs - a.updatedAtEpochMs);
        default:
          return next.sort((a, b) => a.name.localeCompare(b.name));
      }
    },
    [sort],
  );

  const filteredMods = useMemo(
    () => sortEntries((mods?.mods ?? []).filter(matchesQuery)),
    [mods, matchesQuery, sortEntries],
  );
  const filteredPlugins = useMemo(
    () => sortEntries((mods?.plugins ?? []).filter(matchesQuery)),
    [mods, matchesQuery, sortEntries],
  );
  const allEntries = useMemo(() => [...filteredMods, ...filteredPlugins], [filteredMods, filteredPlugins]);
  const pagedMods = useMemo(() => filteredMods.slice(0, pageSize), [filteredMods, pageSize]);
  const pagedPlugins = useMemo(() => filteredPlugins.slice(0, pageSize), [filteredPlugins, pageSize]);

  const lastUpdated = useMemo(() => {
    const all = [...(mods?.mods ?? []), ...(mods?.plugins ?? [])];
    if (!all.length) return null;
    return all.reduce((acc, entry) =>
      entry.updatedAtEpochMs > acc.updatedAtEpochMs ? entry : acc,
    ).updatedAtEpochMs;
  }, [mods]);

  const copyFilename = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(value);
      play("success");
      toast.success("Copied to clipboard");
      setTimeout(() => setCopied(null), 1500);
    } catch {
      play("error");
      toast.danger("Failed to copy");
    }
  };

  const runDelete = async () => {
    if (!confirmDelete) return;
    const { item, kind } = confirmDelete;
    setConfirmDelete(null);
    setDeleting(`${kind}:${item.filename}`);
    try {
      await deleteMod(item.filename, kind);
      play("success");
      toast.success("Deleted");
      if (phase === "running") setNeedsRestart(true);
      await refreshMods();
    } catch (error) {
      play("error");
      toast.danger(error instanceof IpcError ? error.message : "Delete failed");
    } finally {
      setDeleting(null);
    }
  };

  const doRestart = async () => {
    setRestarting(true);
    try {
      await restartServer();
      play("success");
      toast.success(`Restarting ${active.name}`);
      setNeedsRestart(false);
      setConfirmRestart(false);
      await refreshOverview();
    } catch (error) {
      play("error");
      toast.danger(error instanceof IpcError ? error.message : "Could not restart the server.");
    } finally {
      setRestarting(false);
    }
  };

  const totalMods = mods?.mods.length ?? 0;
  const totalPlugins = mods?.plugins.length ?? 0;
  const searching = normalize(query) !== "";
  const countOf = (shown: number, total: number) =>
    searching ? `${shown} of ${total}` : `${total}`;

  const showMods = filter === "all" || filter === "mods";
  const showPlugins = filter === "all" || filter === "plugins";

  if (loading) {
    return (
      <div className="min-h-screen bg-background">
        <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 px-4 py-10 md:px-6">
          <div className="h-16" />
          <div className="grid gap-4 md:grid-cols-2">
            {[1, 2, 3, 4].map((i) => (
              <SkeletonCard key={i} />
            ))}
          </div>
        </main>
      </div>
    );
  }

  return (
    <div
      className="min-h-screen"
      style={{ background: `radial-gradient(circle at top, var(--page-wash), transparent 60%), var(--background)` }}
    >
      <motion.main
        className="page-main mx-auto flex max-w-5xl flex-col gap-6 px-4 pt-5 pb-10 md:px-6"
        initial="hidden"
        animate="show"
        variants={containerMotion}
      >
        <PageHeader title="Mods & Plugins" icon={Boxes} />

        {/* Mounts after the async settings fetch, past the parent's stagger —
            must drive its own enter animation. */}
        {isSimpleMode && (
          <motion.section variants={cardMotion} initial="hidden" animate="show">
            <Card className="p-4">
              <Card.Content className="flex items-start gap-3 text-sm text-muted">
                <Info size={16} className="mt-0.5 shrink-0 text-accent" />
                <span>
                  Simple mode runs a vanilla server, which does not load mods or
                  plugins. Files you manage here are kept in the instance folder
                  and picked up if you switch to a modded setup later.
                </span>
              </Card.Content>
            </Card>
          </motion.section>
        )}

        {needsRestart && phase === "running" && (
          <motion.section variants={cardMotion} initial="hidden" animate="show">
            <div
              role="status"
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning p-3 text-sm"
            >
              <span className="flex items-center gap-2">
                <TriangleAlert size={16} className="shrink-0 text-warning" />
                Changes take effect after a restart.
              </span>
              <Button
                size="sm"
                onPress={() => {
                  play("click_confirm");
                  setConfirmRestart(true);
                }}
                onMouseEnter={() => play("hover")}
              >
                <RefreshCw size={14} />
                Restart server
              </Button>
            </div>
          </motion.section>
        )}

        {listError && (
          <motion.section variants={cardMotion} initial="hidden" animate="show">
            <div
              role="alert"
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-danger p-3 text-sm"
            >
              <span className="flex items-start gap-2">
                <TriangleAlert size={16} className="mt-0.5 shrink-0 text-danger" />
                <span>Couldn&apos;t read the mods and plugins: {listError}</span>
              </span>
              <Button
                size="sm"
                variant="secondary"
                onPress={() => {
                  play("click_confirm");
                  void refreshMods();
                }}
                onMouseEnter={() => play("hover")}
              >
                Try again
              </Button>
            </div>
          </motion.section>
        )}

        <motion.section variants={cardMotion}>
          <Card className="flex flex-wrap items-center justify-between gap-4 p-5">
            <Card.Content className="flex sm:flex-col md:flex-row justify-center gap-3 text-sm">
              <Chip variant="soft">Mods: {countOf(filteredMods.length, totalMods)}</Chip>
              <Chip variant="soft">Plugins: {countOf(filteredPlugins.length, totalPlugins)}</Chip>
              <Chip variant="soft">
                Total: {countOf(allEntries.length, totalMods + totalPlugins)}
              </Chip>
              <Chip variant="soft">
                Last updated: {lastUpdated ? formatDateTime(lastUpdated) : "—"}
              </Chip>
            </Card.Content>
            <Card.Footer className="flex flex-wrap items-center gap-3">
              <Button onPress={() => setShowUpload(true)} onMouseEnter={() => play("hover")}>
                <Plus size={16} />
                Add mod or plugin
              </Button>
              <div className="flex items-center gap-2">
                <Search size={16} className="text-muted" />
                <TextField className="w-56">
                  <Label className="sr-only">Search mods</Label>
                  <Input
                    placeholder="Search mods or files"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </TextField>
              </div>
              <div className="flex items-center gap-2">
                <Filter size={16} className="text-muted" />
                <Select
                  className="w-36 text-sm"
                  placeholder="Filter"
                  value={filter}
                  onChange={(value) => setFilter(value as typeof filter)}
                >
                  <Label className="sr-only">Filter</Label>
                  <Select.Trigger>
                    <Select.Value />
                    <Select.Indicator />
                  </Select.Trigger>
                  <Select.Popover>
                    <ListBox>
                      <ListBox.Item id="all">All</ListBox.Item>
                      <ListBox.Item id="mods">Mods</ListBox.Item>
                      <ListBox.Item id="plugins">Plugins</ListBox.Item>
                    </ListBox>
                  </Select.Popover>
                </Select>
              </div>
              <div className="flex items-center gap-2">
                <SlidersHorizontal size={16} className="text-muted" />
                <Select
                  className="w-44 text-sm"
                  placeholder="Sort"
                  value={sort}
                  onChange={(value) => setSort(value as typeof sort)}
                >
                  <Label className="sr-only">Sort</Label>
                  <Select.Trigger>
                    <Select.Value />
                    <Select.Indicator />
                  </Select.Trigger>
                  <Select.Popover>
                    <ListBox>
                      <ListBox.Item id="name-asc">Name (A-Z)</ListBox.Item>
                      <ListBox.Item id="name-desc">Name (Z-A)</ListBox.Item>
                      <ListBox.Item id="size-desc">Size (Largest)</ListBox.Item>
                      <ListBox.Item id="updated-desc">Recently Updated</ListBox.Item>
                    </ListBox>
                  </Select.Popover>
                </Select>
              </div>
            </Card.Footer>
          </Card>
        </motion.section>

        <motion.section className="grid gap-6" variants={containerMotion}>
          {mods && totalMods + totalPlugins === 0 && !listError ? (
            <Card className="p-6">
              <Card.Content className="text-sm text-muted">
                No mods yet. Add one with &apos;Add mod or plugin&apos;.
              </Card.Content>
            </Card>
          ) : (
          <Accordion
            allowsMultipleExpanded
            expandedKeys={expandedKeys}
            onExpandedChange={(keys) => setExpandedKeys(new Set(Array.from(keys) as string[]))}
            variant="surface"
          >
            {showMods && (
              <Accordion.Item id="mods">
                <Accordion.Heading>
                  <Accordion.Trigger className="flex items-center justify-between gap-3">
                    <div className="font-semibold">Mods ({countOf(filteredMods.length, totalMods)})</div>
                    <Accordion.Indicator />
                  </Accordion.Trigger>
                </Accordion.Heading>
                <Accordion.Panel>
                  <Accordion.Body className="mt-4 grid gap-3 md:grid-cols-2">
                    {pagedMods.length ? (
                      pagedMods.map((item, index) => (
                        <ModCard
                          key={item.filename}
                          item={item}
                          kind="mods"
                          serverLoader={serverLoader}
                          copied={copied === item.filename}
                          deleting={deleting === `mods:${item.filename}`}
                          index={index}
                          variants={cardMotion}
                          onCopy={copyFilename}
                          onDelete={(entry, target) => setConfirmDelete({ item: entry, kind: target })}
                        />
                      ))
                    ) : (
                      <span className="text-sm text-muted">
                        {searching ? "No matches." : "None"}
                      </span>
                    )}
                  </Accordion.Body>
                </Accordion.Panel>
              </Accordion.Item>
            )}

            {showPlugins && (
              <Accordion.Item id="plugins">
                <Accordion.Heading>
                  <Accordion.Trigger className="flex items-center justify-between gap-3">
                    <div className="font-semibold">Plugins ({countOf(filteredPlugins.length, totalPlugins)})</div>
                    <Accordion.Indicator />
                  </Accordion.Trigger>
                </Accordion.Heading>
                <Accordion.Panel>
                  <Accordion.Body className="mt-4 grid gap-3 md:grid-cols-2">
                    {pagedPlugins.length ? (
                      pagedPlugins.map((item, index) => (
                        <ModCard
                          key={item.filename}
                          item={item}
                          kind="plugins"
                          serverLoader={serverLoader}
                          copied={copied === item.filename}
                          deleting={deleting === `plugins:${item.filename}`}
                          index={index}
                          variants={cardMotion}
                          onCopy={copyFilename}
                          onDelete={(entry, target) => setConfirmDelete({ item: entry, kind: target })}
                        />
                      ))
                    ) : (
                      <span className="text-sm text-muted">
                        {searching ? "No matches." : "None"}
                      </span>
                    )}
                  </Accordion.Body>
                </Accordion.Panel>
              </Accordion.Item>
            )}
          </Accordion>
          )}

          {showMods && filteredMods.length > pageSize && (
            <Button
              className="w-fit"
              onPress={() => {
                play("click_confirm");
                setPageSize(pageSize + 24);
              }}
              onMouseEnter={() => play("hover")}
            >
              Show more mods
            </Button>
          )}

          {showPlugins && filteredPlugins.length > pageSize && (
            <Button
              className="w-fit"
              onPress={() => {
                play("click_confirm");
                setPageSize(pageSize + 24);
              }}
              onMouseEnter={() => play("hover")}
            >
              Show more plugins
            </Button>
          )}
        </motion.section>
      </motion.main>

      <AddModDialog
        isOpen={showUpload}
        onClose={() => {
          setShowUpload(false);
          // Closing after something was added: the running server has not
          // seen it yet.
          if (addedInDialog.current && phase === "running") setNeedsRestart(true);
          addedInDialog.current = false;
        }}
        onInstalled={() => {
          addedInDialog.current = true;
          void refreshMods();
        }}
      />

      <ConfirmDialog
        isOpen={confirmDelete !== null}
        title={`Delete ${confirmDelete ? confirmDelete.item.name || confirmDelete.item.filename : ""}`}
        description={
          confirmDelete
            ? `The file ${confirmDelete.item.filename} is removed from the server's ${confirmDelete.kind} folder. A world that used it may not load correctly without it.`
            : undefined
        }
        confirmLabel="Delete"
        variant="danger"
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => void runDelete()}
      />

      <ConfirmDialog
        isOpen={confirmRestart}
        title={`Restart ${active.name}`}
        description="Everyone playing is disconnected for a moment."
        confirmLabel="Restart"
        variant="danger"
        isLoading={restarting}
        onCancel={() => setConfirmRestart(false)}
        onConfirm={() => void doRestart()}
      />
    </div>
  );
}
