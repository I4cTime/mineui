// app/lib/ipc.ts
//
// Single typed IPC module — generated verbatim from docs/v2-contract.md §7.
// This is the ONLY file that imports @tauri-apps/api/core or
// @tauri-apps/api/event. Pages/components import types and wrappers from here;
// no raw invoke(), no locally re-declared IPC types anywhere else.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/* ---------- runtime guard ---------- */

/**
 * True when running inside the Tauri webview. In a plain browser
 * (`pnpm dev` without `pnpm tauri dev`) all wrappers reject with a clear
 * IpcError instead of crashing, and event subscriptions become no-ops.
 */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/* ---------- errors ---------- */

export type ErrorCode =
  | "RUNTIME_NOT_FOUND" | "CONTAINER_NOT_FOUND" | "CONTAINER_EXISTS"
  | "CONTAINER_CREATE_FAILED" | "SERVER_NOT_RUNNING"
  | "SERVER_RUNNING" | "RCON_UNAVAILABLE" | "RCON_COMMAND_BLOCKED"
  | "QUERY_UNAVAILABLE" | "JAVA_NOT_FOUND" | "JAVA_INCOMPATIBLE"
  | "EULA_NOT_ACCEPTED" | "INSTANCE_NOT_FOUND" | "INSTANCE_EXISTS"
  | "DOWNLOAD_FAILED" | "CHECKSUM_MISMATCH" | "SERVER_UTILS_UNAVAILABLE"
  | "PATH_NOT_ALLOWED" | "FILE_TOO_LARGE" | "WRONG_MODE" | "INVALID_INPUT"
  | "SETTINGS_INVALID" | "SERVER_NOT_FOUND" | "IO" | "INTERNAL";

export class IpcError extends Error {
  constructor(public readonly code: ErrorCode, message: string) {
    super(message);
    this.name = "IpcError";
  }
}

function isErrorShape(e: unknown): e is { code: ErrorCode; message: string } {
  return typeof e === "object" && e !== null && "code" in e && "message" in e;
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) {
    throw new IpcError(
      "INTERNAL",
      `Tauri runtime not available (command "${cmd}"). Run the app via \`pnpm tauri dev\`, not a plain browser.`,
    );
  }
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    if (isErrorShape(e)) throw new IpcError(e.code, e.message);
    throw new IpcError("INTERNAL", String(e));
  }
}

/* ---------- server targeting (§3.0) ---------- */

let targetServerId: string | null = null;

/**
 * The server profile (§2.5) every scoped wrapper and event helper below
 * addresses. Owned by ServerProvider (app/components/ServerProvider.tsx),
 * which only moves it while no page is mounted — pages never call this.
 */
export function setIpcTargetServer(id: string | null): void {
  targetServerId = id;
}

export function getIpcTargetServer(): string | null {
  return targetServerId;
}

/** A §3.1–§3.11 command, sent to the current target server. */
function scoped<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return call<T>(cmd, { ...args, serverId: targetServerId });
}

/* ---------- settings ---------- */

export type Mode = "simple" | "advanced";
export type RuntimeKind = "auto" | "podman" | "docker";

export type SimpleModeSettings = {
  instanceDir: string;
  mcVersion: string;
  memoryMb: number;
  javaPath: string | null;
  eulaAccepted: boolean;
  serverPort: number;
  rconPort: number;
  rconPassword: string;
};

export type AdvancedModeSettings = {
  runtime: RuntimeKind;
  socketPath: string | null;
  runtimeBinary: string | null;
  containerName: string;
  queryHost: string;
  queryPort: number;
  rconHost: string;
  rconPort: number;
  rconPassword: string;
  worldDir: string;
  serverUtilsUrl: string | null;
};

export type ScheduleKind = "interval" | "daily" | "weekly";
export type Weekday =
  | "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday";

/** When a scheduled job fires. Times are local wall-clock, "HH:MM" 24 h. */
export type Schedule =
  | { kind: "interval"; everyHours: number }            // 1–168
  | { kind: "daily"; time: string }                      // "HH:MM"
  | { kind: "weekly"; weekday: Weekday; time: string };  // "HH:MM"

export type ScheduledJobKind = "restart" | "backup" | "broadcast";

