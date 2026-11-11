"use client";

// Add a mod or plugin > Find. Searches Modrinth for what this server can
// load and installs it with the other mods it needs. IPC: get_mod_support /
// search_mods / install_mod (contract §3.5a). Nothing here picks a file or a
// folder: the backend decides both and checks every file against Modrinth's
// published hash.
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Blocks, CheckCircle2, Download, SearchX, WifiOff } from "lucide-react";
import { Avatar, Button, Input, Label, ProgressBar, Skeleton, TextField, toast } from "@heroui/react";
import { EmptyState, TextShimmer } from "@heroui-pro/react";
import OutLink from "@/app/components/OutLink";
import PressRipple from "@/app/components/PressRipple";
import Term from "@/app/components/Term";
import { useUISound } from "@/app/hooks/useUISound";
import { formatBytes } from "@/app/lib/format";
import {
  IpcError,
  installMod,
  onDownloadProgress,
  searchMods,
  type DownloadProgressEvent,
  type ModInstall,
  type ModSearchHit,
  type ModSupport,
} from "@/app/lib/ipc";

const PAGE = 20;
const DEBOUNCE_MS = 350;

/** 10988768 -> "11M", with only the digits in the pixel numeral font. */
function Downloads({ value }: { value: number }) {
  const parts = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).formatToParts(value);
  return (
    <span className="whitespace-nowrap">
      {parts.map((part, i) =>
        part.type === "integer" || part.type === "fraction" || part.type === "decimal" ? (
          <span key={i} className="font-pixel-num">
            {part.value}
          </span>
        ) : (
          <span key={i}>{part.value}</span>
        ),
      )}{" "}
      downloads
    </span>
  );
}

interface FindModsProps {
  support: ModSupport | null;
  /** "Fabric 1.21.1": what the results are matched to. */
  matching: string;
  /** The server is running, so a new file waits for a restart. */
  running: boolean;
  /** This server runs On this computer. */
  onThisComputer: boolean;
  /** One install at a time; also keeps the dialog from closing. */
  busy: boolean;
  setBusy: (busy: boolean) => void;
  /** A file landed on the server. */
  onInstalled: () => void;
}

