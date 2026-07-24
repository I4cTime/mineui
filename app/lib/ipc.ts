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
  | "RUNTIME_NOT_FOUND" | "CONTAINER_NOT_FOUND" | "SERVER_NOT_RUNNING"
  | "SERVER_RUNNING" | "RCON_UNAVAILABLE" | "RCON_COMMAND_BLOCKED"
  | "QUERY_UNAVAILABLE" | "JAVA_NOT_FOUND" | "JAVA_INCOMPATIBLE"
  | "EULA_NOT_ACCEPTED" | "INSTANCE_NOT_FOUND" | "INSTANCE_EXISTS"
  | "DOWNLOAD_FAILED" | "CHECKSUM_MISMATCH" | "SERVER_UTILS_UNAVAILABLE"
  | "PATH_NOT_ALLOWED" | "FILE_TOO_LARGE" | "WRONG_MODE" | "INVALID_INPUT"
  | "SETTINGS_INVALID" | "IO" | "INTERNAL";

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

export type Settings = {
  schemaVersion: 2;
  activeMode: Mode;
  rconAllowlist: string[];
  simple: SimpleModeSettings;
  advanced: AdvancedModeSettings;
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

export const getSettings = () => call<Settings>("get_settings");
export const setSettings = (settings: Settings) =>
  call<Settings>("set_settings", { settings });
export const detectRuntimes = () => call<RuntimeProbe>("detect_runtimes");
export const javaCheck = () => call<JavaCheck>("java_check");

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

export const getServerState = () => call<ServerState>("get_server_state");
export const startServer = () => call<void>("start_server");
export const stopServer = () => call<void>("stop_server");
export const restartServer = () => call<void>("restart_server");
export const getServerStatus = () => call<ServerStatus>("get_server_status");

/* ---------- logs ---------- */

export const getLogs = (tail?: number) =>
  call<{ lines: string[] }>("get_logs", { tail });
export const startLogStream = () => call<void>("start_log_stream");
export const stopLogStream = () => call<void>("stop_log_stream");

/* ---------- players / rcon ---------- */

export type PlayersResult = { players: string[]; raw: string };

export type PlayerHistoryRow = {
  username: string;
  lastSeenEpochMs: number | null;
  ipAddress: string | null;
  isOnline: boolean;
};

export const getPlayers = () => call<PlayersResult>("get_players");
export const getPlayerHistory = () =>
  call<{ users: PlayerHistoryRow[] }>("get_player_history");
export const runRconCommand = (command: string) =>
  call<{ output: string }>("run_rcon_command", { command });

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

export const listMods = () => call<ModsList>("list_mods");
export const uploadMod = (sourcePath: string, target: ModTarget) =>
  call<{ filename: string }>("upload_mod", { sourcePath, target });
export const downloadMod = (url: string, target: ModTarget, filename?: string) =>
  call<{ filename: string; downloadId: string }>("download_mod", {
    url, target, filename,
  });
export const deleteMod = (filename: string, target: ModTarget) =>
  call<void>("delete_mod", { filename, target });

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
  call<McVersion[]>("list_mc_versions", { includeSnapshots });
export const createInstance = (args: CreateInstanceArgs) =>
  call<InstanceStatus>("create_instance", { args });
export const deleteInstance = () =>
  call<void>("delete_instance", { confirm: true });
export const instanceStatus = () => call<InstanceStatus>("instance_status");

/* ---------- config files ---------- */

export const listConfigFiles = () =>
  call<{ files: string[] }>("list_config_files");
export const readConfigFile = (path: string) =>
  call<{ content: string }>("read_config_file", { path });
export const writeConfigFile = (path: string, content: string) =>
  call<void>("write_config_file", { path, content });

/* ---------- backups ---------- */

export type BackupEntry = {
  filename: string;
  sizeBytes: number;
  createdAtEpochMs: number;
};

export const createBackup = () => call<BackupEntry>("create_backup");
export const listBackups = () => call<BackupEntry[]>("list_backups");
export const restoreBackup = (filename: string) =>
  call<void>("restore_backup", { filename });
export const deleteBackup = (filename: string) =>
  call<void>("delete_backup", { filename });

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

export const getMetrics = () => call<Metrics>("get_metrics");

/* ---------- events ---------- */

export type LogSource = "stdout" | "stderr" | "runtime";
export type LogLine = { text: string; epochMs: number; source: LogSource };
export type LogsEvent = { lines: LogLine[] };

export type ServerStateEvent = {
  mode: Mode;
  phase: ServerPhase;
  previousPhase: ServerPhase;
  epochMs: number;
  exitCode: number | null;
};

export type DownloadKind = "server-jar" | "mod";
export type DownloadProgressEvent = {
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

export const onLogs = (cb: (e: LogsEvent) => void): Promise<UnlistenFn> =>
  isTauri()
    ? listen<LogsEvent>(EVENT_LOGS, (ev) => cb(ev.payload))
    : Promise.resolve(NOOP_UNLISTEN);
export const onServerState = (
  cb: (e: ServerStateEvent) => void,
): Promise<UnlistenFn> =>
  isTauri()
    ? listen<ServerStateEvent>(EVENT_SERVER_STATE, (ev) => cb(ev.payload))
    : Promise.resolve(NOOP_UNLISTEN);
export const onDownloadProgress = (
  cb: (e: DownloadProgressEvent) => void,
): Promise<UnlistenFn> =>
  isTauri()
    ? listen<DownloadProgressEvent>(EVENT_DOWNLOAD_PROGRESS, (ev) =>
        cb(ev.payload),
      )
    : Promise.resolve(NOOP_UNLISTEN);