export type ScheduledJob = {
  /** uuid v4, minted by the frontend when the job is created. */
  id: string;
  kind: ScheduledJobKind;
  enabled: boolean;
  schedule: Schedule;
  /** broadcast: chat text sent via RCON `say` (required, 1–200 chars).
   *  restart: optional warning sent via `say` 60 s before the restart.
   *  backup: ignored (null). */
  message: string | null;
};

export type SchedulerSettings = {
  /** Master switch; false pauses every job without losing them. Default true. */
  enabled: boolean;
  jobs: ScheduledJob[];                 // max 32
};

export type BackupSettings = {
  /** Newest snapshots to keep after every backup (manual or scheduled);
   *  0 = unlimited. Default 10. */
  keepLast: number;
  /** Absolute host directory that receives a copy of every new snapshot;
   *  null = off. */
  copyDir: string | null;
};

export type Settings = {
  schemaVersion: 2;
  activeMode: Mode;
  rconAllowlist: string[];
  allowPrivateDownloadHosts: boolean;
  simple: SimpleModeSettings;
  advanced: AdvancedModeSettings;
  scheduler: SchedulerSettings;
  backups: BackupSettings;
};

export type RuntimeProbe = {
  podman: { binary: string; version: string } | null;
  docker: { binary: string; version: string } | null;
  resolved: "podman" | "docker" | null;
};

export type JavaCheck = {
  found: boolean;
  path: string | null;
  version: string | null;
  majorVersion: number | null;
  requiredMajor: number | null;
  compatible: boolean | null;
};

export const getSettings = () => scoped<Settings>("get_settings");
export const setSettings = (settings: Settings) =>
  scoped<Settings>("set_settings", { settings });
export const detectRuntimes = () => scoped<RuntimeProbe>("detect_runtimes");
export const javaCheck = () => scoped<JavaCheck>("java_check");

/* ---------- server state / lifecycle / status ---------- */

export type ServerPhase =
  | "not-created" | "stopped" | "starting" | "running" | "stopping" | "crashed";

export type ServerState = {
  mode: Mode;
  phase: ServerPhase;
  container: {
    exists: boolean;
    id: string | null;
    status: string | null;
    createdAt: string | null;
    startedAt: string | null;
  } | null;
  process: {
    pid: number | null;
    startedAt: string | null;
    lastExitCode: number | null;
  } | null;
};

export type ServerStatus = {
  online: boolean;
  version: string | null;
  motd: string | null;
  players: { online: number; max: number; sample: { name: string }[] };
  pingMs: number | null;
  source: "query" | "server-utils" | "none";
  error: string | null;
};

export const getServerState = () => scoped<ServerState>("get_server_state");
export const startServer = () => scoped<void>("start_server");
export const stopServer = () => scoped<void>("stop_server");
export const restartServer = () => scoped<void>("restart_server");
export const getServerStatus = () => scoped<ServerStatus>("get_server_status");

/** Lifecycle for a server other than the current target (the all-servers
 *  strip on the dashboard acts on every profile at once). */
export const startServerById = (serverId: string) =>
  call<void>("start_server", { serverId });
export const stopServerById = (serverId: string) =>
  call<void>("stop_server", { serverId });

/* ---------- server profiles (§2.5, §3.12) ---------- */

export type ServerProfile = { id: string; name: string };

export type ServerList = { activeServerId: string; servers: ServerProfile[] };

export type ServerOverview = {
  id: string;
  name: string;
  mode: Mode;
  /** null when the phase could not be read (see `error`). */
  phase: ServerPhase | null;
  status: ServerStatus;
  error: string | null;
  /** Advanced: the attached container. Simple: null. */
  containerName: string | null;
  /** `host:port` of the game port. */
  address: string;
  /** Lowercased server type ("forge", "fabric", "vanilla", …) or null. */
  loader: string | null;
  /** Known version, or null (fall back to `status.version` while online). */
  mcVersion: string | null;
  /** The modpack the container was created from (slug), or null. `loader`
   *  is then "modrinth" or "auto_curseforge". */
  modpack: string | null;
};

export const DEFAULT_SERVER_ID = "default";
export const MAX_SERVERS = 16;
export const MAX_SERVER_NAME_CHARS = 40;

export const listServers = () => call<ServerList>("list_servers");
export const addServer = (name: string, mode?: Mode) =>
  call<ServerList>("add_server", { name, mode });
