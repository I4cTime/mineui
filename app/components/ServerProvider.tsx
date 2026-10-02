"use client";

// App-wide server-profile state (contract §2.5, §3.12): which servers MineUI
// manages, which one the pages are showing, and a live overview of all of
// them.
//
// Every page talks to "the current server" through app/lib/ipc.ts, which
// keeps a single IPC target. This provider is the only thing that moves that
// target, and it does so in two phases so no page ever straddles two
// servers:
//
//   1. switchTo(id) marks the switch as pending. <ServerBoundary> unmounts
//      the page, whose cleanup (stop_log_stream, unlisten) therefore still
//      runs against the OLD target.
//   2. Only then — in the effect of that same commit — the target moves and
//      the page remounts (keyed by server id) against the new one.
//
// The backend runs every profile at once regardless (scheduler, log
// followers, state polling); switching only changes what the pages look at.
//
// Fails soft outside Tauri (`pnpm dev` browser preview): one "Default"
// server, nothing to switch to.
import {
  createContext,
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  addServer,
  DEFAULT_SERVER_ID,
  getServersOverview,
  isTauri,
  listServers,
  onAnyServerState,
  removeServer,
  renameServer,
  setActiveServer,
  setIpcTargetServer,
  type Mode,
  type ServerList,
  type ServerOverview,
  type ServerPhase,
  type ServerProfile,
} from "@/app/lib/ipc";

const FALLBACK_SERVER: ServerProfile = { id: DEFAULT_SERVER_ID, name: "Default" };
const OVERVIEW_POLL_MS = 6000;

interface ServerContextValue {
  /** Every server profile, in display order. */
  servers: ServerProfile[];
  /** The profile the pages are showing (= the IPC target). */
  activeId: string;
  active: ServerProfile;
  /** False until the initial list_servers() resolves (or fails soft). */
  ready: boolean;
  /** True while a switch is in flight — the page is unmounted meanwhile. */
  switching: boolean;
  /** Live phase + status of every profile; empty until the first poll. */
  overview: ServerOverview[];
  switchTo: (id: string) => void;
  /** These three reject with IpcError; callers own the messaging.
   *  `add` also opens the new server, ready to be configured. */
  add: (name: string, mode: Mode) => Promise<ServerProfile>;
  rename: (id: string, name: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  refreshOverview: () => Promise<void>;
}

const ServerContext = createContext<ServerContextValue | null>(null);

export default function ServerProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [servers, setServers] = useState<ServerProfile[]>([FALLBACK_SERVER]);
  const [activeId, setActiveId] = useState(DEFAULT_SERVER_ID);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [overview, setOverview] = useState<ServerOverview[]>([]);