export default function FindMods({
  support,
  matching,
  running,
  onThisComputer,
  busy,
  setBusy,
  onInstalled,
}: FindModsProps) {
  const { play } = useUISound();
  const noun = support?.target === "plugins" ? "plugin" : "mod";

  const [query, setQuery] = useState("");
  const [term, setTerm] = useState(""); // what the shown results are for
  const [hits, setHits] = useState<ModSearchHit[]>([]);
  const [page, setPage] = useState<{ offset: number; limit: number; total: number; last: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [searchError, setSearchError] = useState<{ message: string; retry: boolean } | null>(null);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [progress, setProgress] = useState<DownloadProgressEvent | null>(null);
  const [fileNo, setFileNo] = useState(0);
  const [installError, setInstallError] = useState<string | null>(null);
  const [done, setDone] = useState<{ title: string; extras: string[] } | null>(null);
  const [doneIds, setDoneIds] = useState<Set<string>>(new Set());
  const seq = useRef(0);
  const titleRefs = useRef(new Map<string, HTMLElement>());

  const supported = support?.supported === true;

  const run = useCallback(async (q: string) => {
    const mine = ++seq.current;
    setLoading(true);
    setSearchError(null);
    try {
      const res = await searchMods(q, 0, PAGE);
      if (mine !== seq.current) return;
      setHits(res.hits);
      setTerm(q);
      setPage({ offset: res.offset, limit: res.limit, total: res.totalHits, last: res.hits.length });
    } catch (err) {
      if (mine !== seq.current) return;
      const wrong = err instanceof IpcError && err.code === "WRONG_MODE";
      setHits([]);
      setPage(null);
      setSearchError({
        message:
          err instanceof IpcError
            ? err.message
            : "MineUI could not reach Modrinth. Check your internet and try again.",
        retry: !wrong,
      });
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, []);

  // Most downloaded first; then a pause after the last keystroke.
  const first = useRef(true);
  useEffect(() => {
    if (!supported) return;
    if (first.current) {
      first.current = false;
      void run("");
      return;
    }
    const id = setTimeout(() => void run(query.trim()), DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [query, supported, run]);

  const showMore = async () => {
    if (!page || loadingMore) return;
    play("click_confirm");
    const mine = seq.current;
    setLoadingMore(true);
    try {
      const res = await searchMods(term, page.offset + page.limit, PAGE);
      if (mine !== seq.current) return;
      setHits((list) => [...list, ...res.hits.filter((h) => !list.some((l) => l.projectId === h.projectId))]);
      setPage({ offset: res.offset, limit: res.limit, total: res.totalHits, last: res.hits.length });
    } catch (err) {
      play("error");
      setInstallError(err instanceof IpcError ? err.message : "More results could not be loaded.");
    } finally {
      setLoadingMore(false);
    }
  };

  const install = async (hit: ModSearchHit) => {
    if (busy) return;
    play("click_confirm");
    setBusy(true);
    setInstallingId(hit.projectId);
    setInstallError(null);
    setDone(null);
    setProgress(null);
    setFileNo(0);
    const seen = new Set<string>();
    const unlisten = await onDownloadProgress((event) => {
      if (event.kind !== "mod") return;
      if (!seen.has(event.downloadId)) {
        seen.add(event.downloadId);
        setFileNo(seen.size);
      }
      setProgress(event);
    });
    try {
      const result: ModInstall = await installMod(hit.projectId);
      const extras = result.installed.filter((f) => f.dependency).map((f) => f.title);
      play("success");
      toast.success(`Installed ${hit.title}`, {
        description: extras.length > 0 ? `Also added: ${extras.join(", ")}` : undefined,
      });
      setDone({ title: hit.title, extras });
      setDoneIds((ids) => new Set(ids).add(hit.projectId));
      onInstalled();
      // The button is gone now: keep keyboard focus on this result.
      requestAnimationFrame(() => titleRefs.current.get(hit.projectId)?.focus());
    } catch (err) {
      play("error");
      setInstallError(
        err instanceof IpcError && err.code === "CHECKSUM_MISMATCH"
          ? `The file for ${hit.title} did not match what Modrinth published, so nothing was installed. Try again in a moment.`
          : err instanceof IpcError
            ? err.message
            : `${hit.title} could not be installed.`,
      );
    } finally {
      unlisten();
      setProgress(null);
      setInstallingId(null);
      setBusy(false);
    }
  };

  if (support === null) {
    return <ResultSkeletons />;
  }

  if (!supported) {
    return (
      <div data-testid="find-unsupported">
        <EmptyState>
          <EmptyState.Header>
            <EmptyState.Media variant="icon">
              <Blocks />
            </EmptyState.Media>
            <EmptyState.Title>This server cannot load {noun === "plugin" ? "plugins" : "mods"}</EmptyState.Title>
            <EmptyState.Description>{support.reason ?? "Find is not available for this server."}</EmptyState.Description>
          </EmptyState.Header>
          <EmptyState.Content>
            {onThisComputer && (
              <p className="max-w-sm text-xs text-muted">
                MineUI can run a server that loads <Term term="mod">mods</Term> In a container. Open App Settings,
                then Servers, and add a server. You can still add a file you already have from the other tab.
              </p>
            )}
          </EmptyState.Content>
        </EmptyState>
      </div>
    );
  }

  const pending = installingId !== null;
  const hasMore = page !== null && page.offset + page.limit < page.total;
  const word = support.target === "plugins" ? "plugins" : "mods";

  return (
    <div className="flex flex-col gap-3" data-testid="find-panel">
      <TextField
        className="flex flex-col gap-1.5"
        value={query}
        onChange={(value: string) => {
          setQuery(value);
          setInstallError(null);
        }}
      >
        <Label className="sr-only">Search {word}</Label>
        <Input
          type="search"
          placeholder={`Search ${word}, like "map" or "backpack"`}
          autoFocus
          onKeyDown={(event) => {
            if (event.key === "Enter") void run(query.trim());
          }}
        />
      </TextField>

      <p className="text-xs text-muted" data-testid="find-matching">
        Showing {word} for {matching}
        {term === "" ? ", the most downloaded first." : "."}
      </p>

      {installError && (
        <p role="alert" className="flex items-start gap-2 rounded-lg border border-danger p-3 text-xs text-danger">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>{installError}</span>
        </p>
      )}

      {done && (
        <p role="status" className="flex items-start gap-2 rounded-lg border border-success p-3 text-xs">
          <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-success" />
          <span>
            <span className="font-semibold">{done.title}</span> is on the server.
            {done.extras.length > 0 && <> Also added: {done.extras.join(", ")}.</>}{" "}
            {running
              ? "It starts working after the server restarts. Close this and press Restart server on the Mods page."
              : "It starts working the next time the server starts."}
          </span>
        </p>
      )}

      {loading ? (
        <ResultSkeletons />
      ) : searchError ? (
        <EmptyState>
          <EmptyState.Header>
            <EmptyState.Media variant="icon">
              <WifiOff />
            </EmptyState.Media>
            <EmptyState.Title>Could not load {word}</EmptyState.Title>
            <EmptyState.Description>{searchError.message}</EmptyState.Description>
          </EmptyState.Header>
          {searchError.retry && (
            <EmptyState.Content>
              <Button
                variant="secondary"
                onPress={() => {
                  play("click_confirm");
                  void run(query.trim());
                }}
                onMouseEnter={() => play("hover")}
              >
                Try again
              </Button>
            </EmptyState.Content>
          )}
        </EmptyState>
      ) : hits.length === 0 ? (
        <EmptyState data-testid="find-empty">
          <EmptyState.Header>
            <EmptyState.Media variant="icon">
              <SearchX />
            </EmptyState.Media>
            <EmptyState.Title>{term ? `No ${word} found for "${term}"` : `No ${word} to show`}</EmptyState.Title>
            <EmptyState.Description>
              Try another word, or a shorter one. Only {word} that work with {matching} are listed.
            </EmptyState.Description>
          </EmptyState.Header>
        </EmptyState>
      ) : (
        <>
          <ul className="flex flex-col gap-2" aria-label={`${word} from Modrinth`}>
            {hits.map((hit) => {
              const isInstalled = hit.installed || doneIds.has(hit.projectId);
              const mine = installingId === hit.projectId;
              return (
                <li
                  key={hit.projectId}
                  data-testid="find-result"
                  className="flex flex-col gap-2 rounded-lg border border-border p-3"
                  style={{ background: "var(--surface-secondary)" }}
                >
                  <div className="flex items-start gap-3">
                    <Avatar size="lg" className="shrink-0">
                      {hit.iconUrl && <Avatar.Image alt="" src={hit.iconUrl} />}
                      <Avatar.Fallback>
                        <Blocks size={18} aria-hidden />
                      </Avatar.Fallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-baseline gap-x-2">
                        <span
                          ref={(el) => {
                            if (el) titleRefs.current.set(hit.projectId, el);
                            else titleRefs.current.delete(hit.projectId);
                          }}
                          tabIndex={-1}
                          className="text-sm font-semibold text-foreground outline-none"
                        >
                          {hit.title}
                        </span>
                        <span className="text-xs text-muted">by {hit.author}</span>
                      </p>
                      <p className="mt-0.5 line-clamp-2 text-xs text-muted">{hit.description}</p>
                      <p className="mt-1 text-xs text-muted">
                        <Downloads value={hit.downloads} />
                      </p>
                    </div>
                    <div className="shrink-0">
                      {isInstalled ? (
                        <span className="flex items-center gap-1 text-xs text-success">
                          <CheckCircle2 size={14} aria-hidden />
                          Installed
                        </span>
                      ) : (
                        <Button
                          size="sm"
                          aria-label={`Install ${hit.title}`}
                          isDisabled={pending}
                          isPending={mine}
                          onPress={() => void install(hit)}
                          onMouseEnter={() => play("hover")}
                        >
                          <PressRipple />
                          <Download size={14} />
                          Install
                        </Button>
                      )}
                    </div>
                  </div>

                  {hit.clientSide === "required" && !isInstalled && (
                    <p className="flex items-start gap-2 text-xs text-warning">
                      <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden />
                      <span>Every player has to install this {noun} too, or they cannot join.</span>
                    </p>
                  )}

                  {mine && (
                    <div className="grid gap-1.5">
                      <div className="flex items-center justify-between gap-3 text-xs text-muted">
                        <span role="status" className="truncate">
                          <TextShimmer>
                            {progress
                              ? `Downloading ${progress.filename}${fileNo > 1 ? ` (file ${fileNo})` : ""}`
                              : "Getting ready..."}
                          </TextShimmer>
                        </span>
                        <span className="shrink-0 font-pixel-num">
                          {progress
                            ? progress.totalBytes
                              ? `${formatBytes(progress.receivedBytes)} / ${formatBytes(progress.totalBytes)}`
                              : formatBytes(progress.receivedBytes)
                            : ""}
                        </span>
                      </div>
                      <ProgressBar
                        className="progress-bar-steps"
                        aria-label={`Installing ${hit.title}`}
                        size="sm"
                        value={
                          progress?.totalBytes
                            ? Math.min(100, (progress.receivedBytes / progress.totalBytes) * 100)
                            : 0
                        }
                        isIndeterminate={!progress?.totalBytes}
                      >
                        <ProgressBar.Track>
                          <ProgressBar.Fill />
                        </ProgressBar.Track>
                      </ProgressBar>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>

          {hasMore && (
            <Button
              variant="secondary"
              className="w-fit"
              isPending={loadingMore}
              isDisabled={pending}
              onPress={() => void showMore()}
              onMouseEnter={() => play("hover")}
            >
              Show more
            </Button>
          )}
        </>
      )}

      <p className="text-xs text-muted">
        Results come from <Term term="Modrinth">Modrinth</Term> (
        <OutLink href="https://modrinth.com" className="underline decoration-dotted underline-offset-4">
          modrinth.com
        </OutLink>
        ). MineUI checks every file against what Modrinth published before it keeps it.
      </p>
    </div>
  );
}

function ResultSkeletons() {
  return (
    <div className="flex flex-col gap-2" aria-busy="true" aria-label="Loading results" data-testid="find-loading">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex items-start gap-3 rounded-lg border border-border p-3">
          <Skeleton className="size-12 shrink-0 rounded-lg" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-3.5 w-2/5 rounded" />
            <Skeleton className="h-3 w-full rounded" />
            <Skeleton className="h-3 w-1/4 rounded" />
          </div>
        </div>
      ))}
    </div>
  );
}