export const renameServer = (id: string, name: string) =>
  call<ServerList>("rename_server", { id, name });
export const removeServer = (id: string) =>
  call<ServerList>("remove_server", { id, confirm: true });
export const setActiveServer = (id: string) =>
  call<ServerList>("set_active_server", { id });
export const getServersOverview = () =>
  call<ServerOverview[]>("get_servers_overview");

/* ---------- container creation (§3.13) ---------- */

export type ContainerLoader =
  | "vanilla" | "fabric" | "forge" | "neoforge" | "paper" | "quilt" | "purpur";

export type CreateContainerArgs = {
  loader: ContainerLoader;
  /** A Mojang version id ("1.21.1") or "LATEST". */
  mcVersion: string;
  containerName: string;
  memoryMb: number;
  gamePort: number;
  rconPort: number;
  /** true: game port on every interface; false: 127.0.0.1 only. */
  exposeToNetwork: boolean;
  acceptEula: boolean;
  /** Create from a modpack instead of a bare loader; `loader` is then
   *  ignored and `mcVersion` must be a concrete version. */
  modpack?: ModpackRef | null;
};

/** Result of delete_container (§3.13). */
export type DeletedContainer = {
  containerName: string;
  /** The named volume deleted with it, or null. */
  deletedVolume: string | null;
  /** Why the data stayed although its deletion was asked for, or null. */
  dataKept: string | null;
};

/**
 * Deletes a server's container — and, only with `deleteData`, the volume
 * holding its world. The server profile itself stays. Always for a named
 * server: this is offered from lists as well as for the open server, and the
 * caller must have shown the container's name and got a confirmation.
 */
export const deleteContainerFor = (serverId: string, deleteData: boolean) =>
  call<DeletedContainer>("delete_container", { serverId, confirm: true, deleteData });

export type ModpackSource = "modrinth" | "curseforge" | "curseforge-zip";

export type ModpackRef = {
  source: ModpackSource;
  /** Slug, id, or the pack's page URL on that source; for "curseforge-zip"
   *  the host path of the exported zip (2.8.0). */
  project: string;
};

/** What inspect_modpack_zip reads from a CurseForge app export (§3.14). */
export type ModpackZipInfo = {
  name: string;
  mcVersion: string;
  /** forge, neoforge, fabric, quilt — from the primary mod loader, or null. */
  loader: string | null;
  loaderVersion: string | null;
  /** Files the manifest lists (the image downloads them). */
  files: number;
  hasOverrides: boolean;
};

/* ---------- modpack search (§3.14) ---------- */

export type ModpackHit = {
  source: "modrinth";
  slug: string;
  id: string;
  title: string;
  description: string;
  author: string;
  iconUrl: string | null;
  downloads: number;
  /** Minecraft versions the pack has builds for, oldest first. */
  gameVersions: string[];
  /** Any of forge, neoforge, fabric, quilt. */
  loaders: string[];
};

/** Modrinth modpacks that can run on a server. Empty query = most
 *  downloaded. CurseForge has no keyless search — name those by slug/URL. */
export const searchModpacks = (query: string, limit?: number) =>
  scoped<ModpackHit[]>("search_modpacks", { query, limit });

/** Reads the manifest of a CurseForge app export (host path from the dialog
 *  plugin) so the create form can show what it is and fix the version. */
export const inspectModpackZip = (sourcePath: string) =>
  scoped<ModpackZipInfo>("inspect_modpack_zip", { sourcePath });

/** Creates an itzg/minecraft-server container for the target server. Pulls
 *  the image when missing — the first call can take minutes. */
export const createContainer = (args: CreateContainerArgs) =>
  scoped<ServerState>("create_container", { args });

/* ---------- logs ---------- */

export const getLogs = (tail?: number) =>
  scoped<{ lines: string[] }>("get_logs", { tail });
export const startLogStream = () => scoped<void>("start_log_stream");
export const stopLogStream = () => scoped<void>("stop_log_stream");

/* ---------- players / rcon ---------- */

export type PlayersResult = { players: string[]; raw: string };

export type PlayerHistoryRow = {
  username: string;
  lastSeenEpochMs: number | null;
  ipAddress: string | null;
  isOnline: boolean;
};

