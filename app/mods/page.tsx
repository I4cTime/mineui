"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  Boxes,
  Copy,
  Filter,
  Search,
  SlidersHorizontal,
  Sparkles,
} from "lucide-react";

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

export default function ModsPage() {
  const [mods, setMods] = useState<ModsResponse | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "mods" | "plugins">("all");
  const [sort, setSort] = useState<
    "name-asc" | "name-desc" | "size-desc" | "updated-desc"
  >("name-asc");
  const [copied, setCopied] = useState<string | null>(null);
  const [pageSize, setPageSize] = useState(24);

  useEffect(() => {
    fetchJson<ModsResponse>("/api/mods").then(setMods).catch(() => {
      setMods({ mods: [], plugins: [] });
    });
  }, []);

  const normalize = (value: string) => value.toLowerCase().trim();
  const matchesQuery = (entry: ModEntry) => {
    const needle = normalize(query);
    if (!needle) return true;
    return (
      normalize(entry.name).includes(needle) ||
      normalize(entry.filename).includes(needle)
    );
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
      case "name-asc":
      default:
        return next.sort((a, b) => a.name.localeCompare(b.name));
    }
  };

  const filteredMods = useMemo(() => {
    const list = mods?.mods ?? [];
    return sortEntries(list.filter(matchesQuery));
  }, [mods, query, sort]);

  const filteredPlugins = useMemo(() => {
    const list = mods?.plugins ?? [];
    return sortEntries(list.filter(matchesQuery));
  }, [mods, query, sort]);

  const allEntries = useMemo(() => {
    return [...filteredMods, ...filteredPlugins];
  }, [filteredMods, filteredPlugins]);

  const pagedMods = useMemo(() => {
    return filteredMods.slice(0, pageSize);
  }, [filteredMods, pageSize]);

  const pagedPlugins = useMemo(() => {
    return filteredPlugins.slice(0, pageSize);
  }, [filteredPlugins, pageSize]);

  const lastUpdated = useMemo(() => {
    const all = [...(mods?.mods ?? []), ...(mods?.plugins ?? [])];
    if (!all.length) return null;
    const latest = all.reduce((acc, entry) =>
      entry.updatedAt > acc.updatedAt ? entry : acc,
    );
    return latest.updatedAt;
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
    const date = new Date(value * 1000);
    return date.toLocaleString();
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

  const showMods = filter === "all" || filter === "mods";
  const showPlugins = filter === "all" || filter === "plugins";

  const loaderClass = (loader: ModEntry["loader"]) => {
    switch (loader) {
      case "neoforge":
        return "border-emerald-500/60 text-emerald-200";
      case "forge":
        return "border-amber-400/60 text-amber-200";
      case "fabric":
        return "border-sky-400/60 text-sky-200";
      default:
        return "border-emerald-900/60 text-emerald-200/70";
    }
  };

  const copyFilename = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(value);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      setCopied(null);
    }
  };

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,_rgba(29,68,38,0.55),_transparent_60%)] mc-grid">
      <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 px-6 py-10">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Boxes size={20} className="text-emerald-200" />
            <h1 className="mc-title mc-glow">Mods & Plugins</h1>
          </div>
          <Link className="mc-button" href="/">
            <ArrowLeft size={16} />
            Back to dashboard
          </Link>
        </header>

        <section className="mc-panel flex flex-wrap items-center justify-between gap-4 p-5">
          <div className="flex flex-wrap items-center gap-3 text-sm text-emerald-200/80">
            <span className="mc-chip flex items-center gap-2">
              <Sparkles size={14} />
              Curated view
            </span>
            <span className="mc-chip">Mods: {mods?.mods?.length ?? 0}</span>
            <span className="mc-chip">Plugins: {mods?.plugins?.length ?? 0}</span>
            <span className="mc-chip">Total: {allEntries.length}</span>
            <span className="mc-chip">
              Last updated: {lastUpdated ? formatDate(lastUpdated) : "—"}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2 rounded-lg border border-emerald-900/60 bg-black/40 px-3 py-2 text-sm text-emerald-100">
              <Search size={16} />
              <input
                className="bg-transparent outline-none placeholder:text-emerald-200/50"
                placeholder="Search mods or files"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <div className="flex items-center gap-2 text-sm text-emerald-100">
              <Filter size={16} />
              <select
                className="rounded-lg border border-emerald-900/60 bg-black/60 px-2 py-1 text-sm"
                value={filter}
                onChange={(event) =>
                  setFilter(event.target.value as typeof filter)
                }
              >
                <option value="all">All</option>
                <option value="mods">Mods</option>
                <option value="plugins">Plugins</option>
              </select>
            </div>
            <div className="flex items-center gap-2 text-sm text-emerald-100">
              <SlidersHorizontal size={16} />
              <select
                className="rounded-lg border border-emerald-900/60 bg-black/60 px-2 py-1 text-sm"
                value={sort}
                onChange={(event) =>
                  setSort(event.target.value as typeof sort)
                }
              >
                <option value="name-asc">Name (A-Z)</option>
                <option value="name-desc">Name (Z-A)</option>
                <option value="size-desc">Size (Largest)</option>
                <option value="updated-desc">Recently Updated</option>
              </select>
            </div>
          </div>
        </section>

        <section className="grid gap-6">
          {showMods && (
            <details className="mc-panel p-5" open>
              <summary className="flex cursor-pointer items-center justify-between text-sm uppercase tracking-[0.25em] text-emerald-200/70">
                Mods ({filteredMods.length})
              </summary>
              <div className="mt-4 grid gap-3 md:grid-cols-2">
                {pagedMods.length ? (
                  pagedMods.map((item) => (
                    <div
                      key={item.filename}
                      className="rounded-xl border border-emerald-900/60 bg-black/50 p-4 text-sm text-emerald-100/90 transition hover:border-emerald-500/60"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="font-semibold">{item.name}</div>
                        <span className={`mc-chip ${loaderClass(item.loader)}`}>
                          {loaderBadge(item.loader)}
                        </span>
                      </div>
                      <div className="mt-2 flex items-center justify-between gap-2 text-xs text-emerald-200/70">
                        <span>{item.filename}</span>
                        <button
                          className="mc-button px-2 py-1 text-xs"
                          onClick={() => copyFilename(item.filename)}
                          title="Copy filename"
                        >
                          <Copy size={12} />
                          {copied === item.filename ? "Copied" : "Copy"}
                        </button>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2 text-xs text-emerald-200/70">
                        <span>Size: {formatBytes(item.sizeBytes)}</span>
                        <span>Updated: {formatDate(item.updatedAt)}</span>
                      </div>
                    </div>
                  ))
                ) : (
                  <span className="text-emerald-200/70">None</span>
                )}
                {filteredMods.length > pageSize && (
                  <button
                    className="mc-button w-fit"
                    onClick={() => setPageSize(pageSize + 24)}
                  >
                    Show more mods
                  </button>
                )}
              </div>
            </details>
          )}

          {showPlugins && (
            <details className="mc-panel p-5" open>
              <summary className="flex cursor-pointer items-center justify-between text-sm uppercase tracking-[0.25em] text-emerald-200/70">
                Plugins ({filteredPlugins.length})
              </summary>
              <div className="mt-4 grid gap-3 md:grid-cols-2">
                {pagedPlugins.length ? (
                  pagedPlugins.map((item) => (
                    <div
                      key={item.filename}
                      className="rounded-xl border border-emerald-900/60 bg-black/50 p-4 text-sm text-emerald-100/90 transition hover:border-emerald-500/60"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="font-semibold">{item.name}</div>
                        <span className={`mc-chip ${loaderClass(item.loader)}`}>
                          {loaderBadge(item.loader)}
                        </span>
                      </div>
                      <div className="mt-2 flex items-center justify-between gap-2 text-xs text-emerald-200/70">
                        <span>{item.filename}</span>
                        <button
                          className="mc-button px-2 py-1 text-xs"
                          onClick={() => copyFilename(item.filename)}
                          title="Copy filename"
                        >
                          <Copy size={12} />
                          {copied === item.filename ? "Copied" : "Copy"}
                        </button>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2 text-xs text-emerald-200/70">
                        <span>Size: {formatBytes(item.sizeBytes)}</span>
                        <span>Updated: {formatDate(item.updatedAt)}</span>
                      </div>
                    </div>
                  ))
                ) : (
                  <span className="text-emerald-200/70">None</span>
                )}
                {filteredPlugins.length > pageSize && (
                  <button
                    className="mc-button w-fit"
                    onClick={() => setPageSize(pageSize + 24)}
                  >
                    Show more plugins
                  </button>
                )}
              </div>
            </details>
          )}
        </section>
      </main>
    </div>
  );
}
