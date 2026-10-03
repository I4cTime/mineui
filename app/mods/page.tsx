"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import {
  Boxes,
  Copy,
  Filter,
  Info,
  Plus,
  Search,
  SlidersHorizontal,
  Sparkles,
  Trash2,
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
import PageHeader from "@/app/components/PageHeader";
import { formatBytes, formatDateTime } from "@/app/lib/format";
import { SkeletonCard } from "@/app/components/Skeleton";
import { useUISound } from "@/app/hooks/useUISound";
import { useMode } from "@/app/components/ModeProvider";
import { usePageMotion } from "@/app/lib/motion";
import {
  deleteMod,
  listMods,
  IpcError,
  type ModEntry,
  type ModTarget,
  type ModsList,
} from "@/app/lib/ipc";

export default function ModsPage() {
  const { containerMotion, cardMotion } = usePageMotion();
  const [mods, setMods] = useState<ModsList | null>(null);
  const [loading, setLoading] = useState(true);
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
        .then(setMods)
        .catch(() => setMods({ mods: [], plugins: [] })),
    [],
  );

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

  const loaderBadge = (loader: ModEntry["loader"]) => {
    switch (loader) {
      case "neoforge":
        return "NeoForge";
      case "forge":
        return "Forge";
      case "fabric":
        return "Fabric";
      default:
        return "Unknown";
    }
  };

  const fileTypeBadge = (filename: string) => {
    const lower = filename.toLowerCase();
    if (lower.endsWith(".jar.disabled")) return "Disabled";
    if (lower.endsWith(".jar")) return "JAR";
    if (lower.endsWith(".zip")) return "ZIP";
    return "File";
  };

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

  const handleDelete = async (item: ModEntry, kind: ModTarget) => {
    const label = item.name || item.filename;
    const confirmDelete = window.confirm(`Delete ${label}? This cannot be undone.`);
    if (!confirmDelete) return;

    setDeleting(`${kind}:${item.filename}`);
    play("click_confirm");
    try {
      await deleteMod(item.filename, kind);
      play("success");
      toast.success("Deleted");
      await refreshMods();
    } catch (error) {
      play("error");
      toast.danger(error instanceof IpcError ? error.message : "Delete failed");
    } finally {
      setDeleting(null);
    }
  };

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

        <motion.section variants={cardMotion}>
          <Card className="flex flex-wrap items-center justify-between gap-4 p-5">
            <Card.Content className="flex sm:flex-col md:flex-row justify-center gap-3 text-sm">
              <Chip variant="soft" color="accent" className="flex items-center gap-2">
                <Sparkles size={14} />
                Curated view
              </Chip>
              <Chip variant="soft">Mods: {mods?.mods.length ?? 0}</Chip>
              <Chip variant="soft">Plugins: {mods?.plugins.length ?? 0}</Chip>
              <Chip variant="soft">Total: {allEntries.length}</Chip>
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
                    <div className="font-semibold">Mods ({filteredMods.length})</div>
                    <Accordion.Indicator />
                  </Accordion.Trigger>
                </Accordion.Heading>
                <Accordion.Panel>
                  <Accordion.Body className="mt-4 grid gap-3 md:grid-cols-2">
                    {pagedMods.length ? (
                      pagedMods.map((item, index) => (
                        <motion.div key={item.filename} variants={cardMotion} custom={index}>
                          <Card className="p-4 text-sm" variant="secondary">
                            <Card.Header className="gap-1">
                              <Card.Title className="text-base">{item.name}</Card.Title>
                              <Card.Description className="text-xs text-muted">
                                Updated {formatDateTime(item.updatedAtEpochMs)}
                              </Card.Description>
                            </Card.Header>
                            <Card.Content className="mt-3 flex flex-row flex-wrap gap-2 text-xs">
                              <Chip variant="soft">Size: {formatBytes(item.sizeBytes)}</Chip>
                              <Chip variant="soft">Loader: {loaderBadge(item.loader)}</Chip>
                              <Chip variant="soft">{fileTypeBadge(item.filename)}</Chip>
                              <Chip variant="soft" className="max-w-full">
                                <span className="truncate">File: {item.filename}</span>
                              </Chip>
                            </Card.Content>
                            <Card.Footer className="mt-3 flex flex-wrap items-center gap-2">
                              <Button
                                size="sm"
                                variant="ghost"
                                onPress={() => copyFilename(item.filename)}
                                onMouseEnter={() => play("hover")}
                              >
                                <Copy size={12} />
                                {copied === item.filename ? "Copied" : "Copy"}
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="text-danger hover:text-danger-soft-foreground"
                                isDisabled={deleting === `mods:${item.filename}`}
                                onPress={() => handleDelete(item, "mods")}
                                onMouseEnter={() => play("hover")}
                              >
                                <Trash2 size={12} />
                                Delete
                              </Button>
                            </Card.Footer>
                          </Card>
                        </motion.div>
                      ))
                    ) : (
                      <span className="text-sm text-muted">None</span>
                    )}
                  </Accordion.Body>
                </Accordion.Panel>
              </Accordion.Item>
            )}

            {showPlugins && (
              <Accordion.Item id="plugins">
                <Accordion.Heading>
                  <Accordion.Trigger className="flex items-center justify-between gap-3">
                    <div className="font-semibold">Plugins ({filteredPlugins.length})</div>
                    <Accordion.Indicator />
                  </Accordion.Trigger>
                </Accordion.Heading>
                <Accordion.Panel>
                  <Accordion.Body className="mt-4 grid gap-3 md:grid-cols-2">
                    {pagedPlugins.length ? (
                      pagedPlugins.map((item, index) => (
                        <motion.div key={item.filename} variants={cardMotion} custom={index}>
                          <Card className="p-4 text-sm">
                            <Card.Header className="gap-1">
                              <Card.Title className="text-base">{item.name}</Card.Title>
                              <Card.Description className="text-xs text-muted">
                                Updated {formatDateTime(item.updatedAtEpochMs)}
                              </Card.Description>
                            </Card.Header>
                            <Card.Content className="mt-3 flex flex-wrap gap-2 text-xs">
                              <Chip variant="soft">Size: {formatBytes(item.sizeBytes)}</Chip>
                              <Chip variant="soft">Loader: {loaderBadge(item.loader)}</Chip>
                              <Chip variant="soft">{fileTypeBadge(item.filename)}</Chip>
                              <Chip variant="soft" className="max-w-full">
                                <span className="truncate">File: {item.filename}</span>
                              </Chip>
                            </Card.Content>
                            <Card.Footer className="mt-3 flex flex-wrap items-center gap-2">
                              <Button
                                size="sm"
                                variant="ghost"
                                onPress={() => copyFilename(item.filename)}
                                onMouseEnter={() => play("hover")}
                              >
                                <Copy size={12} />
                                {copied === item.filename ? "Copied" : "Copy"}
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="text-danger hover:text-danger-soft-foreground"
                                isDisabled={deleting === `plugins:${item.filename}`}
                                onPress={() => handleDelete(item, "plugins")}
                                onMouseEnter={() => play("hover")}
                              >
                                <Trash2 size={12} />
                                Delete
                              </Button>
                            </Card.Footer>
                          </Card>
                        </motion.div>
                      ))
                    ) : (
                      <span className="text-sm text-muted">None</span>
                    )}
                  </Accordion.Body>
                </Accordion.Panel>
              </Accordion.Item>
            )}
          </Accordion>

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
        onClose={() => setShowUpload(false)}
        onInstalled={refreshMods}
      />
    </div>
  );
}