export const getPlayers = () => scoped<PlayersResult>("get_players");
export const getPlayerHistory = () =>
  scoped<{ users: PlayerHistoryRow[] }>("get_player_history");
export const runRconCommand = (command: string) =>
  scoped<{ output: string }>("run_rcon_command", { command });

/* ---------- mods ---------- */

export type ModTarget = "mods" | "plugins";
export type ModLoader = "forge" | "neoforge" | "fabric" | "unknown";

export type ModEntry = {
  name: string;
  filename: string;
  sizeBytes: number;
  updatedAtEpochMs: number;
  loader: ModLoader;
};

export type ModsList = { mods: ModEntry[]; plugins: ModEntry[] };

export const listMods = () => scoped<ModsList>("list_mods");
export const uploadMod = (sourcePath: string, target: ModTarget) =>
  scoped<{ filename: string }>("upload_mod", { sourcePath, target });
export const downloadMod = (url: string, target: ModTarget, filename?: string) =>
  scoped<{ filename: string; downloadId: string }>("download_mod", {
    url, target, filename,
  });
export const deleteMod = (filename: string, target: ModTarget) =>
  scoped<void>("delete_mod", { filename, target });

/** Result of unpacking a zip of mods (§3.5, §6.2a). */
export type UnpackedMods = {
  /** Filenames placed in the target folder, sorted. */
  installed: string[];
  /** Archive entries that were not installed. */
  skipped: number;
  /** Set when the archive came from a URL. */
  downloadId: string | null;
};

/** Where a mod archive comes from: a file on this computer, or a link. */
export type ModArchiveSource =
  | { sourcePath: string }
  | { url: string; filename?: string };

/** Installs the .jar files inside a .zip (a zipped folder of mods, or a
 *  server pack) — unlike uploadMod/downloadMod, which place a .zip as one
 *  file. */
export const unpackModArchive = (source: ModArchiveSource, target: ModTarget) =>
  scoped<UnpackedMods>("unpack_mod_archive", { ...source, target });

/* ---------- instance (simple mode) ---------- */

export type McVersion = {
  id: string;
  type: "release" | "snapshot" | "old_beta" | "old_alpha";
  releaseTime: string;
  latest: boolean;
};

export type CreateInstanceArgs = {
  mcVersion: string;
  acceptEula: boolean;
  memoryMb?: number;
};

export type InstanceStatus = {
  exists: boolean;
  instanceDir: string;
  mcVersion: string | null;
  requiredJavaMajor: number | null;
  jarSha1: string | null;
  eulaAccepted: boolean;
  rconConfigured: boolean;
  worldExists: boolean;
  createdAt: string | null;
};

export const listMcVersions = (includeSnapshots?: boolean) =>
  scoped<McVersion[]>("list_mc_versions", { includeSnapshots });
export const createInstance = (args: CreateInstanceArgs) =>
  scoped<InstanceStatus>("create_instance", { args });
export const deleteInstance = () =>
  scoped<void>("delete_instance", { confirm: true });
export const instanceStatus = () => scoped<InstanceStatus>("instance_status");

/* ---------- config files ---------- */

export const listConfigFiles = () =>
  scoped<{ files: string[] }>("list_config_files");
export const readConfigFile = (path: string) =>
  scoped<{ content: string }>("read_config_file", { path });
export const writeConfigFile = (path: string, content: string) =>
  scoped<void>("write_config_file", { path, content });

/* ---------- backups ---------- */

export type BackupEntry = {
  filename: string;
  sizeBytes: number;
  createdAtEpochMs: number;
};

export const createBackup = () => scoped<BackupEntry>("create_backup");
export const listBackups = () => scoped<BackupEntry[]>("list_backups");
export const restoreBackup = (filename: string) =>
  scoped<void>("restore_backup", { filename });
export const deleteBackup = (filename: string) =>
  scoped<void>("delete_backup", { filename });

/* ---------- scheduler (§3.10) ---------- */

export type JobRunResult = { epochMs: number; ok: boolean; message: string | null };

export type ScheduledJobStatus = {
  id: string;
  nextRunEpochMs: number | null;
  lastRun: JobRunResult | null;
};

export type SchedulerStatus = { enabled: boolean; jobs: ScheduledJobStatus[] };

export const getSchedulerStatus = () =>
  scoped<SchedulerStatus>("get_scheduler_status");
