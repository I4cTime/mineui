"use client";

// Choosing a modpack for a new container (contract §3.13, §3.14).
// Modrinth: search in place and pick. CurseForge: its search needs a
// personal API key, so the pack is named by its page address or slug — or
// handed over as the zip the CurseForge app exports (2.8.0).
import { useEffect, useRef, useState } from "react";
import { Download, FileArchive, Loader2, Search, X } from "lucide-react";
import { Button, Chip, Description, Input, Label, ScrollShadow, Tabs, TextField } from "@heroui/react";
import { useUISound } from "@/app/hooks/useUISound";
import { pickModpackZip } from "@/app/lib/dialog";
import {
  inspectModpackZip,
  searchModpacks,
  IpcError,
  type ModpackHit,
  type ModpackSource,
  type ModpackZipInfo,
} from "@/app/lib/ipc";

const SEARCH_DEBOUNCE_MS = 350;

const LOADER_NAMES: Record<string, string> = {
  forge: "Forge",
  neoforge: "NeoForge",
  fabric: "Fabric",
  quilt: "Quilt",
};

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

/** What the picker hands back: enough to create the container. */
export type ModpackChoice = {
  source: ModpackSource;
  /** Slug (Modrinth pick), whatever the user typed (CurseForge), or the
   *  zip's host path (CurseForge export). */
  project: string;
  /** Versions the pack is known to support, newest first; empty = unknown. */
  gameVersions: string[];
  title: string;
};

interface ModpackPickerProps {
  value: ModpackChoice | null;
  onChange: (choice: ModpackChoice | null) => void;
  isDisabled?: boolean;
}

function PackIcon({ hit }: { hit: ModpackHit }) {
  // Icons come from Modrinth's CDN (allowed for images in the app's CSP).
  return hit.iconUrl ? (
    // eslint-disable-next-line @next/next/no-img-element -- static export: next/image has no optimizer, and this is a remote 96px icon
    <img
      src={hit.iconUrl}
      alt=""
      width={40}
      height={40}
      loading="lazy"
      className="size-10 shrink-0 rounded-md border border-border object-cover"
    />
  ) : (
    <span className="flex size-10 shrink-0 items-center justify-center rounded-md border border-border text-muted">
      <Download size={16} />
    </span>
  );
}

