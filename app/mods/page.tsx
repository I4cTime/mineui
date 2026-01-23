"use client";

import { useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import { toast } from "sonner";
import {
  Boxes,
  Copy,
  Download,
  Filter,
  Search,
  SlidersHorizontal,
  Sparkles,
  Upload,
  X,
} from "lucide-react";
import {
  Button,
  Card,
  Chip,
  Disclosure,
  Label,
  ListBox,
  Modal,
  Select,
  TextField,
  Input,
} from "@heroui/react";
import PageHeader from "@/app/components/PageHeader";
import { SkeletonCard } from "@/app/components/Skeleton";
import { useUISound } from "@/app/hooks/useUISound";

type ModEntry = {
  name: string;
  filename: string;
  sizeBytes: number;
  updatedAt: number;
  loader: "forge" | "neoforge" | "fabric" | "unknown";
};

type ModsResponse = {
  mods: ModEntry[];
  plugins: ModEntry[];
};

const fetchJson = async <T,>(path: string): Promise<T> => {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json() as Promise<T>;
};

const containerMotion = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { staggerChildren: 0.05 } },
};

const cardMotion = {
  hidden: { opacity: 0, y: 10, scale: 0.98 },
  show: { opacity: 1, y: 0, scale: 1 },
};

export default function ModsPage() {
  const [mods, setMods] = useState<ModsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "mods" | "plugins">("all");
  const [sort, setSort] = useState<"name-asc" | "name-desc" | "size-desc" | "updated-desc">("name-asc");
  const [copied, setCopied] = useState<string | null>(null);
  const [pageSize, setPageSize] = useState(24);
  const [showUpload, setShowUpload] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [downloadUrl, setDownloadUrl] = useState("");
  const [downloadName, setDownloadName] = useState("");
  const [target, setTarget] = useState<"mods" | "plugins">("mods");
  const [busy, setBusy] = useState(false);
  const [modsExpanded, setModsExpanded] = useState(true);
  const [pluginsExpanded, setPluginsExpanded] = useState(true);
  const { play } = useUISound();

  const refreshMods = () =>
    fetchJson<ModsResponse>("/api/mods")
      .then(setMods)
      .catch(() => setMods({ mods: [], plugins: [] }));

  useEffect(() => {
    refreshMods().finally(() => setLoading(false));
  }, []);

  const normalize = (value: string) => value.toLowerCase().trim();
  const matchesQuery = (entry: ModEntry) => {
    const needle = normalize(query);
    if (!needle) return true;
    return normalize(entry.name).includes(needle) || normalize(entry.filename).includes(needle);
  };

  const sortEntries = (items: ModEntry[]) => {
    const next = [...items];
    switch (sort) {
      case "name-desc":
        return next.sort((a, b) => b.name.localeCompare(a.name));
      case "size-desc":
        return next.sort((a, b) => b.sizeBytes - a.sizeBytes);
      case "updated-desc":
        return next.sort((a, b) => b.updatedAt - a.updatedAt);
      default:
        return next.sort((a, b) => a.name.localeCompare(b.name));
    }
  };

  const filteredMods = useMemo(() => sortEntries((mods?.mods ?? []).filter(matchesQuery)), [mods, query, sort]);
  const filteredPlugins = useMemo(() => sortEntries((mods?.plugins ?? []).filter(matchesQuery)), [mods, query, sort]);
  const allEntries = useMemo(() => [...filteredMods, ...filteredPlugins], [filteredMods, filteredPlugins]);
  const pagedMods = useMemo(() => filteredMods.slice(0, pageSize), [filteredMods, pageSize]);
  const pagedPlugins = useMemo(() => filteredPlugins.slice(0, pageSize), [filteredPlugins, pageSize]);

  const lastUpdated = useMemo(() => {
    const all = [...(mods?.mods ?? []), ...(mods?.plugins ?? [])];
    if (!all.length) return null;
    return all.reduce((acc, entry) => (entry.updatedAt > acc.updatedAt ? entry : acc)).updatedAt;
  }, [mods]);

  const formatBytes = (value: number) => {
    if (!value) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    let size = value;
    let unit = 0;
    while (size >= 1024 && unit < units.length - 1) {
      size /= 1024;
      unit += 1;
    }
    return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
  };

  const formatDate = (value: number) => {
    if (!value) return "—";
    return new Date(value * 1000).toLocaleString();
  };

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

  const copyFilename = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(value);
      play("success");
      toast.success("Copied to clipboard");
      setTimeout(() => setCopied(null), 1500);
    } catch {
      play("error");
      toast.error("Failed to copy");
    }
  };

  const handleUpload = async () => {
    if (!uploadFile) {
      toast.error("Choose a mod file first");
      return;
    }
    setBusy(true);
    play("click_confirm");
    try {
      const form = new FormData();
      form.append("file", uploadFile);
      form.append("target", target);
      const res = await fetch("/api/mods/upload", {
        method: "POST",
        body: form,
      });
      if (!res.ok) throw new Error("Upload failed");
      play("success");
      toast.success("Mod uploaded");
      setUploadFile(null);
      await refreshMods();
    } catch {
      play("error");
      toast.error("Upload failed");
    } finally {
      setBusy(false);
    }
  };

  const handleDownload = async () => {
    if (!downloadUrl.trim()) {
      toast.error("Enter a URL");
      return;
    }
    setBusy(true);
    play("click_confirm");
    try {
      const res = await fetch("/api/mods/download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: downloadUrl.trim(),
          filename: downloadName.trim() || undefined,
          target,
        }),
      });
      if (!res.ok) throw new Error("Download failed");
      play("success");
      toast.success("Mod downloaded");
      setDownloadUrl("");
      setDownloadName("");
      await refreshMods();
    } catch {
      play("error");
      toast.error("Download failed");
    } finally {
      setBusy(false);
    }
  };

  const showMods = filter === "all" || filter === "mods";
  const showPlugins = filter === "all" || filter === "plugins";

  if (loading) {
    return (
      <div className="min-h-screen" style={{ background: "var(--background)" }}>
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
      style={{ background: `radial-gradient(circle at top, color-mix(in oklab, var(--accent) 18%, transparent), transparent 60%), var(--background)` }}
    >
      <motion.main
        className="page-main mx-auto flex max-w-5xl flex-col gap-6 px-4 py-10 md:px-6"
        initial="hidden"
        animate="show"
        variants={containerMotion}
      >
        <PageHeader title="Mods & Plugins" icon={Boxes} />

        <motion.section variants={cardMotion}>
          <Card className="flex flex-wrap items-center justify-between gap-4 p-5">
            <Card.Content className="flex sm:flex-col md:flex-row justify-center gap-3 text-sm">
              <Chip variant="soft" color="accent" className="flex items-center gap-2">
                <Sparkles size={14} />
                Curated view
              </Chip>
              <Chip variant="soft">Mods: {mods?.mods?.length ?? 0}</Chip>
              <Chip variant="soft">Plugins: {mods?.plugins?.length ?? 0}</Chip>
              <Chip variant="soft">Total: {allEntries.length}</Chip>
              <Chip variant="soft">
                Last updated: {lastUpdated ? formatDate(lastUpdated) : "—"}
              </Chip>
            </Card.Content>
            <Card.Footer className="flex flex-wrap items-center gap-3">
              <Button onPress={() => setShowUpload(true)} onMouseEnter={() => play("hover")}>
                <Upload size={16} />
                Add mod
              </Button>
              <div className="flex items-center gap-2">
                <Search size={16} className="text-[var(--muted)]" />
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
                <Filter size={16} className="text-[var(--muted)]" />
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
                <SlidersHorizontal size={16} className="text-[var(--muted)]" />
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
          {showMods && (
            <motion.div variants={cardMotion}>
              <Disclosure isExpanded={modsExpanded} onExpandedChange={setModsExpanded}>
                <Disclosure.Heading>
                  <Button slot="trigger" variant="secondary">
                    Mods ({filteredMods.length})
                    <Disclosure.Indicator />
                  </Button>
                </Disclosure.Heading>
                <Disclosure.Content>
                  <Disclosure.Body className="mt-4 grid gap-3 md:grid-cols-2">
                    {pagedMods.length ? (
                      pagedMods.map((item, index) => (
                        <motion.div
                          key={item.filename}
                          variants={cardMotion}
                          custom={index}
                        >
                          <Card className="p-4 text-sm">
                            <Card.Header className="flex items-center justify-between gap-3">
                              <div className="font-semibold text-[var(--foreground)]">
                                {item.name}
                              </div>
                              <Chip variant="soft">{loaderBadge(item.loader)}</Chip>
                            </Card.Header>
                            <Card.Content className="mt-2 flex items-center justify-between gap-2 text-xs text-[var(--muted)]">
                              <span className="truncate">{item.filename}</span>
                              <Button
                                size="sm"
                                variant="ghost"
                                onPress={() => copyFilename(item.filename)}
                                onMouseEnter={() => play("hover")}
                              >
                                <Copy size={12} />
                                {copied === item.filename ? "Copied" : "Copy"}
                              </Button>
                            </Card.Content>
                            <Card.Footer className="mt-3 flex flex-wrap gap-2 text-xs text-[var(--muted)]">
                              <span>Size: {formatBytes(item.sizeBytes)}</span>
                              <span>Updated: {formatDate(item.updatedAt)}</span>
                            </Card.Footer>
                          </Card>
                        </motion.div>
                      ))
                    ) : (
                      <span className="text-sm text-[var(--muted)]">None</span>
                    )}
                  </Disclosure.Body>
                </Disclosure.Content>
              </Disclosure>
              {filteredMods.length > pageSize && (
                <Button
                  className="mt-4 w-fit"
                  onPress={() => {
                    play("click_confirm");
                    setPageSize(pageSize + 24);
                  }}
                  onMouseEnter={() => play("hover")}
                >
                  Show more mods
                </Button>
              )}
            </motion.div>
          )}

          {showPlugins && (
            <motion.div variants={cardMotion}>
              <Disclosure isExpanded={pluginsExpanded} onExpandedChange={setPluginsExpanded}>
                <Disclosure.Heading>
                  <Button slot="trigger" variant="secondary">
                    Plugins ({filteredPlugins.length})
                    <Disclosure.Indicator />
                  </Button>
                </Disclosure.Heading>
                <Disclosure.Content>
                  <Disclosure.Body className="mt-4 grid gap-3 md:grid-cols-2">
                    {pagedPlugins.length ? (
                      pagedPlugins.map((item, index) => (
                        <motion.div
                          key={item.filename}
                          variants={cardMotion}
                          custom={index}
                        >
                          <Card className="p-4 text-sm">
                            <Card.Header className="flex items-center justify-between gap-3">
                              <div className="font-semibold text-[var(--foreground)]">
                                {item.name}
                              </div>
                              <Chip variant="soft">{loaderBadge(item.loader)}</Chip>
                            </Card.Header>
                            <Card.Content className="mt-2 flex items-center justify-between gap-2 text-xs text-[var(--muted)]">
                              <span className="truncate">{item.filename}</span>
                              <Button
                                size="sm"
                                variant="ghost"
                                onPress={() => copyFilename(item.filename)}
                                onMouseEnter={() => play("hover")}
                              >
                                <Copy size={12} />
                                {copied === item.filename ? "Copied" : "Copy"}
                              </Button>
                            </Card.Content>
                            <Card.Footer className="mt-3 flex flex-wrap gap-2 text-xs text-[var(--muted)]">
                              <span>Size: {formatBytes(item.sizeBytes)}</span>
                              <span>Updated: {formatDate(item.updatedAt)}</span>
                            </Card.Footer>
                          </Card>
                        </motion.div>
                      ))
                    ) : (
                      <span className="text-sm text-[var(--muted)]">None</span>
                    )}
                  </Disclosure.Body>
                </Disclosure.Content>
              </Disclosure>
              {filteredPlugins.length > pageSize && (
                <Button
                  className="mt-4 w-fit"
                  onPress={() => {
                    play("click_confirm");
                    setPageSize(pageSize + 24);
                  }}
                  onMouseEnter={() => play("hover")}
                >
                  Show more plugins
                </Button>
              )}
            </motion.div>
          )}
        </motion.section>
      </motion.main>

      <Modal>
        <Modal.Backdrop
          isOpen={showUpload}
          onOpenChange={setShowUpload}
          variant="blur"
        >
          <Modal.Container>
            <Modal.Dialog className="sm:max-w-[640px]">
              <Modal.Header className="flex items-center justify-between">
                <div className="font-pixel text-xs tracking-wide text-[var(--accent)]">
                  Add Mods
                </div>
                <Button
                  variant="tertiary"
                  onPress={() => setShowUpload(false)}
                  onMouseEnter={() => play("hover")}
                >
                  <X size={14} />
                  Close
                </Button>
              </Modal.Header>
              <Modal.Body className="grid gap-4 text-sm">
                <Card className="rounded-xl p-4">
                  <Card.Header className="flex items-center gap-2 text-xs text-[var(--muted)]">
                    <Upload size={14} />
                    Upload a mod (.jar/.zip)
                  </Card.Header>
                  <Card.Content className="mt-3 grid gap-3">
                    <Select
                      className="w-40 text-xs"
                      placeholder="Target"
                      value={target}
                      onChange={(value) => setTarget(value as "mods" | "plugins")}
                    >
                      <Label className="sr-only">Target</Label>
                      <Select.Trigger>
                        <Select.Value />
                        <Select.Indicator />
                      </Select.Trigger>
                      <Select.Popover>
                        <ListBox>
                          <ListBox.Item id="mods">mods</ListBox.Item>
                          <ListBox.Item id="plugins">plugins</ListBox.Item>
                        </ListBox>
                      </Select.Popover>
                    </Select>
                    <div className="flex flex-wrap items-center gap-3">
                      <input
                        type="file"
                        accept=".jar,.zip"
                        onChange={(event) => setUploadFile(event.target.files?.[0] ?? null)}
                      />
                      <Button
                        onPress={handleUpload}
                        isDisabled={busy}
                        onMouseEnter={() => play("hover")}
                      >
                        Upload
                      </Button>
                    </div>
                    {uploadFile && (
                      <div className="text-xs text-[var(--muted)]">
                        Selected: {uploadFile.name}
                      </div>
                    )}
                  </Card.Content>
                </Card>

                <Card className="rounded-xl p-4">
                  <Card.Header className="flex items-center gap-2 text-xs text-[var(--muted)]">
                    <Download size={14} />
                    Download from URL
                  </Card.Header>
                  <Card.Content className="mt-3 grid gap-3">
                    <Select
                      className="w-40 text-xs"
                      placeholder="Target"
                      value={target}
                      onChange={(value) => setTarget(value as "mods" | "plugins")}
                    >
                      <Label className="sr-only">Target</Label>
                      <Select.Trigger>
                        <Select.Value />
                        <Select.Indicator />
                      </Select.Trigger>
                      <Select.Popover>
                        <ListBox>
                          <ListBox.Item id="mods">mods</ListBox.Item>
                          <ListBox.Item id="plugins">plugins</ListBox.Item>
                        </ListBox>
                      </Select.Popover>
                    </Select>
                    <TextField>
                      <Label className="sr-only">Download URL</Label>
                      <Input
                        placeholder="https://example.com/mod.jar"
                        value={downloadUrl}
                        onChange={(event) => setDownloadUrl(event.target.value)}
                      />
                    </TextField>
                    <TextField>
                      <Label className="sr-only">Filename</Label>
                      <Input
                        placeholder="Optional filename (mod.jar)"
                        value={downloadName}
                        onChange={(event) => setDownloadName(event.target.value)}
                      />
                    </TextField>
                    <Button
                      onPress={handleDownload}
                      isDisabled={busy}
                      onMouseEnter={() => play("hover")}
                    >
                      Download
                    </Button>
                  </Card.Content>
                </Card>
              </Modal.Body>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </div>
  );
}