export const runScheduledJobNow = (id: string) =>
  scoped<JobRunResult>("run_scheduled_job_now", { id });

/* ---------- player notes / audit log (§3.11) ---------- */

export type PlayerNote = { username: string; note: string; updatedAtEpochMs: number };

export type AuditSource = "user" | "scheduler";

export type AuditEntry = {
  id: string;
  epochMs: number;
  source: AuditSource;
  action: string;
  target: string | null;
  detail: string | null;
  ok: boolean;
  error: string | null;
};

export const getPlayerNotes = () =>
  scoped<{ notes: PlayerNote[] }>("get_player_notes");
export const setPlayerNote = (username: string, note: string) =>
  scoped<PlayerNote | null>("set_player_note", { username, note });
export const getAuditLog = (limit?: number) =>
  scoped<{ entries: AuditEntry[] }>("get_audit_log", { limit });

/* ---------- metrics ---------- */

export type IoPair = { inputBytes: number | null; outputBytes: number | null };

export type Metrics = {
  base: "container" | "process";
  enriched: boolean;
  cpuPercent: number | null;
  mem: { usedBytes: number | null; totalBytes: number | null; percent: number | null };
  net: IoPair | null;
  block: IoPair | null;
  disk: { usedBytes: number | null; totalBytes: number | null; percent: number | null } | null;
  startedAt: string | null;
  uptimeSeconds: number | null;
  tps: { one: number; five: number; fifteen: number; raw: string } | null;
  mspt: { one: number | null; five: number | null; fifteen: number | null } | null;
  chunks: number | null;
  entities: number | null;
  dimensions: Record<string, { chunks: number | null; entities: number | null }> | null;
  players: { online: number | null; max: number | null } | null;
};

export const getMetrics = () => scoped<Metrics>("get_metrics");

/* ---------- events ---------- */

// Every event payload carries the server profile it came from (§4).
export type LogSource = "stdout" | "stderr" | "runtime";
export type LogLine = { text: string; epochMs: number; source: LogSource };
export type LogsEvent = { serverId: string; lines: LogLine[] };

export type ServerStateEvent = {
  serverId: string;
  mode: Mode;
  phase: ServerPhase;
  previousPhase: ServerPhase;
  epochMs: number;
  exitCode: number | null;
};

export type DownloadKind = "server-jar" | "mod";
export type DownloadProgressEvent = {
  serverId: string;
  downloadId: string;
  kind: DownloadKind;
  filename: string;
  url: string;
  receivedBytes: number;
  totalBytes: number | null;
  done: boolean;
  error: { code: ErrorCode; message: string } | null;
};

export const EVENT_LOGS = "mineui://logs";
export const EVENT_SERVER_STATE = "mineui://server-state";
export const EVENT_DOWNLOAD_PROGRESS = "mineui://download-progress";

const NOOP_UNLISTEN: UnlistenFn = () => {};

/**
 * Subscribe to one event channel for the server that is the IPC target
 * *now* — the binding is fixed at subscribe time, so a listener can never
 * start receiving another server's events after a switch.
 */
function onScoped<E extends { serverId: string }>(
  channel: string,
  cb: (e: E) => void,
): Promise<UnlistenFn> {
  if (!isTauri()) return Promise.resolve(NOOP_UNLISTEN);
  const target = targetServerId;
  return listen<E>(channel, (ev) => {
    if (target === null || ev.payload.serverId === target) cb(ev.payload);
  });
}

export const onLogs = (cb: (e: LogsEvent) => void): Promise<UnlistenFn> =>
  onScoped(EVENT_LOGS, cb);
export const onServerState = (
  cb: (e: ServerStateEvent) => void,
): Promise<UnlistenFn> => onScoped(EVENT_SERVER_STATE, cb);
export const onDownloadProgress = (
  cb: (e: DownloadProgressEvent) => void,
): Promise<UnlistenFn> => onScoped(EVENT_DOWNLOAD_PROGRESS, cb);

/** Phase transitions of every server profile, not just the target. */
export const onAnyServerState = (
  cb: (e: ServerStateEvent) => void,
): Promise<UnlistenFn> =>
  isTauri()
    ? listen<ServerStateEvent>(EVENT_SERVER_STATE, (ev) => cb(ev.payload))
    : Promise.resolve(NOOP_UNLISTEN);