export default function ModpackPicker({ value, onChange, isDisabled = false }: ModpackPickerProps) {
  const { play } = useUISound();
  const [source, setSource] = useState<ModpackSource>(value?.source ?? "modrinth");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<ModpackHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cfInput, setCfInput] = useState(value?.source === "curseforge" ? value.project : "");
  const [zipPath, setZipPath] = useState<string | null>(
    value?.source === "curseforge-zip" ? value.project : null,
  );
  const [zipInfo, setZipInfo] = useState<ModpackZipInfo | null>(null);
  const [zipError, setZipError] = useState<string | null>(null);
  const [inspecting, setInspecting] = useState(false);
  // Only the newest search may land — typing fast must not show stale hits.
  const searchId = useRef(0);

  useEffect(() => {
    if (source !== "modrinth") return;
    const mySearch = ++searchId.current;
    const timer = setTimeout(
      () => {
        setSearching(true);
        searchModpacks(query)
          .then((result) => {
            if (searchId.current !== mySearch) return;
            setHits(result);
            setError(null);
          })
          .catch((err: unknown) => {
            if (searchId.current !== mySearch) return;
            setHits([]);
            setError(err instanceof IpcError ? err.message : "Could not search Modrinth.");
          })
          .finally(() => {
            if (searchId.current === mySearch) setSearching(false);
          });
      },
      // The first, empty search (most downloaded) need not wait.
      hits === null ? 0 : SEARCH_DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
    // `hits` is read only to skip the debounce once; it must not re-trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, source]);

  const pick = (hit: ModpackHit) => {
    play("click_confirm");
    onChange({
      source: "modrinth",
      project: hit.slug,
      gameVersions: [...hit.gameVersions].reverse(),
      title: hit.title,
    });
  };

  const changeCurseforge = (text: string) => {
    setCfInput(text);
    const project = text.trim();
    onChange(
      project
        ? { source: "curseforge", project, gameVersions: [], title: project }
        : null,
    );
  };

  const chooseZip = async () => {
    play("click_confirm");
    let path: string | null = null;
    try {
      path = await pickModpackZip();
    } catch (err: unknown) {
      play("error");
      setZipError(err instanceof IpcError ? err.message : "Could not open the file picker.");
      return;
    }
    if (path === null) return;
    setInspecting(true);
    setZipError(null);
    try {
      const info = await inspectModpackZip(path);
      setZipPath(path);
      setZipInfo(info);
      play("success");
      onChange({
        source: "curseforge-zip",
        project: path,
        gameVersions: [info.mcVersion],
        title: info.name,
      });
    } catch (err: unknown) {
      play("error");
      setZipPath(null);
      setZipInfo(null);
      setZipError(err instanceof IpcError ? err.message : "Could not read the zip.");
      onChange(null);
    } finally {
      setInspecting(false);
    }
  };

  const picked = value?.source === "modrinth" ? value : null;

  return (
    <Tabs
      selectedKey={source}
      onSelectionChange={(key) => {
        if (isDisabled) return;
        setSource(key as ModpackSource);
        onChange(null);
        setCfInput("");
        setZipPath(null);
        setZipInfo(null);
        setZipError(null);
      }}
    >
      <Tabs.ListContainer>
        <Tabs.List aria-label="Where the modpack is published">
          <Tabs.Tab id="modrinth" isDisabled={isDisabled}>
            Modrinth
            <Tabs.Indicator />
          </Tabs.Tab>
          <Tabs.Tab id="curseforge" isDisabled={isDisabled}>
            CurseForge
            <Tabs.Indicator />
          </Tabs.Tab>
          <Tabs.Tab id="curseforge-zip" isDisabled={isDisabled}>
            CurseForge zip
            <Tabs.Indicator />
          </Tabs.Tab>
        </Tabs.List>
      </Tabs.ListContainer>

      <Tabs.Panel id="modrinth" className="grid gap-3 pt-4">
        {picked ? (
          <div
            className="flex items-center justify-between gap-3 rounded-lg border border-accent p-3"
            style={{ background: "color-mix(in oklab, var(--accent) 8%, transparent)" }}
          >
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-semibold">{picked.title}</span>
              <span className="truncate font-mono text-xs text-muted">{picked.project}</span>
            </div>
            <Button
              size="sm"
              variant="ghost"
              isDisabled={isDisabled}
              onPress={() => {
                play("click_back");
                onChange(null);
              }}
              onMouseEnter={() => play("hover")}
            >
              <X size={14} />
              Change
            </Button>
          </div>
        ) : (
          <>
            <TextField
              className="flex flex-col gap-2"
              value={query}
              onChange={setQuery}
              isDisabled={isDisabled}
            >
              <Label>Search Modrinth modpacks</Label>
              <div className="relative">
                <Search
                  size={14}
                  className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted"
                />
                <Input className="w-full pl-9" placeholder="Cobblemon, All of Fabric, Create…" />
                {searching && (
                  <Loader2
                    size={14}
                    className="absolute top-1/2 right-3 -translate-y-1/2 animate-spin text-muted"
                  />
                )}
              </div>
              <Description>
                Only packs that can run on a server are listed.{" "}
                {query.trim() === "" ? "Showing the most downloaded." : ""}
              </Description>
            </TextField>

            {error && (
              <p role="alert" className="text-xs text-danger">
                {error}
              </p>
            )}
            {hits !== null && hits.length === 0 && !error && !searching && (
              <p className="text-xs text-muted">
                No server-capable modpack matches &ldquo;{query.trim()}&rdquo;.
              </p>
            )}

            {hits !== null && hits.length > 0 && (
              <ScrollShadow
                className="max-h-72 overflow-y-auto rounded-lg border border-border"
                aria-label="Modpack search results"
              >
                <ul className="divide-y divide-border">
                  {hits.map((hit) => (
                    <li key={hit.id}>
                      <button
                        type="button"
                        disabled={isDisabled}
                        onClick={() => pick(hit)}
                        onMouseEnter={() => play("hover")}
                        className="flex w-full items-start gap-3 p-3 text-left hover:bg-default focus-visible:outline-2 focus-visible:-outline-offset-2 disabled:opacity-60"
                        style={{ outlineColor: "var(--focus)" }}
                      >
                        <PackIcon hit={hit} />
                        <span className="flex min-w-0 flex-1 flex-col gap-1">
                          <span className="flex flex-wrap items-baseline gap-x-2">
                            <span className="text-sm font-semibold">{hit.title}</span>
                            <span className="text-xs text-muted">by {hit.author}</span>
                          </span>
                          <span className="line-clamp-2 text-xs text-muted">{hit.description}</span>
                          <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
                            {hit.loaders.map((loader) => (
                              <Chip key={loader} size="sm" variant="soft">
                                {LOADER_NAMES[loader] ?? loader}
                              </Chip>
                            ))}
                            <span className="font-pixel-num">{compact.format(hit.downloads)}</span>
                            <span>downloads</span>
                            {hit.gameVersions.length > 0 && (
                              <span>
                                · up to{" "}
                                <span className="font-pixel-num">
                                  {hit.gameVersions[hit.gameVersions.length - 1]}
                                </span>
                              </span>
                            )}
                          </span>
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </ScrollShadow>
            )}
          </>
        )}
      </Tabs.Panel>

      <Tabs.Panel id="curseforge" className="grid gap-3 pt-4">
        <TextField
          className="flex flex-col gap-2"
          value={cfInput}
          onChange={changeCurseforge}
          isDisabled={isDisabled}
        >
          <Label>Modpack page address or slug</Label>
          <Input
            className="font-mono"
            placeholder="https://www.curseforge.com/minecraft/modpacks/all-the-mods-10"
          />
          <Description>
            Copy the address of the pack&apos;s page on CurseForge. No API key is
            needed. A few CurseForge mods forbid automatic download — if the
            server log names one, that file has to be added by hand.
          </Description>
        </TextField>
      </Tabs.Panel>

      <Tabs.Panel id="curseforge-zip" className="grid gap-3 pt-4">
        {zipInfo && zipPath ? (
          <div
            className="flex items-center justify-between gap-3 rounded-lg border border-accent p-3"
            style={{ background: "color-mix(in oklab, var(--accent) 8%, transparent)" }}
          >
            <div className="flex min-w-0 flex-col gap-1">
              <span className="truncate text-sm font-semibold">{zipInfo.name}</span>
              <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
                {zipInfo.loader && (
                  <Chip size="sm" variant="soft">
                    {LOADER_NAMES[zipInfo.loader] ?? zipInfo.loader}
                    {zipInfo.loaderVersion ? ` ${zipInfo.loaderVersion}` : ""}
                  </Chip>
                )}
                <span>
                  Minecraft <span className="font-pixel-num">{zipInfo.mcVersion}</span>
                </span>
                <span>
                  · <span className="font-pixel-num">{zipInfo.files}</span> mods to download
                </span>
                {zipInfo.hasOverrides && <span>· configs included</span>}
              </span>
              <span className="truncate font-mono text-xs text-muted" title={zipPath}>
                {zipPath}
              </span>
            </div>
            <Button
              size="sm"
              variant="ghost"
              isDisabled={isDisabled}
              onPress={() => {
                play("click_back");
                setZipPath(null);
                setZipInfo(null);
                onChange(null);
              }}
              onMouseEnter={() => play("hover")}
            >
              <X size={14} />
              Change
            </Button>
          </div>
        ) : (
          <div className="grid gap-2">
            <Button
              variant="secondary"
              isDisabled={isDisabled || inspecting}
              onPress={chooseZip}
              onMouseEnter={() => play("hover")}
            >
              {inspecting ? <Loader2 size={14} className="animate-spin" /> : <FileArchive size={14} />}
              Choose the exported zip…
            </Button>
            <span className="text-xs text-muted">
              The zip the CurseForge app makes with <em>Export profile</em>: a
              manifest.json next to an overrides folder. MineUI reads the pack&apos;s
              name and Minecraft version from it; the server downloads the listed
              mods on first start. Packs for Minecraft 1.16 and older cannot be used
              this way.
            </span>
            {zipError && (
              <p role="alert" className="text-xs text-danger">
                {zipError}
              </p>
            )}
          </div>
        )}
      </Tabs.Panel>
    </Tabs>
  );
}