  useEffect(() => {
    if (!isTauri()) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- no backend to wait for; must match the server-rendered (not ready) markup first
      setReady(true);
      return;
    }
    let cancelled = false;
    listServers()
      .then((list) => {
        if (cancelled) return;
        setIpcTargetServer(list.activeServerId);
        setServers(list.servers);
        setActiveId(list.activeServerId);
      })
      .catch(() => {
        // Fail soft: keep the single default server; pages surface their
        // own backend errors.
      })
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Phase 2 of a switch (see the header comment). Runs in the commit that
  // unmounted the page, after that page's effect cleanups.
  useEffect(() => {
    if (pendingId === null) return;
    setIpcTargetServer(pendingId);
    // Persisting which server opens next launch is best-effort.
    setActiveServer(pendingId).catch(() => {});
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the IPC target may only move once the old page is unmounted, i.e. after this commit
    setActiveId(pendingId);
    setPendingId(null);
  }, [pendingId]);

  const switchTo = useCallback(
    (id: string) => {
      if (id === activeId || pendingId !== null) return;
      if (!servers.some((server) => server.id === id)) return;
      setPendingId(id);
    },
    [activeId, pendingId, servers],
  );

  const refreshOverview = useCallback(async () => {
    if (!isTauri()) return;
    try {
      setOverview(await getServersOverview());
    } catch {
      // Keep the last known overview; the next poll retries.
    }
  }, []);

  useEffect(() => {
    if (!ready || !isTauri()) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- IPC fetch-on-mount
    refreshOverview();
    const interval = setInterval(refreshOverview, OVERVIEW_POLL_MS);
    let disposed = false;
    let unlisten: (() => void) | null = null;
    onAnyServerState(() => {
      refreshOverview();
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      clearInterval(interval);
      unlisten?.();
    };
  }, [ready, refreshOverview]);

  const adopt = useCallback(
    (list: ServerList) => {
      setServers(list.servers);
      // The open server is gone (removed from elsewhere): fall back to the
      // backend's active one rather than keep targeting a dead id.
      if (!list.servers.some((server) => server.id === activeId)) {
        setPendingId(list.activeServerId);
      }
      refreshOverview();
    },
    [activeId, refreshOverview],
  );

  const add = useCallback(
    async (name: string, mode: Mode) => {
      const list = await addServer(name, mode);
      adopt(list);
      const created = list.servers[list.servers.length - 1];
      setPendingId(created.id);
      return created;
    },
    [adopt],
  );

  const rename = useCallback(
    async (id: string, name: string) => {
      adopt(await renameServer(id, name));
    },
    [adopt],
  );

  const remove = useCallback(
    async (id: string) => {
      adopt(await removeServer(id));
    },
    [adopt],
  );

  const value = useMemo<ServerContextValue>(
    () => ({
      servers,
      activeId,
      active: servers.find((server) => server.id === activeId) ?? FALLBACK_SERVER,
      ready,
      switching: pendingId !== null,
      overview,
      switchTo,
      add,
      rename,
      remove,
      refreshOverview,
    }),
    [servers, activeId, ready, pendingId, overview, switchTo, add, rename, remove, refreshOverview],
  );

  return <ServerContext.Provider value={value}>{children}</ServerContext.Provider>;
}

export function useServers(): ServerContextValue {
  const ctx = useContext(ServerContext);
  if (!ctx) {
    throw new Error("useServers() must be used within a <ServerProvider>");
  }
  return ctx;
}

/**
 * Wraps the routed page. Holds it back until the server list (and, via
 * `isLoading`, anything else that is per-server) is known, unmounts it for
 * the duration of a switch, and remounts it keyed by server id so every
 * fetch-on-mount effect re-runs against the new server.
 */
export function ServerBoundary({
  isLoading = false,
  children,
}: {
  isLoading?: boolean;
  children: React.ReactNode;
}) {
  const { activeId, ready, switching } = useServers();
  if (!ready || switching || isLoading) {
    return <div className="min-h-screen bg-background" aria-busy="true" />;
  }
  return <Fragment key={activeId}>{children}</Fragment>;
}

/* ---------- shared presentation helpers ---------- */

/** Status-dot color for a phase — semantic tokens only. */
export function phaseDotClass(phase: ServerPhase | null | undefined): string {
  switch (phase) {
    case "running":
      return "bg-success";
    case "starting":
    case "stopping":
      return "bg-warning";
    case "crashed":
      return "bg-danger";
    default:
      return "bg-muted";
  }
}

export function phaseText(phase: ServerPhase | null | undefined): string {
  switch (phase) {
    case "not-created":
      return "Not created";
    case null:
    case undefined:
      return "Unknown";
    default:
      return phase.charAt(0).toUpperCase() + phase.slice(1);
  }
}

const LOADER_LABELS: Record<string, string> = {
  vanilla: "Vanilla",
  fabric: "Fabric",
  forge: "Forge",
  neoforge: "NeoForge",
  paper: "Paper",
  quilt: "Quilt",
  purpur: "Purpur",
  spigot: "Spigot",
  bukkit: "Bukkit",
  modrinth: "Modrinth pack",
  auto_curseforge: "CurseForge pack",
};

/**
 * What a server actually is, independent of the name it was given:
 * "Forge 1.21.1 · mc-forge · 127.0.0.1:25566". Used wherever a server has to
 * be told apart from its neighbours (page headers, switcher, cards).
 */
export function identityLine(entry: ServerOverview | undefined): string {
  if (!entry) return "";
  if (entry.phase === "not-created") {
    return entry.mode === "advanced" ? "No container yet" : "No server created yet";
  }
  const version = entry.mcVersion ?? entry.status.version;
  const loader = entry.loader
    ? (LOADER_LABELS[entry.loader] ??
      entry.loader.charAt(0).toUpperCase() + entry.loader.slice(1))
    : null;
  // A modpack server is named by its pack: "cobblemon-fabric 1.21.1 ·
  // Modrinth pack"; a plain one by its loader: "Forge 1.21.1".
  const kind = entry.modpack
    ? [[entry.modpack, version].filter(Boolean).join(" "), loader]
    : [[loader, version].filter(Boolean).join(" ")];
  return [...kind, entry.containerName ?? "Managed", entry.address]
    .filter(Boolean)
    .join(" · ");
}

/** "Running · 2/20 players" — one line for menus and cards. */
export function overviewSummary(entry: ServerOverview | undefined): string {
  if (!entry) return "Checking…";
  const parts = [phaseText(entry.phase)];
  if (entry.status.online) {
    parts.push(`${entry.status.players.online}/${entry.status.players.max} players`);
  }
  parts.push(entry.mode === "simple" ? "Simple" : "Advanced");
  return parts.join(" · ");
}
