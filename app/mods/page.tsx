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
      <div className="min-h-screen mc-grid" style={{ background: "var(--background)" }}>
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
      className="min-h-screen mc-grid"
      style={{ background: `radial-gradient(circle at top, var(--mc-accent-soft), transparent 60%), var(--background)` }}
    >
      <motion.main
        className="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 px-4 py-10 md:px-6"
        initial="hidden"
        animate="show"
        variants={containerMotion}
      >
        <PageHeader title="Mods & Plugins" icon={Boxes} />

        <motion.section className="mc-panel flex flex-wrap items-center justify-between gap-4 p-5" variants={cardMotion}>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="mc-chip flex items-center gap-2">
              <Sparkles size={14} />
              Curated view
            </span>
            <span className="mc-chip">Mods: {mods?.mods?.length ?? 0}</span>
            <span className="mc-chip">Plugins: {mods?.plugins?.length ?? 0}</span>
            <span className="mc-chip">Total: {allEntries.length}</span>
            <span className="mc-chip">Last updated: {lastUpdated ? formatDate(lastUpdated) : "—"}</span>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button
              className="mc-button"
              onClick={() => setShowUpload(true)}
              onMouseEnter={() => play("hover")}
            >
              <Upload size={16} />
              Add mod
            </button>
            <div className="mc-input flex items-center gap-2 pr-2">
              <Search size={16} style={{ color: "var(--mc-muted)" }} />
              <input
                className="bg-transparent outline-none"
                placeholder="Search mods or files"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                style={{ color: "var(--foreground)" }}
              />
            </div>
            <div className="flex items-center gap-2">
              <Filter size={16} style={{ color: "var(--mc-muted)" }} />
              <select
                className="mc-select text-sm"
                value={filter}
                onChange={(event) => setFilter(event.target.value as typeof filter)}
              >
                <option value="all">All</option>
                <option value="mods">Mods</option>
                <option value="plugins">Plugins</option>
              </select>
            </div>
            <div className="flex items-center gap-2">
              <SlidersHorizontal size={16} style={{ color: "var(--mc-muted)" }} />
              <select
                className="mc-select text-sm"
                value={sort}
                onChange={(event) => setSort(event.target.value as typeof sort)}
              >
                <option value="name-asc">Name (A-Z)</option>
                <option value="name-desc">Name (Z-A)</option>
                <option value="size-desc">Size (Largest)</option>
                <option value="updated-desc">Recently Updated</option>
              </select>
            </div>
          </div>
        </motion.section>

        <motion.section className="grid gap-6" variants={containerMotion}>
          {showMods && (
            <motion.details className="mc-panel p-5" open variants={cardMotion}>
              <summary
                className="flex cursor-pointer items-center justify-between font-pixel text-xs tracking-wide"
                style={{ color: "var(--mc-accent)" }}
              >
                Mods ({filteredMods.length})
              </summary>
              <motion.div className="mt-4 grid gap-3 md:grid-cols-2" variants={containerMotion}>
                {pagedMods.length ? (
                  pagedMods.map((item, index) => (
                    <motion.div
                      key={item.filename}
                      className="mc-panel rounded-xl p-4 text-sm"
                      variants={cardMotion}
                      custom={index}
                      whileHover={{ borderColor: "var(--mc-accent)" }}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="font-semibold" style={{ color: "var(--foreground)" }}>
                          {item.name}
                        </div>
                        <span className="mc-chip">{loaderBadge(item.loader)}</span>
                      </div>
                      <div className="mt-2 flex items-center justify-between gap-2 text-xs" style={{ color: "var(--mc-muted)" }}>
                        <span className="truncate">{item.filename}</span>
                        <button
                          className="mc-button px-2 py-1 text-xs"
                          onClick={() => copyFilename(item.filename)}
                          onMouseEnter={() => play("hover")}
                        >
                          <Copy size={12} />
                          {copied === item.filename ? "Copied" : "Copy"}
                        </button>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2 text-xs" style={{ color: "var(--mc-muted)" }}>
                        <span>Size: {formatBytes(item.sizeBytes)}</span>
                        <span>Updated: {formatDate(item.updatedAt)}</span>
                      </div>
                    </motion.div>
                  ))
                ) : (
                  <span style={{ color: "var(--mc-muted)" }}>None</span>
                )}
              </motion.div>
              {filteredMods.length > pageSize && (
                <button
                  className="mc-button mt-4 w-fit"
                  onClick={() => {
                    play("click_confirm");
                    setPageSize(pageSize + 24);
                  }}
                  onMouseEnter={() => play("hover")}
                >
                  Show more mods
                </button>
              )}
            </motion.details>
          )}

          {showPlugins && (
            <motion.details className="mc-panel p-5" open variants={cardMotion}>
              <summary
                className="flex cursor-pointer items-center justify-between font-pixel text-xs tracking-wide"
                style={{ color: "var(--mc-accent)" }}
              >
                Plugins ({filteredPlugins.length})
              </summary>
              <motion.div className="mt-4 grid gap-3 md:grid-cols-2" variants={containerMotion}>
                {pagedPlugins.length ? (
                  pagedPlugins.map((item, index) => (
                    <motion.div
                      key={item.filename}
                      className="mc-panel rounded-xl p-4 text-sm"
                      variants={cardMotion}
                      custom={index}
                      whileHover={{ borderColor: "var(--mc-accent)" }}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="font-semibold" style={{ color: "var(--foreground)" }}>
                          {item.name}
                        </div>
                        <span className="mc-chip">{loaderBadge(item.loader)}</span>
                      </div>
                      <div className="mt-2 flex items-center justify-between gap-2 text-xs" style={{ color: "var(--mc-muted)" }}>
                        <span className="truncate">{item.filename}</span>
                        <button
                          className="mc-button px-2 py-1 text-xs"
                          onClick={() => copyFilename(item.filename)}
                          onMouseEnter={() => play("hover")}
                        >
                          <Copy size={12} />
                          {copied === item.filename ? "Copied" : "Copy"}
                        </button>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2 text-xs" style={{ color: "var(--mc-muted)" }}>
                        <span>Size: {formatBytes(item.sizeBytes)}</span>
                        <span>Updated: {formatDate(item.updatedAt)}</span>
                      </div>
                    </motion.div>
                  ))
                ) : (
                  <span style={{ color: "var(--mc-muted)" }}>None</span>
                )}
              </motion.div>
              {filteredPlugins.length > pageSize && (
                <button
                  className="mc-button mt-4 w-fit"
                  onClick={() => {
                    play("click_confirm");
                    setPageSize(pageSize + 24);
                  }}
                  onMouseEnter={() => play("hover")}
                >
                  Show more plugins
                </button>
              )}
            </motion.details>
          )}
        </motion.section>
      </motion.main>

      {showUpload && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="mc-panel w-full max-w-xl p-6">
            <div className="flex items-center justify-between">
              <div className="font-pixel text-xs tracking-wide" style={{ color: "var(--mc-accent)" }}>
                Add Mods
              </div>
              <button
                className="mc-button"
                onClick={() => setShowUpload(false)}
                onMouseEnter={() => play("hover")}
              >
                <X size={14} />
                Close
              </button>
            </div>
            <div className="mt-4 grid gap-4 text-sm">
              <div className="mc-panel rounded-xl p-4">
                <div className="flex items-center gap-2 text-xs" style={{ color: "var(--mc-muted)" }}>
                  <Upload size={14} />
                  Upload a mod (.jar/.zip)
                </div>
                <div className="mt-3 flex items-center gap-2 text-xs" style={{ color: "var(--mc-muted)" }}>
                  <span>Target:</span>
                  <select
                    className="mc-select text-xs"
                    value={target}
                    onChange={(event) => setTarget(event.target.value as "mods" | "plugins")}
                  >
                    <option value="mods">mods</option>
                    <option value="plugins">plugins</option>
                  </select>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-3">
                  <input
                    type="file"
                    accept=".jar,.zip"
                    onChange={(event) => setUploadFile(event.target.files?.[0] ?? null)}
                  />
                  <button
                    className="mc-button"
                    onClick={handleUpload}
                    disabled={busy}
                    onMouseEnter={() => play("hover")}
                  >
                    Upload
                  </button>
                </div>
                {uploadFile && (
                  <div className="mt-2 text-xs" style={{ color: "var(--mc-muted)" }}>
                    Selected: {uploadFile.name}
                  </div>
                )}
              </div>

              <div className="mc-panel rounded-xl p-4">
                <div className="flex items-center gap-2 text-xs" style={{ color: "var(--mc-muted)" }}>
                  <Download size={14} />
                  Download from URL
                </div>
                <div className="mt-3 flex items-center gap-2 text-xs" style={{ color: "var(--mc-muted)" }}>
                  <span>Target:</span>
                  <select
                    className="mc-select text-xs"
                    value={target}
                    onChange={(event) => setTarget(event.target.value as "mods" | "plugins")}
                  >
                    <option value="mods">mods</option>
                    <option value="plugins">plugins</option>
                  </select>
                </div>
                <div className="mt-3 grid gap-2">
                  <input
                    className="mc-input"
                    placeholder="https://example.com/mod.jar"
                    value={downloadUrl}
                    onChange={(event) => setDownloadUrl(event.target.value)}
                  />
                  <input
                    className="mc-input"
                    placeholder="Optional filename (mod.jar)"
                    value={downloadName}
                    onChange={(event) => setDownloadName(event.target.value)}
                  />
                  <button
                    className="mc-button w-fit"
                    onClick={handleDownload}
                    disabled={busy}
                    onMouseEnter={() => play("hover")}
                  >
                    Download
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
