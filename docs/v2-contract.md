# MineUI v2 Data Contract

Status: **LAW** for the v2-tauri migration. Rust backend agent and frontend port agent
implement exactly what is written here. Deviations require a contract amendment in this
file first.

Architecture (fixed, decided by council — do not relitigate here):

- Tauri v2. Next.js App Router frontend converted to static export (`output: 'export'`).
  All data flows through `invoke()` from `@tauri-apps/api/core` and Tauri events.
- Rust workspace: `crates/mineui-core` (pure Rust, **no tauri dependency**) holds all
  logic; `src-tauri` holds thin `#[tauri::command]` wrappers + event emission only.
- Two modes: **simple** (managed vanilla server, MineUI downloads jar + supervises Java
  process) and **advanced** (attach to existing Podman/Docker container — the v1 feature
  set behind a runtime adapter).
- **Multiple servers (2.6.0)**: MineUI manages N independent *server profiles* at
  once (§2.5). Each profile is a complete, isolated copy of everything in this
  contract — its own settings file, mode, supervisor, log stream, scheduler, notes
  and audit log. Every command in §3 targets one profile (§3.0); every event in §4
  names the profile it came from.

Type derivation chain (single source of truth):

```
Rust structs in mineui-core (serde, rename_all = "camelCase")
  → serialized JSON over Tauri IPC
  → TypeScript types in app/lib/ipc.ts (hand-written ONCE from §7 of this doc)
  → pages/components import from app/lib/ipc.ts only
```

No page or component may declare its own copy of an IPC type or call `invoke()` raw.
Every command goes through a typed wrapper in `app/lib/ipc.ts`.

---

## 1. Error contract

Every command either resolves with its return type or **rejects** with exactly this
serializable shape (Tauri serializes the Rust error enum via `serde`):

```ts
type IpcErrorShape = {
  code: ErrorCode;
  message: string; // human-readable, safe to display
};

type ErrorCode =
  | "RUNTIME_NOT_FOUND"        // no usable podman/docker CLI (advanced)
  | "CONTAINER_NOT_FOUND"      // configured container does not exist
  | "CONTAINER_EXISTS"         // create_container over an existing container (§3.13)
  | "CONTAINER_CREATE_FAILED"  // the runtime refused to create/start it (§3.13)
  | "SERVER_NOT_RUNNING"       // operation requires a running server
  | "SERVER_RUNNING"           // operation requires a stopped server (e.g. restore)
  | "RCON_UNAVAILABLE"         // connect/auth failure to RCON
  | "RCON_COMMAND_BLOCKED"     // command not in allowlist
  | "QUERY_UNAVAILABLE"        // status ping failed
  | "JAVA_NOT_FOUND"           // no java binary found (simple)
  | "JAVA_INCOMPATIBLE"        // java found but major version too low (simple)
  | "EULA_NOT_ACCEPTED"        // simple-mode start/create without EULA acceptance
  | "INSTANCE_NOT_FOUND"       // simple-mode instance dir missing/uninitialized
  | "INSTANCE_EXISTS"          // create_instance over an existing instance
  | "DOWNLOAD_FAILED"          // network failure fetching manifest/jar/mod
  | "CHECKSUM_MISMATCH"        // downloaded jar failed sha1 verification
  | "SERVER_UTILS_UNAVAILABLE" // serverUtilsUrl set but unreachable/non-OK
  | "PATH_NOT_ALLOWED"         // config-editor path rejected by validation (§6)
  | "FILE_TOO_LARGE"           // config write > 1.5 MB, upload > 256 MB
  | "WRONG_MODE"               // command not available in active mode (§5)
  | "INVALID_INPUT"            // failed argument validation
  | "SETTINGS_INVALID"         // set_settings payload failed validation
  | "SERVER_NOT_FOUND"         // serverId names no server profile (§2.5, §3.0)
  | "IO"                       // filesystem error
  | "INTERNAL";                // anything else (bug); message carries detail

// Rust side (mineui-core::error):
// #[derive(Debug, thiserror::Error, serde::Serialize)]
// #[serde(tag = "code", rename_all = "SCREAMING_SNAKE_CASE")] — or equivalent
// mapping producing {"code": "...", "message": "..."} exactly.
```

Rules:

- `mineui-core` defines the error enum; `src-tauri` commands return
  `Result<T, mineui_core::Error>` and never invent their own errors.
- `message` must never contain secrets (RCON password, full URLs with tokens).
- Frontend wrappers rethrow as `IpcError` (class defined in `app/lib/ipc.ts`, §7) so
  callers can `catch (e) { if (e instanceof IpcError && e.code === "RCON_UNAVAILABLE") … }`.

---

## 2. Settings schema v2

Stored as JSON at `<app-config-dir>/settings.json` (Tauri path resolver,
`app_config_dir()`). File permissions `0o600` on Unix (RCON passwords are stored
plaintext this phase; keyring is out of scope — the chmod is the mitigation).
`mineui-core::settings` owns load/save/validate/migrate; `src-tauri` passes paths in.

### 2.1 TypeScript type (canonical wire shape)

```ts
type RuntimeKind = "auto" | "podman" | "docker";
type Mode = "simple" | "advanced";

type SimpleModeSettings = {
  /** Absolute path. Default: <app-data-dir>/instances/default */
  instanceDir: string;
  /** Mojang version id, e.g. "1.21.6". Empty string until an instance is created. */
  mcVersion: string;
  /** JVM heap (-Xms/-Xmx), MiB. Default 2048, min 512. */
  memoryMb: number;
  /** Absolute path to a java binary; null = discover on PATH/JAVA_HOME. */
  javaPath: string | null;
  /** User checked the EULA box. Gates create_instance and start_server. */
  eulaAccepted: boolean;
  /** Game port written to server.properties (server-port). Default 25565. */
  serverPort: number;
  /** RCON port written to server.properties. Default 25575. */
  rconPort: number;
  /** Generated once at create_instance (24 chars, alphanumeric, CSPRNG). */
  rconPassword: string;
};

type AdvancedModeSettings = {
  runtime: RuntimeKind;                 // default "auto" (podman first, then docker)
  /** Override for CONTAINER_HOST / DOCKER_HOST socket; null = runtime default. */
  socketPath: string | null;
  /** Override CLI binary path; null = "podman"/"docker" from PATH. */
  runtimeBinary: string | null;
  containerName: string;                // default "minecraft-server"
  queryHost: string;                    // default "127.0.0.1"
  queryPort: number;                    // default 25565 (server list ping port)
  rconHost: string;                     // default "127.0.0.1"
  rconPort: number;                     // default 25575
  rconPassword: string;                 // default ""
  /** World dir name under /data, used by backups. Default "world". */
  worldDir: string;
  /** mineui-server-utils base URL; null = enrichment disabled. */
  serverUtilsUrl: string | null;
};

type ScheduleKind = "interval" | "daily" | "weekly";
type Weekday =
  | "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday";

/** When a scheduled job fires. Times are local wall-clock, "HH:MM" 24 h. */
type Schedule =
  | { kind: "interval"; everyHours: number }            // 1–168
  | { kind: "daily"; time: string }                      // "HH:MM"
  | { kind: "weekly"; weekday: Weekday; time: string };  // "HH:MM"

type ScheduledJobKind = "restart" | "backup" | "broadcast";

type ScheduledJob = {
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

type SchedulerSettings = {
  /** Master switch; false pauses every job without losing them. Default true. */
  enabled: boolean;
  jobs: ScheduledJob[];                 // max 32
};

type BackupSettings = {
  /** Newest snapshots to keep after every backup (manual or scheduled);
   *  0 = unlimited. Default 10. */
  keepLast: number;
  /** Absolute host directory that receives a copy of every new snapshot;
   *  null = off. */
  copyDir: string | null;
};

type Settings = {
  schemaVersion: 2;
  activeMode: Mode;                     // default "simple"
  /** Lowercased command names permitted through run_rcon_command. */
  rconAllowlist: string[];
  /** §6.3 rule 5 escape hatch: permit download_mod URLs on loopback/private
   *  hosts (homelab LAN downloads). Default false = SSRF hardening on. */
  allowPrivateDownloadHosts: boolean;
  simple: SimpleModeSettings;
  advanced: AdvancedModeSettings;
  /** Added in 2.5.0 (serde default; no schemaVersion bump). */
  scheduler: SchedulerSettings;
  /** Added in 2.5.0 (serde default; no schemaVersion bump). */
  backups: BackupSettings;
};
```

Default `rconAllowlist` (identical to v1 default):

```
["list", "whitelist", "op", "deop", "ban", "pardon", "banlist",
 "kick", "say", "save-all", "stop", "tps"]
```

### 2.2 Rust struct sketch (mineui-core::settings)

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub schema_version: u32,            // always 2 after load
    pub active_mode: Mode,              // #[serde(rename_all = "lowercase")] enum
    pub rcon_allowlist: Vec<String>,
    pub allow_private_download_hosts: bool, // default false (§6.3 rule 5)
    pub simple: SimpleModeSettings,
    pub advanced: AdvancedModeSettings,
    pub scheduler: SchedulerSettings,       // 2.5.0, #[serde(default)]
    pub backups: BackupSettings,            // 2.5.0, #[serde(default)]
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SchedulerSettings { pub enabled: bool, pub jobs: Vec<ScheduledJob> }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduledJob {
    pub id: String,
    pub kind: ScheduledJobKind,         // #[serde(rename_all = "lowercase")]
    pub enabled: bool,
    pub schedule: Schedule,             // #[serde(tag = "kind", rename_all = "camelCase")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BackupSettings { pub keep_last: u32, pub copy_dir: Option<PathBuf> }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SimpleModeSettings {
    pub instance_dir: PathBuf,
    pub mc_version: String,
    pub memory_mb: u32,
    pub java_path: Option<PathBuf>,
    pub eula_accepted: bool,
    pub server_port: u16,
    pub rcon_port: u16,
    pub rcon_password: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdvancedModeSettings {
    pub runtime: RuntimeKind,           // #[serde(rename_all = "lowercase")]
    pub socket_path: Option<String>,
    pub runtime_binary: Option<PathBuf>,
    pub container_name: String,
    pub query_host: String,
    pub query_port: u16,
    pub rcon_host: String,
    pub rcon_port: u16,
    pub rcon_password: String,
    pub world_dir: String,
    pub server_utils_url: Option<String>,
}
```

All `Option<T>` fields serialize as `null`, matching the TS `| null` types
(no `skip_serializing_if` — the wire shape must be stable).

### 2.3 Validation (enforced in `settings::validate`, error `SETTINGS_INVALID`)

- Ports: 1–65535. `simple.serverPort != simple.rconPort`.
- `simple.memoryMb >= 512`.
- `advanced.containerName` matches `^[a-zA-Z0-9][a-zA-Z0-9_.-]*$` (container-runtime
  name grammar — this plus argv-array exec is the injection defense).
- `advanced.worldDir` is a single path segment: no `/`, `\`, `..`, not empty.
- `advanced.serverUtilsUrl`, if non-null: parses as URL, scheme http/https.
- `simple.instanceDir` absolute path.
- `rconAllowlist` entries lowercased, trimmed, non-empty, no whitespace.
- `scheduler.jobs`: at most 32; `id` matches `^[A-Za-z0-9-]{1,64}$` and is unique;
  `schedule.everyHours` in 1–168; `time` matches `^([01][0-9]|2[0-3]):[0-5][0-9]$`;
  `message`, when non-null, is 1–200 chars with no control characters; a
  `broadcast` job requires a non-null message; a `backup` job's message is
  normalized to null.
- `backups.keepLast` in 0–1000. `backups.copyDir`, if non-null, is an absolute path
  (existence is checked at copy time, not at save time).

### 2.4 Migration from v1

Schema versioning: on load, if `schemaVersion` is missing or < 2, migrate then rewrite
the file. Unknown future versions → `SETTINGS_INVALID` (never silently truncate).

v1 import (best effort, one-time, optional): if `settings.json` does not exist yet and
`./.cursor/mineui-settings.json` exists **in the process cwd**, import it into
`advanced.*` and set `activeMode: "advanced"`:

| v1 key                      | v2 field                    |
| --------------------------- | --------------------------- |
| MINECRAFT_CONTAINER_NAME    | advanced.containerName      |
| MINECRAFT_QUERY_HOST        | advanced.queryHost          |
| MINECRAFT_QUERY_PORT        | advanced.queryPort          |
| PODMAN_SOCKET               | advanced.socketPath         |
| PODMAN_BINARY               | advanced.runtimeBinary (and runtime: "podman") |
| MINECRAFT_WORLD_DIR         | advanced.worldDir           |
| MINECRAFT_RCON_HOST         | advanced.rconHost           |
| MINECRAFT_RCON_PORT         | advanced.rconPort           |
| MINECRAFT_RCON_PASSWORD     | advanced.rconPassword       |
| MINECRAFT_RCON_ALLOWLIST    | rconAllowlist (split on ",") |
| MINEUI_SERVER_UTILS_URL     | advanced.serverUtilsUrl (empty string → null) |

Unparseable/absent v1 file → fall through to defaults silently (import is best effort).
The v1 file is left in place, never deleted.

### 2.5 Server profiles (2.6.0)

A *server profile* is one managed Minecraft server: a name plus a full, independent
`Settings` (§2.1) and its own state files. The profile list lives in
`<app-config-dir>/servers.json` (atomic write, `0o600`), owned by `mineui-core::hub`:

```ts
type ServerProfile = {
  /** Stable, core-generated, path-safe: ^[a-z0-9][a-z0-9-]{0,31}$. */
  id: string;
  /** Display name, 1–40 chars, trimmed, no control characters, unique
   *  case-insensitively across profiles. */
  name: string;
};

// servers.json
type ServerIndex = {
  schemaVersion: 1;
  /** The profile commands target when they carry no serverId (§3.0); also the
   *  profile the UI opens on. Always names an existing profile. */
  activeServerId: string;
  servers: ServerProfile[];             // 1–16, order = display order
};
```

Storage layout — the first profile keeps the pre-2.6.0 paths, so upgrading moves
nothing and a downgrade still finds its files:

| Profile | Settings file | State dir (`scheduler-state.json`, `player-notes.json`, `audit-log.jsonl`, `tmp/`, default `instances/default`) |
| --- | --- | --- |
| `default` | `<app-config-dir>/settings.json` | `<app-data-dir>/` |
| any other id | `<app-config-dir>/servers/<id>/settings.json` | `<app-data-dir>/servers/<id>/` |

Rules:

- A missing `servers.json` means exactly one profile: `{ id: "default", name:
  "Default" }`, active. The file is written on first load. The `default` profile
  always exists (it is re-inserted first if a hand-edited file drops it) and cannot
  be removed; it can be renamed.
- Unknown future `schemaVersion`, invalid JSON, an invalid or duplicate id, or more
  than 16 profiles → `SETTINGS_INVALID` at startup (never silently truncate). An
  `activeServerId` naming no profile falls back to `default`.
- All profiles are **live at once**: each has its own supervisor, refcounted log
  stream, advanced-mode phase poller state and scheduler, and scheduled jobs run for
  every profile regardless of which one the UI is showing.
- Profiles are isolated: nothing in one profile's `Settings` is read by another.
  The only cross-profile logic is the port suggestion in `add_server` (§3.12).

---

## 3. Command table (complete invoke surface)

Naming: snake_case command names; one `#[tauri::command]` per row in `src-tauri`,
each a thin delegate to the listed `mineui-core` function. Args objects are passed as a
single `args` parameter unless the command takes none. "Mode" = which `activeMode`
the command works in; calling a command outside its mode rejects with `WRONG_MODE`.

### 3.0 Server targeting (2.6.0)

Every command in §3.1–§3.11 accepts one extra optional argument, `serverId: string
| null`, alongside the args listed in its row (it is omitted from the tables below):

- `serverId` set → the command runs against that profile's core. Unknown id →
  `SERVER_NOT_FOUND`.
- `serverId` null/absent → the command runs against `activeServerId` (§2.5).

"Mode" and `activeMode` in every row below mean the **targeted profile's** mode.
`src-tauri` resolves the profile with `hub.core(server_id)` and then delegates to
the same core function as before; core functions keep their `&Core` signature — a
`Core` *is* one profile. The frontend always sends the id (`app/lib/ipc.ts` keeps
the current target, §7); the null fallback exists for robustness, not for use.

### 3.1 Settings & environment

| Command | Args | Returns | Mode | Core fn | v1 route |
| --- | --- | --- | --- | --- | --- |
| `get_settings` | — | `Settings` | both | `settings::load` | GET /api/settings |
| `set_settings` | `{ settings: Settings }` | `Settings` (normalized) | both | `settings::save` | POST /api/settings |
| `detect_runtimes` | — | `RuntimeProbe` | both | `runtime::detect` | — (new) |
| `java_check` | — | `JavaCheck` | both | `java::check` | — (new) |

Notes:

- `get_settings` returns the full settings **including** `rconPassword` fields — this is
  a local desktop app and the settings UI must round-trip them. Never log them.
- `set_settings` validates (§2.3), persists atomically (write temp + rename), re-chmods
  0600, and returns the normalized result. Changing `activeMode` takes effect
  immediately for subsequent commands; it does not stop a running managed server.
- `detect_runtimes` probes `podman --version` and `docker --version` (argv arrays).
- `java_check` resolves `simple.javaPath` override → `JAVA_HOME/bin/java` → `java` on
  PATH; parses `java -version` stderr. `requiredMajor` comes from the current instance
  metadata (`mineui-instance.json`, §3.6) when present, else `null` and
  `compatible: null`.

```ts
type RuntimeProbe = {
  podman: { binary: string; version: string } | null;
  docker: { binary: string; version: string } | null;
  /** What "auto" would pick right now: podman if present, else docker, else null. */
  resolved: "podman" | "docker" | null;
};

type JavaCheck = {
  found: boolean;
  path: string | null;
  version: string | null;       // e.g. "21.0.4"
  majorVersion: number | null;  // e.g. 21
  requiredMajor: number | null; // from instance metadata, if an instance exists
  compatible: boolean | null;   // null when requiredMajor unknown
};
```

### 3.2 Server state, lifecycle, status

| Command | Args | Returns | Mode | Core fn | v1 route |
| --- | --- | --- | --- | --- | --- |
| `get_server_state` | — | `ServerState` | both | `lifecycle::state` | GET /api/server/state |
| `start_server` | — | `void` | both | `lifecycle::start` | POST /api/server/start |
| `stop_server` | — | `void` | both | `lifecycle::stop` | POST /api/server/stop |
| `restart_server` | — | `void` | both | `lifecycle::restart` | POST /api/server/restart |
| `get_server_status` | — | `ServerStatus` | both | `status::get` | GET /api/status |

```ts
type ServerPhase =
  | "not-created" // advanced: container doesn't exist; simple: no instance
  | "stopped"
  | "starting"    // simple mode only (supervisor-tracked)
  | "running"
  | "stopping"    // simple mode only
  | "crashed";    // simple mode only (nonzero exit not initiated by stop)

type ServerState = {
  mode: Mode;
  phase: ServerPhase;
  /** Present when mode === "advanced". */
  container: {
    exists: boolean;
    id: string | null;
    status: string | null;     // raw runtime status string
    createdAt: string | null;  // as reported by runtime
    startedAt: string | null;  // ISO 8601, from inspect
  } | null;
  /** Present when mode === "simple". */
  process: {
    pid: number | null;
    startedAt: string | null;  // ISO 8601
    lastExitCode: number | null;
  } | null;
};

type ServerStatus = {
  online: boolean;
  version: string | null;
  motd: string | null;
  players: { online: number; max: number; sample: { name: string }[] };
  pingMs: number | null;
  /** Where the answer came from. */
  source: "query" | "server-utils" | "none";
  error: string | null; // set when online === false
};
```

Semantics:

- **Advanced**: `state` = runtime `ps --all --filter name=^<name>$ --format json`
  (argv array). Phase mapping: not exists → `not-created`; running → `running`; else
  `stopped` (container runtimes don't expose starting/stopping reliably).
  `start/stop/restart` = runtime `start`/`stop`/`restart <name>`.
- **Simple**: supervisor (`supervisor::Supervisor`) owns the child process.
  `start_server` preconditions: instance exists (`INSTANCE_NOT_FOUND`),
  `eulaAccepted` (`EULA_NOT_ACCEPTED`), java compatible (`JAVA_NOT_FOUND` /
  `JAVA_INCOMPATIBLE`), not already running (`SERVER_RUNNING`). Before spawn, core
  re-asserts RCON config in `server.properties` (§3.6) and `eula.txt` (`eula=true`).
  Spawn: `<java> -Xms<memoryMb>M -Xmx<memoryMb>M -jar server.jar nogui` with cwd =
  `instanceDir`, stdout/stderr piped. Phase `starting` until stdout matches
  `]: Done (` → `running`. `stop_server` writes `stop\n` to stdin, phase `stopping`;
  if the process hasn't exited after 30 s, kill it. Exit while not `stopping` →
  `crashed`. `restart_server` = stop (await exit) then start.
- `get_server_status` (both modes): if `advanced.serverUtilsUrl` is set (advanced mode
  only), try server-utils `/status` + `/metrics` + `/mods` enrichment first, exactly
  like v1 `GET /api/status` (max-players from properties, version from the
  `minecraft` mod entry). Otherwise/simple: Minecraft **server list ping** against
  `queryHost:queryPort` (advanced) or `127.0.0.1:simple.serverPort` (simple),
  3 s timeout. Failure resolves `{ online: false, source: "none", error }` — it does
  **not** reject (matches v1 UX where offline is a normal state).

### 3.3 Logs

| Command | Args | Returns | Mode | Core fn | v1 route |
| --- | --- | --- | --- | --- | --- |
| `get_logs` | `{ tail?: number }` | `{ lines: string[] }` | both | `logs::tail` | GET /api/logs |
| `start_log_stream` | — | `void` | both | `logs::stream_start` | — (new) |
| `stop_log_stream` | — | `void` | both | `logs::stream_stop` | — (new) |

- `tail` default 200, clamped to [10, 1000] (v1 behavior).
- Advanced: `runtime logs --tail N <name>` for `get_logs`; the stream spawns
  `runtime logs --follow --tail 0 <name>` and emits `mineui://logs` events (§4).
- Simple: supervisor keeps an in-memory ring buffer of the last 2000 lines;
  `get_logs` reads the buffer; the stream emits every new line as it arrives.
- `start_log_stream`/`stop_log_stream` are **refcounted** in core: multiple views can
  subscribe; the follow subprocess (advanced) is spawned on 0→1 and killed on 1→0.
  Calling `stop` more times than `start` is a no-op, not an error.

### 3.4 Players & RCON

| Command | Args | Returns | Mode | Core fn | v1 route |
| --- | --- | --- | --- | --- | --- |
| `get_players` | — | `PlayersResult` | both | `players::online` | GET /api/rcon/players |
| `get_player_history` | — | `{ users: PlayerHistoryRow[] }` | both | `players::history` | GET /api/rcon/users |
| `run_rcon_command` | `{ command: string }` | `{ output: string }` | both | `rcon::run_allowlisted` | POST /api/rcon/command |

```ts
type PlayersResult = { players: string[]; raw: string };

type PlayerHistoryRow = {
  username: string;
  lastSeenEpochMs: number | null; // epoch ms; frontend formats (v1 sent a locale string — dropped)
  ipAddress: string | null;
  isOnline: boolean;
};
```

Semantics:

- RCON endpoint per mode: advanced → `advanced.rconHost:rconPort` with
  `advanced.rconPassword`; simple → `127.0.0.1:simple.rconPort` with
  `simple.rconPassword`. Connection failure → `RCON_UNAVAILABLE`.
- `run_rcon_command`: trim, strip leading `/`, reject empty or > 200 chars
  (`INVALID_INPUT`); first whitespace-delimited token lowercased must be in
  `rconAllowlist` else `RCON_COMMAND_BLOCKED` (message includes the allowlist,
  comma-joined). One connection per call (connect, auth, send, close) — same as v1.
- Response framing (2.6.0): after the exec packet the client sends an empty
  `SERVERDATA_RESPONSE_VALUE` (type 0) packet; every Minecraft server answers it
  with `Unknown request 0` under that packet's id, which marks the end of the
  command's output. Output is the concatenation of every response packet carrying
  the exec id before that marker (capped at 256 KiB). This is required for modded
  servers: **Forge sends no packet at all for a command with empty output** (`say`),
  where vanilla/Fabric send one empty packet, and long output (mod lists) spans
  several 4096-byte packets. A server that never answers the marker is tolerated:
  once output has arrived the client waits 1 s for the marker, then returns what it
  has. No output and no marker within 5 s → `RCON_UNAVAILABLE`.
- `get_player_history`: RCON `list` for online set, then parse
  `logs/latest.log` (+ rotated `latest.log.1` if the primary read succeeds but you want
  parity: v1 read both; keep both). Log acquisition: advanced →
  `runtime exec <name> tail -n 4000 /data/logs/latest.log` (argv array, **no `sh -c`**);
  simple → read `<instanceDir>/logs/latest.log` directly. Parse the v1 line patterns
  (login with IP, login without IP, joined/left the game, UUID announcement), strip
  ANSI. **Fix the v1 regex bugs**: the v1 source double-escaped `\\s`, `\\d`,
  `\\[Not Secure\\]` inside regex *literals*, so join/left/`[Not Secure]` variants never
  matched; v2 patterns must match `[Not Secure]`-prefixed lines and use real `\d`/`\s`
  classes. Timestamps: log lines carry `[HH:MM:SS]`; resolve against the local date
  (yesterday if > 60 s in the future) and return **epoch ms only**.

### 3.5 Mods & plugins

| Command | Args | Returns | Mode | Core fn | v1 route |
| --- | --- | --- | --- | --- | --- |
| `list_mods` | — | `ModsList` | both | `mods::list` | GET /api/mods |
| `upload_mod` | `{ sourcePath: string; target: ModTarget }` | `{ filename: string }` | both | `mods::upload` | POST /api/mods/upload |
| `download_mod` | `{ url: string; filename?: string; target: ModTarget }` | `{ filename: string; downloadId: string }` | both | `mods::download` | POST /api/mods/download |
| `delete_mod` | `{ filename: string; target: ModTarget }` | `void` | both | `mods::delete` | POST /api/mods/delete |

```ts
type ModTarget = "mods" | "plugins";
type ModLoader = "forge" | "neoforge" | "fabric" | "unknown";

type ModEntry = {
  name: string;        // display name derived from filename (v1 rules)
  filename: string;
  sizeBytes: number;
  updatedAtEpochMs: number; // epoch ms (v1 sent unix seconds — normalized to ms)
  loader: ModLoader;
};

type ModsList = { mods: ModEntry[]; plugins: ModEntry[] };
```

Semantics:

- Roots: advanced → `/data/mods`, `/data/plugins` in the container; simple →
  `<instanceDir>/mods`, `<instanceDir>/plugins` on the host (created on demand).
  Simple mode manages the files but a vanilla jar will not load mods — the frontend
  shows an informational note; the commands still work (`WRONG_MODE` is NOT used here).
- `list_mods` advanced: `runtime exec <name> find /data/mods -maxdepth 1 -type f -printf %f|%s|%T@\n`
  is NOT portable; instead use two argv-array execs per dir: `ls -1 <dir>` then
  `stat -c %n|%s|%Y` per batch — implementer's choice of exact exec strategy, but the
  constraint is absolute: **argv arrays only, never `sh -c` with interpolated strings**.
  (Static, constant `sh -c` scripts with zero interpolation are permitted.)
- `upload_mod`: `sourcePath` is a host filesystem path obtained by the frontend via the
  Tauri dialog plugin (there is no multipart upload in v2). Validate the *basename* of
  `sourcePath` per §6.2, then advanced → `runtime cp <src> <name>:<root>/<filename>`;
  simple → `std::fs::copy`. Source hardening (the webview must not be able to
  exfiltrate arbitrary readable host files by pointing `sourcePath` at them):
  canonicalize `sourcePath` (symlinks resolved) and require the **resolved** path to
  be a regular file whose name still ends in `.jar`/`.zip` (case-insensitive), with a
  512 MiB size cap (`FILE_TOO_LARGE`; other violations `INVALID_INPUT`). Symlinks are
  therefore accepted only when their target is itself a regular `.jar`/`.zip`. The
  copy uses the canonical path; the stored filename still derives from the
  user-picked basename per §6.2.
- `download_mod`: URL validation per §6.3. **Download happens host-side in Rust
  (reqwest) to a temp file** — never `curl` inside the container (this designs out the
  v1 `sh -c` injection). Emits `mineui://download-progress` events with
  `kind: "mod"` (§4.3); on completion places the file like `upload_mod`. Size cap
  256 MB (`FILE_TOO_LARGE`).
- `delete_mod`: filename per §6.2; advanced →
  `runtime exec <name> rm -f -- <root>/<filename>`; simple → `std::fs::remove_file`.

### 3.6 Simple-mode instance management (`WRONG_MODE` outside simple, except `list_mc_versions`)

| Command | Args | Returns | Mode | Core fn | v1 route |
| --- | --- | --- | --- | --- | --- |
| `list_mc_versions` | `{ includeSnapshots?: boolean }` | `McVersion[]` | both (2.6.0: container creation, §3.13, picks from it too) | `mojang::list_versions` | — (new) |
| `create_instance` | `CreateInstanceArgs` | `InstanceStatus` | simple | `instance::create` | — (new) |
| `delete_instance` | `{ confirm: true }` | `void` | simple | `instance::delete` | — (new) |
| `instance_status` | — | `InstanceStatus` | simple | `instance::status` | — (new) |

```ts
type McVersion = {
  id: string;                     // "1.21.6"
  type: "release" | "snapshot" | "old_beta" | "old_alpha";
  releaseTime: string;            // ISO 8601 from manifest
  latest: boolean;                // matches manifest.latest.release / .snapshot
};

type CreateInstanceArgs = {
  mcVersion: string;
  /** Must be true; also persisted to settings.simple.eulaAccepted and eula.txt. */
  acceptEula: boolean;
  memoryMb?: number;              // default settings.simple.memoryMb
};

type InstanceStatus = {
  exists: boolean;
  instanceDir: string;
  mcVersion: string | null;
  requiredJavaMajor: number | null;
  jarSha1: string | null;
  eulaAccepted: boolean;          // eula.txt on disk says eula=true
  rconConfigured: boolean;        // server.properties has enable-rcon + port + password
  worldExists: boolean;
  createdAt: string | null;       // ISO 8601
};
```

Semantics:

- One instance per server profile (at that profile's `settings.simple.instanceDir`);
  no instance ids anywhere in the API. Several managed servers = several profiles
  (§2.5), each with its own instance dir and ports.
- `list_mc_versions`: fetch
  `https://piston-meta.mojang.com/mc/game/version_manifest_v2.json`; filter to
  `release` unless `includeSnapshots`; cache in memory for 15 minutes; network failure
  with warm cache → serve cache, otherwise `DOWNLOAD_FAILED`.
- `create_instance` sequence (each failure uses the listed code, partial dirs cleaned up
  best-effort):
  1. `acceptEula !== true` → `EULA_NOT_ACCEPTED`.
  2. Instance already initialized (has `mineui-instance.json`) → `INSTANCE_EXISTS`.
  3. Resolve version in manifest → `INVALID_INPUT` if unknown; fetch the per-version
     JSON; read `downloads.server.{url,sha1,size}` and `javaVersion.majorVersion`.
  4. `java_check` against that major → `JAVA_NOT_FOUND` / `JAVA_INCOMPATIBLE`.
     (Report, don't bundle — no JRE download this phase.)
  5. Download server jar to `<instanceDir>/server.jar` with
     `mineui://download-progress` events (`kind: "server-jar"`); verify sha1 →
     `CHECKSUM_MISMATCH` on mismatch (file removed).
  6. Write `eula.txt` (`eula=true`), generate `rconPassword` if
     `settings.simple.rconPassword` is empty (24-char alphanumeric, CSPRNG), write
     `server.properties` with at minimum:
     `enable-rcon=true`, `rcon.port=<rconPort>`, `rcon.password=<password>`,
     `broadcast-rcon-to-ops=false`, `server-port=<serverPort>`, `enable-status=true`.
     (On every subsequent simple-mode `start_server`, core re-asserts these keys,
     preserving all other user-edited keys.)
  7. Write `mineui-instance.json`:
     `{ "mcVersion", "jarSha1", "requiredJavaMajor", "createdAt" }` and persist
     `settings.simple.mcVersion`, `memoryMb`, `eulaAccepted: true`.

  Instance layout (fixed):

  ```
  <instanceDir>/
    mineui-instance.json
    server.jar
    eula.txt
    server.properties
    logs/latest.log        (created by the server)
    world/                 (created by the server)
    mods/  plugins/        (managed by §3.5; vanilla ignores them)
    backups/               (§3.8)
  ```

- `delete_instance`: requires `confirm: true` (`INVALID_INPUT` otherwise) and server
  stopped (`SERVER_RUNNING`). Recursively deletes `instanceDir` **only if** it contains
  `mineui-instance.json` (safety latch against deleting an arbitrary configured dir);
  otherwise `INSTANCE_NOT_FOUND`. Clears `settings.simple.mcVersion` to `""`.

### 3.7 Config file editor

| Command | Args | Returns | Mode | Core fn | v1 route |
| --- | --- | --- | --- | --- | --- |
| `list_config_files` | — | `{ files: string[] }` | both | `config_files::list` | GET /api/config/list |
| `read_config_file` | `{ path: string }` | `{ content: string }` | both | `config_files::read` | POST /api/config/read |
| `write_config_file` | `{ path: string; content: string }` | `void` | both | `config_files::write` | POST /api/config/write |

- Paths in this API are **relative, forward-slash** (`server.properties`,
  `config/foo/bar.toml`) — validated per §6.1. The v1 API used absolute `/data/...`
  paths; the frontend port must switch to relative (the UI only ever displayed them).
- Roots: advanced → `/data` in the container; simple → `<instanceDir>` on the host.
  `list_config_files` returns `server.properties` (if present) plus every allowed file
  under `config/`, sorted.
- Advanced I/O — **no shell, ever** (this is the v1 injection being designed out):
  - list: `runtime exec <name> find /data/config -type f` (argv array), filter in Rust.
  - read: `runtime exec <name> cat <abs-path>` where `<abs-path>` is the validated,
    core-constructed absolute path passed as a single argv element.
  - write: write `content` to a host temp file, then
    `runtime cp <tmpfile> <name>:<abs-path>`. No base64-through-shell.
- Simple I/O: plain `std::fs` under `instanceDir`, after the same §6.1 validation.
- Write cap: 1,500,000 bytes (`FILE_TOO_LARGE`) — v1 parity.

### 3.8 Backups

| Command | Args | Returns | Mode | Core fn | v1 route |
| --- | --- | --- | --- | --- | --- |
| `create_backup` | — | `BackupEntry` | both | `backups::create` | POST /api/backup |
| `list_backups` | — | `BackupEntry[]` | both | `backups::list` | — (new) |
| `restore_backup` | `{ filename: string }` | `void` | both | `backups::restore` | — (new) |
| `delete_backup` | `{ filename: string }` | `void` | both | `backups::delete` | — (new) |

```ts
type BackupEntry = {
  filename: string;          // world-YYYYMMDD-HHMMSS.tar.gz
  sizeBytes: number;
  createdAtEpochMs: number;
};
```

- Backup dir: advanced → `/data/backups` (container); simple → `<instanceDir>/backups`.
  World source: advanced → `/data/<worldDir>`; simple → `<instanceDir>/world`.
- Filenames are always generated by core (`world-<timestamp>.tar.gz`). Commands taking
  `filename` validate: basename only, matches `^world-[0-9]{8}-[0-9]{6}\.tar\.gz$`,
  else `INVALID_INPUT`. (Strict pattern > sanitization.)
- `create_backup`: advanced → argv-array execs `mkdir -p /data/backups` then
  `tar -czf /data/backups/<file> -C /data <worldDir>`; simple → host-side tar.gz via
  Rust (`tar` + `flate2`). Allowed while running (crash-consistent snapshot; frontend
  may advise `save-all` first — not enforced).
- `list_backups`: advanced → exec `ls`/`stat` argv pattern as in §3.5; simple → readdir.
- `restore_backup`: **requires server stopped** (`SERVER_RUNNING`). Sequence: rename
  current world dir to `<worldDir>.pre-restore-<timestamp>` (kept, not deleted), then
  extract the archive into the data root. Missing archive → `INVALID_INPUT`.
- `delete_backup`: removes the archive file.
- **Retention (2.5.0)**: after every successful `create_backup` — manual or scheduled —
  core lists the backup dir and deletes the oldest archives beyond
  `settings.backups.keepLast` (0 = unlimited). The archive just written is never
  pruned. Each pruned file is recorded in the audit log (`backup.prune`); prune
  failures never fail the backup.
- **Off-box copy (2.5.0)**: when `settings.backups.copyDir` is non-null, the new
  archive is copied to `<copyDir>/<filename>` (simple → host copy through a
  `.tmp` sibling + rename; advanced → `runtime.cp_from(<container>:/data/backups/<file>)`
  into the same tmp + rename). The copy runs after the backup succeeds; a copy
  failure is recorded in the audit log (`backup.copy`, `ok: false`) and does **not**
  fail the backup or change its return value.

### 3.9 Metrics

| Command | Args | Returns | Mode | Core fn | v1 route |
| --- | --- | --- | --- | --- | --- |
| `get_metrics` | — | `Metrics` | both | `metrics::get` | GET /api/server/metrics |

```ts
type IoPair = { inputBytes: number | null; outputBytes: number | null };

type Metrics = {
  /** "container" (advanced runtime stats) or "process" (simple sysinfo). */
  base: "container" | "process";
  /** True when server-utils enrichment was applied. */
  enriched: boolean;
  cpuPercent: number | null;
  mem: {
    usedBytes: number | null;
    totalBytes: number | null;  // container limit / JVM RSS ceiling n/a → host total
    percent: number | null;
  };
  net: IoPair | null;           // container-only unless enriched
  block: IoPair | null;         // container-only unless enriched
  disk: { usedBytes: number | null; totalBytes: number | null; percent: number | null } | null;
  startedAt: string | null;     // ISO 8601 (v1 sent raw podman StartedAt text — normalized)
  uptimeSeconds: number | null;
  tps: { one: number; five: number; fifteen: number; raw: string } | null;
  mspt: { one: number | null; five: number | null; fifteen: number | null } | null;
  chunks: number | null;        // server-utils only
  entities: number | null;      // server-utils only
  dimensions: Record<string, { chunks: number | null; entities: number | null }> | null;
  players: { online: number | null; max: number | null } | null;
};
```

- Never rejects for "server offline": returns nulls with the correct `base`. Rejects
  only for hard faults (`RUNTIME_NOT_FOUND`, `CONTAINER_NOT_FOUND`, `IO`).
- Advanced base: `runtime stats --no-stream --format json <name>` (cpu, mem, net,
  block; parse podman/docker unit strings in Rust) + `inspect -f {{.State.StartedAt}}`
  + disk via argv exec of `df -k /data` (fixed argv, parse in Rust).
- Simple base: process CPU%/RSS via `sysinfo` for the supervised pid; disk = usage of
  `instanceDir` volume; `startedAt` from supervisor.
- Enrichment (advanced + `serverUtilsUrl` set): server-utils `/metrics` — tps, mspt,
  chunks, entities, dimensions, and container/system overrides exactly per v1
  precedence (container > system > runtime-stats). Unreachable server-utils degrades
  silently to base (matches v1).
- TPS fallback (both modes, when not enriched): RCON `tps` parsed with
  `TPS from last 1m, 5m, 15m: (\d+\.?\d*), (\d+\.?\d*), (\d+\.?\d*)` — note the v1
  parser's regex was double-escaped and never matched; v2 must use real character
  classes. Vanilla has no `tps` command → `tps: null` (not an error).

### 3.10 Scheduler (2.5.0)

| Command | Args | Returns | Mode | Core fn | v1 route |
| --- | --- | --- | --- | --- | --- |
| `get_scheduler_status` | — | `SchedulerStatus` | both | `scheduler::status` | — (new) |
| `run_scheduled_job_now` | `{ id: string }` | `JobRunResult` | both | `scheduler::run_now` | — (new) |

```ts
type JobRunResult = { epochMs: number; ok: boolean; message: string | null };

type ScheduledJobStatus = {
  id: string;
  /** null when the job or the scheduler is disabled. */
  nextRunEpochMs: number | null;
  lastRun: JobRunResult | null;
};

type SchedulerStatus = { enabled: boolean; jobs: ScheduledJobStatus[] };
```

Semantics:

- Job definitions live in `settings.scheduler` (§2). Run state lives in
  `<app-data-dir>/scheduler-state.json` (`{ [jobId]: { lastRun: JobRunResult } }`),
  written atomically; unknown ids are dropped on the next write.
- The engine is `scheduler::tick(core)`, driven by a 30 s timer in `src-tauri`
  (next to the §4.2 poller). A tick computes each enabled job's next due time from
  its schedule and fires it when `now >= due`. Anchor for `interval` jobs is
  `lastRun.epochMs`, or app start when there is none; `daily`/`weekly` are wall-clock
  in the local timezone. A due time that passed while the app was closed does
  **not** fire retroactively.
- Jobs run one at a time (a mutex); a job still running when its next slot arrives
  is skipped for that slot.
- `restart`: requires phase `running` else the run is recorded as
  `ok: false, message: "server not running"`. With a non-null `message`, core sends
  `say <message>` via RCON, waits 60 s, then calls `lifecycle::restart`.
- `backup`: calls `backups::create` (retention + copy included). Advanced mode
  requires the container running (exec), else recorded as skipped like above.
- `broadcast`: requires phase `running`; sends `say <message>` via `rcon::run`
  (internal path, no allowlist — the message is validated at settings save).
- Every run appends an audit entry (§3.11) with `source: "scheduler"`.
- `run_scheduled_job_now` runs the job immediately regardless of its schedule or
  `enabled` flag (the scheduler master switch is also ignored), records the result
  as `lastRun`, and returns it. Unknown id → `INVALID_INPUT`.

### 3.11 Player notes & audit log (2.5.0)

| Command | Args | Returns | Mode | Core fn | v1 route |
| --- | --- | --- | --- | --- | --- |
| `get_player_notes` | — | `{ notes: PlayerNote[] }` | both | `notes::list` | — (new) |
| `set_player_note` | `{ username: string; note: string }` | `PlayerNote \| null` | both | `notes::set` | — (new) |
| `get_audit_log` | `{ limit?: number }` | `{ entries: AuditEntry[] }` | both | `audit::recent` | — (new) |

```ts
type PlayerNote = { username: string; note: string; updatedAtEpochMs: number };

type AuditSource = "user" | "scheduler";

type AuditEntry = {
  id: string;               // uuid v4
  epochMs: number;
  source: AuditSource;
  /** Dotted action name, see the list below. */
  action: string;
  /** What was acted on: username, filename, config path, command… */
  target: string | null;
  /** Free text: the RCON command, the job id, a byte count… */
  detail: string | null;
  ok: boolean;
  /** `ErrorCode: message` when ok is false. */
  error: string | null;
};
```

- Notes: `<app-data-dir>/player-notes.json`, `{ [usernameLower]: PlayerNote }`,
  atomic write (§2 pattern, 0600). `username` matches `^[A-Za-z0-9_]{1,16}$`
  (`INVALID_INPUT` otherwise) and is stored as typed but keyed lowercase; `note` is
  trimmed, ≤ 2000 chars; an empty note deletes the entry and returns `null`.
  Setting a note appends `note.set` / `note.clear` to the audit log.
- Audit log: `<app-data-dir>/audit-log.jsonl`, append-only, one entry per line.
  When the file exceeds 5 MB it is renamed to `audit-log.jsonl.1` (one generation
  kept) and a fresh file is started. `get_audit_log` returns the newest `limit`
  entries (default 200, max 1000) newest first, reading `.1` only if the primary has
  fewer than `limit` lines. Audit writes never fail the action they describe.
- Actions recorded (core writes them; `src-tauri` stays thin):
  `server.start`, `server.stop`, `server.restart`, `rcon.command` (target = first
  token, detail = full command), `player.<verb>` for `kick`/`ban`/`pardon`/`op`/
  `deop`/`whitelist` issued through `run_rcon_command` (target = username),
  `backup.create`, `backup.restore`, `backup.delete`, `backup.prune`, `backup.copy`,
  `config.write`, `mod.upload`, `mod.download`, `mod.delete`, `settings.update`,
  `instance.create`, `instance.delete`, `note.set`, `note.clear`,
  `scheduler.restart`, `scheduler.backup`, `scheduler.broadcast`,
  `server.add`, `server.rename`, `server.remove` (§3.12), `container.create` (§3.13).

### 3.12 Server profiles (2.6.0)

These commands act on the profile list itself and take **no** `serverId` targeting
argument (§3.0 does not apply); where a row lists `id`, it is the profile acted on.

| Command | Args | Returns | Mode | Core fn | v1 route |
| --- | --- | --- | --- | --- | --- |
| `list_servers` | — | `ServerList` | both | `Hub::list` | — (new) |
| `add_server` | `{ name: string; mode?: Mode }` | `ServerList` | both | `Hub::add` | — (new) |
| `rename_server` | `{ id: string; name: string }` | `ServerList` | both | `Hub::rename` | — (new) |
| `remove_server` | `{ id: string; confirm: true }` | `ServerList` | both | `Hub::remove` | — (new) |
| `set_active_server` | `{ id: string }` | `ServerList` | both | `Hub::set_active` | — (new) |
| `get_servers_overview` | — | `ServerOverview[]` | both | `Hub::overview` | — (new) |

```ts
type ServerList = { activeServerId: string; servers: ServerProfile[] };

type ServerOverview = {
  id: string;
  name: string;
  mode: Mode;
  /** null when the phase could not be read (see `error`). */
  phase: ServerPhase | null;
  /** Same value `get_server_status` returns for this profile. */
  status: ServerStatus;
  /** `ErrorCode: message` when the phase probe failed (e.g. no runtime). */
  error: string | null;
  /* Identity — what this profile actually points at, so two servers with
     similar names can be told apart at a glance. */
  /** Advanced: `advanced.containerName`. Simple: null. */
  containerName: string | null;
  /** `host:port` of the game port: advanced `queryHost:queryPort`, simple
   *  `127.0.0.1:serverPort`. */
  address: string;
  /** Lowercased server type. Simple: "vanilla". Advanced: the container's
   *  `TYPE` env (itzg convention: "forge", "fabric", "paper", …), null when
   *  the container is missing or has no `TYPE`. */
  loader: string | null;
  /** Simple: the instance's version, null before one exists. Advanced: the
   *  container's `VERSION` env, null when absent or `LATEST` (the frontend
   *  then falls back to `status.version` while the server is online). */
  mcVersion: string | null;
};
```

Semantics:

- `add_server`: validates `name` (§2.5, `INVALID_INPUT`), rejects a 17th profile
  (`INVALID_INPUT`), mints an id (8 lowercase hex chars, unique), creates the
  profile's settings file with defaults and `activeMode = mode ?? "advanced"`, and
  appends it to the list. Port suggestion: the new profile's
  `simple.serverPort`/`advanced.queryPort` and `simple.rconPort`/`advanced.rconPort`
  are set to the first `25565 + n` / `25575 + n` pair (n ≥ 0) that no existing
  profile's settings use, so two managed servers never start on the same ports by
  default. It does **not** change `activeServerId`. Returns the new list; the new
  profile is the last entry.
- `rename_server`: name rules as above; unknown id → `SERVER_NOT_FOUND`.
- `remove_server`: `confirm !== true` → `INVALID_INPUT`; `id === "default"` →
  `INVALID_INPUT`; a simple-mode server process still supervised → `SERVER_RUNNING`.
  Stops the profile's log stream, drops it from the list and deletes
  `<app-config-dir>/servers/<id>/` (its settings). The state dir
  `<app-data-dir>/servers/<id>/` — which holds a simple-mode world by default — is
  **left on disk**; removing a profile never deletes a world, a container or a
  backup. If the removed profile was active, `default` becomes active.
- `set_active_server`: persists `activeServerId`; unknown id → `SERVER_NOT_FOUND`.
- `get_servers_overview`: one entry per profile, in list order, probed
  concurrently. `phase` is the §3.2 phase (advanced: runtime `ps`; simple:
  supervisor/instance check); `status` is `status::get`. Never rejects for a
  per-profile fault — the fault lands in that entry's `error`. `loader`/`mcVersion`
  of an advanced profile come from `runtime inspect` of the container's env,
  cached per container id (re-read only when the container is recreated).
- Audit (§3.11): `server.add` (target = name) goes to the new profile's log,
  `server.rename` (target = new name) to the renamed profile's, and `server.remove`
  (target = name) to `default`'s, since the removed profile's log is orphaned. A
  rejected `server.add`, or a `server.rename` of an unknown id, is recorded in
  `default`'s log.

### 3.13 Container creation (2.6.0)

Until 2.6.0 advanced mode could only attach to a container the user had already
made. `create_container` makes one: an
[`itzg/minecraft-server`](https://github.com/itzg/docker-minecraft-server) container
for the targeted profile, with the loader the user picks.

| Command | Args | Returns | Mode | Core fn | v1 route |
| --- | --- | --- | --- | --- | --- |
| `create_container` | `{ args: CreateContainerArgs }` | `ServerState` | advanced | `provision::create` | — (new) |

```ts
type ContainerLoader =
  | "vanilla" | "fabric" | "forge" | "neoforge" | "paper" | "quilt" | "purpur";

type CreateContainerArgs = {
  loader: ContainerLoader;
  /** A Mojang version id ("1.21.1") or "LATEST". */
  mcVersion: string;
  /** Becomes `advanced.containerName`; §2.3 container-name grammar. */
  containerName: string;
  /** JVM heap for the server, MiB, 512–65536. */
  memoryMb: number;
  /** Host port published for the game (container 25565). */
  gamePort: number;
  /** Host port published for RCON (container 25575). Always loopback-only. */
  rconPort: number;
  /** true: the game port is published on every interface (LAN/internet play).
   *  false: on 127.0.0.1 only. */
  exposeToNetwork: boolean;
  /** Must be true — the image refuses to start without EULA=TRUE. */
  acceptEula: boolean;
};
```

Sequence (first failure wins; nothing is created before step 7):

1. Profile not in advanced mode → `WRONG_MODE`.
2. `acceptEula !== true` → `EULA_NOT_ACCEPTED`.
3. Validation (`INVALID_INPUT`): `containerName` per §2.3; `mcVersion` trimmed, empty
   or any-case "latest" → `LATEST`, otherwise `^[0-9A-Za-z][0-9A-Za-z._-]{0,31}$`;
   `memoryMb` in 512–65536; ports 1–65535 and different from each other.
4. Resolve the runtime (`RUNTIME_NOT_FOUND`).
5. A container with that name already exists → `CONTAINER_EXISTS` (attach to it in
   settings instead — this command never touches an existing container).
6. Either host port cannot be bound right now → `INVALID_INPUT` ("port N is already
   in use"). Checked host-side with a throwaway listener; the runtime's own check
   in step 7 remains the authority.
7. Pick the image tag from the Java the version needs — `javaVersion.majorVersion`
   of the Mojang version detail (the latest release for `LATEST`): ≤ 8 → `java8`,
   9–17 → `java17`, 18–21 → `java21`, 22–25 → `java25`, anything else or an
   unresolvable version → `latest`. Then one argv-array runtime call:

   ```
   run -d --name <containerName>
       --env-file <tmpfile>
       -p <bind>:<gamePort>:25565      # bind = 0.0.0.0 or 127.0.0.1
       -p 127.0.0.1:<rconPort>:25575
       -v <containerName>-data:/data
       docker.io/itzg/minecraft-server:<tag>
   ```

   The env file (`<app-data-dir>/tmp/`, `0o600`, deleted right after the call) holds
   `EULA=TRUE`, `TYPE=<LOADER>`, `VERSION=<mcVersion>`, `MEMORY=<memoryMb>M`,
   `ENABLE_RCON=true` and `RCON_PASSWORD=<generated>` (24-char alphanumeric, CSPRNG,
   same generator as §3.6) — the password never appears in an argv. The runtime
   pulls the image if it is missing, so the first call can take minutes; the
   command resolves when the container has *started*, not when the server inside
   is ready (the image installs the loader on first boot — watch the log stream).
   Non-zero exit → best-effort `rm -f <containerName>` of the half-made container
   (safe: step 5 proved it was not there before), then `CONTAINER_CREATE_FAILED`
   with the runtime's stderr. The `<containerName>-data` volume is never removed;
   if one already exists it is reused, world included.
8. Save the profile's settings: `advanced.containerName`, `queryHost`/`rconHost` =
   `127.0.0.1`, `queryPort`/`rconPort`, `rconPassword`, `worldDir` = `world`.
9. Return `lifecycle::state`; a `mineui://server-state` transition follows from the
   §4.2 poll.

Audited as `container.create` (target = container name, detail =
`<LOADER> <mcVersion> <image>:<tag>`). There is deliberately no `delete_container`:
removing a container and its world stays a deliberate act outside the app.

---

## 4. Event contract

Events are emitted by `src-tauri` (core exposes callbacks/channels; the Tauri layer
forwards to `app.emit`). All events are app-global (no per-window targeting).
Frontend subscribes with `listen()` from `@tauri-apps/api/event` via the typed helpers
in `app/lib/ipc.ts` (§7).

**Server scoping (2.6.0)**: every event payload below additionally carries
`serverId: string` — the profile (§2.5) it came from — flattened into the payload
object (`{ serverId, ...payload }`). Core emits `HubEvent { serverId, event }`;
`src-tauri` serializes it as `ServerScoped<T>`. The `on*` helpers in §7 deliver only
the events of the profile that was the IPC target when the helper was called;
`onAnyServerState` delivers every profile's transitions.

### 4.1 `mineui://logs`

Emitted only while at least one log stream is active (§3.3). Batched: the emitter
flushes at most every 100 ms or 50 lines, whichever first.

```ts
type LogSource = "stdout" | "stderr" | "runtime"; // runtime = podman/docker logs stream
type LogLine = { text: string; epochMs: number; source: LogSource };
type LogsEvent = { lines: LogLine[] };
```

Lifecycle: view mounts → `await startLogStream(); const un = await onLogs(cb)`;
view unmounts → `un(); await stopLogStream()`. `get_logs` provides backfill before
subscribing; duplicate lines across the backfill/stream seam are acceptable (frontend
may dedupe by `epochMs + text`, not required).

### 4.2 `mineui://server-state`

Emitted on every phase transition, in both modes, for every profile. Advanced-mode
transitions are detected by a core-side poll of all advanced-mode profiles (every
2 s while any frontend window exists) plus
immediately after `start_server`/`stop_server`/`restart_server` resolve.

```ts
type ServerStateEvent = {
  mode: Mode;
  phase: ServerPhase;
  previousPhase: ServerPhase;
  epochMs: number;
  /** Simple mode, phase === "crashed" | "stopped": the exit code if known. */
  exitCode: number | null;
};
```

The event is a change notification; `get_server_state` remains the source of truth for
full detail. Frontend pattern: fetch state on mount, subscribe for invalidation.

### 4.3 `mineui://download-progress`

Emitted for server-jar downloads (`create_instance`) and mod downloads
(`download_mod`). Throttled to ≥ 150 ms between progress events per download; the
terminal event (`done` or `error`) is always emitted.

```ts
type DownloadKind = "server-jar" | "mod";

type DownloadProgressEvent = {
  downloadId: string;          // uuid, unique per download
  kind: DownloadKind;
  filename: string;
  url: string;
  receivedBytes: number;
  totalBytes: number | null;   // null when Content-Length absent
  done: boolean;
  /** Set on terminal failure; the owning command also rejects with the same code. */
  error: { code: ErrorCode; message: string } | null;
};
```

`download_mod` returns its `downloadId`; `create_instance` does not (its jar download
is identified by `kind: "server-jar"` — only one can run at a time, enforced by
`INSTANCE_EXISTS`).

Subscription lifecycle (all events): `listen()` returns an unlisten fn; every page/hook
that subscribes MUST unlisten on unmount. Events carry no secrets.

---

## 5. Mode semantics table

| Feature | Simple (managed) | Advanced (attach) |
| --- | --- | --- |
| start/stop/restart | supervisor (stdin `stop`, kill after 30 s) | runtime start/stop/restart |
| Server state phases | full: starting/running/stopping/crashed | not-created/stopped/running only |
| Status ping | SLP on `127.0.0.1:serverPort` | SLP on `queryHost:queryPort` |
| server-utils enrichment (status/metrics) | — (setting is advanced-scoped) | when `serverUtilsUrl` set |
| Logs: initial fetch | supervisor ring buffer (2000 lines) | `runtime logs --tail` |
| Logs: live stream | native (stdout/stderr pipes) | `runtime logs --follow` subprocess |
| RCON (players, history, commands) | full — auto-configured at create/start | full — user-supplied credentials |
| Player history log source | `<instanceDir>/logs/latest.log` | exec `tail` in container |
| Mods/plugins management | file ops work; **vanilla jar loads none** (UI note) | full |
| Config editor | host fs under `instanceDir` | exec/cp in container |
| Backups create/list/restore/delete | host-side tar | argv-exec tar in container |
| Metrics base | process CPU/RSS via sysinfo | container stats via runtime |
| Metrics net/block IO | null (unless future enrichment) | from runtime stats |
| TPS | RCON `tps` (vanilla: null) | RCON `tps` or server-utils |
| Instance commands (§3.6) | full | `WRONG_MODE` |
| `detect_runtimes`, `java_check` | available (java relevant) | available (runtime relevant) |
| Container create/pull | — | `create_container` makes an itzg/minecraft-server container (§3.13); attaching to an existing one still works; never deletes one |

---

## 6. Validation rules (enforced in mineui-core, error codes as noted)

### 6.1 Config-editor paths (`PATH_NOT_ALLOWED`)

Input is a relative, `/`-separated path. Accept iff ALL hold:

1. Non-empty, ≤ 512 chars, valid UTF-8, no NUL, no `\` (backslashes rejected, not
   normalized).
2. Not absolute; no segment equal to `.` or `..`; no empty segments (`//`).
3. After joining to the mode's root, **lexically canonicalize and verify the result is
   still under the root** (defense in depth over rule 2). For simple mode also
   `fs::canonicalize` the parent on write and re-check (symlink escape defense);
   advanced mode relies on rules 1–3 since container paths can't be canonicalized
   from the host.
4. Whitelist: exactly `server.properties`, or under `config/`.
5. Extension allowlist (case-insensitive): `.json .json5 .properties .txt .toml .ini
   .yml .yaml .conf .cfg .snbt` (v1 set + yaml/conf/cfg/snbt, added because modded
   servers use them; frontier files like `.jar` remain excluded).
6. The path is passed to runtime exec/cp as a single argv element — never interpolated
   into a shell string. (Global rule: the only `sh -c` permitted anywhere in v2 is a
   compile-time-constant script with zero interpolation, and prefer plain argv even then.)

### 6.2 Mod/plugin filenames (`INVALID_INPUT`)

Applied to the basename in `upload_mod`, `download_mod`, `delete_mod`:

1. Take `basename` only; reject if it differs from input for `delete_mod`
   (i.e. delete input must already be a bare filename).
2. Sanitize (upload/download only): replace every char outside `[A-Za-z0-9._+()-]`
   with `_` (v1 rule, kept).
3. Post-sanitization: non-empty, ≤ 255 bytes, does not start with `.` or `-`, not
   `..`, ends with `.jar` or `.zip` (case-insensitive).
4. `target` must be exactly `"mods"` or `"plugins"`.

### 6.3 URL downloads (`INVALID_INPUT` / `DOWNLOAD_FAILED`)

1. Parses as URL; scheme `http` or `https` only. No credentials in URL
   (`user:pass@` rejected).
2. Filename = explicit `filename` arg, else basename of URL path, else reject
   (`INVALID_INPUT` — no `mod.jar` default; v1's silent default is dropped).
   Then §6.2 applies.
3. Download host-side (reqwest), follow ≤ 5 redirects, each redirect re-checked for
   http/https (and, when rule 5 applies, for public host), 60 s idle timeout, 256 MB
   cap streamed to temp file, then moved/copied into place. Non-2xx final status →
   `DOWNLOAD_FAILED`.
4. Mojang manifest/jar downloads additionally verify the manifest-provided SHA-1
   (`CHECKSUM_MISMATCH`).
5. SSRF hardening (`INVALID_INPUT`), skipped when
   `settings.allowPrivateDownloadHosts` is true: the URL host must not be — or, for
   hostnames, must not resolve exclusively to — a loopback/private/link-local/
   unique-local/unspecified address (IPv4 127/8, 10/8, 172.16/12, 192.168/16,
   169.254/16, 0.0.0.0; IPv6 ::1, ::, fc00::/7, fe80::/10, plus IPv4-mapped forms).
   Hostname resolution happens at validation time (`ToSocketAddrs`); the
   validation-vs-request TOCTOU window (DNS rebinding) is mitigated by a strict
   redirect policy that re-validates every redirect hop's host with the same rule
   (`download::build_public_client`). Unresolvable host → `DOWNLOAD_FAILED`. Mojang
   server-jar downloads always use the strict client (their URLs come from the
   HTTPS manifest and content is SHA-1 pinned).

### 6.4 RCON commands

See §3.4: trim, strip one leading `/`, ≤ 200 chars, first token lowercased ∈
`rconAllowlist`.

---

## 7. `app/lib/ipc.ts` — single typed IPC module

One file, generated by the frontend agent **verbatim from this section**. It is the
only file importing `@tauri-apps/api/core` / `@tauri-apps/api/event`. Everything above
in §§1–4 is re-stated here as the exact code to ship (types identical; if a mismatch
is discovered, this section and the section above must be fixed together).

```ts
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
};

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
```

Frontend rules:

- Pages import only from `app/lib/ipc.ts`; no raw `invoke`, no locally re-declared IPC
  types, no `fetch("/api/…")` remnants.
- Server targeting (§3.0, 2.6.0): pages never pass a `serverId`. `ipc.ts` holds the
  one current target; `app/components/ServerProvider.tsx` is the only caller of
  `setIpcTargetServer`, and it moves the target only while the routed page is
  unmounted (switch = unmount page → move target → remount page keyed by server
  id). That ordering is what lets a page's cleanup (`stopLogStream`, unlisten) reach
  the server it was opened for. Event helpers bind to the target at subscribe time.
- v1 shape changes the port must absorb: timestamps are now epoch-ms numbers
  (`lastSeenEpochMs`, `updatedAtEpochMs`, `createdAtEpochMs`) — format client-side;
  config paths are relative; players/users routes merged shapes as in §3.4;
  offline status/metrics are values, not thrown errors.

---

## 8. mineui-core module map (for the Rust agent)

| Module | Owns |
| --- | --- |
| `error` | `Error` enum + serde serialization to `{code,message}` (§1) |
| `settings` | load/save/validate/migrate (§2), atomic write + 0600 |
| `runtime` | `trait Runtime` (state, start, stop, restart, logs, follow_logs, exec(argv), cp_to, cp_from, stats, inspect_started_at, inspect_env, run_detached, remove_force) + `PodmanCli`/`DockerCli` impls + `detect`. All subprocess calls use arg arrays via `std::process::Command`/tokio — **no shell strings anywhere in the crate** |
| `supervisor` | simple-mode child process: spawn, stdin stop, kill-after-30s, phase machine, log ring buffer, state-change + log callbacks |
| `rcon` | RCON client (connect/auth/send/close) + allowlist enforcement |
| `query` | Minecraft server-list-ping client (handshake + status packet, 3 s timeout) |
| `mojang` | version manifest fetch/cache, per-version json, jar download + sha1 verify, progress callback |
| `java` | java discovery + `-version` parsing |
| `instance` | create/delete/status, `mineui-instance.json`, eula.txt, server.properties RCON assertion (preserving user keys) |
| `mods` | list/upload/download/delete over `Runtime` or host fs (§3.5, §6.2–6.3) |
| `config_files` | list/read/write over `Runtime` or host fs (§3.7, §6.1) |
| `backups` | create/list/restore/delete (§3.8) |
| `metrics` | container/process metrics + tps fallback (§3.9) |
| `status` | SLP + server-utils composition (§3.2) |
| `serverutils` | HTTP client for mineui-server-utils `/status` `/metrics` `/mods` |
| `players` | online list + history log parsing (§3.4, with the fixed regexes) |
| `logs` | tail + refcounted stream fan-in from supervisor/runtime |
| `scheduler` | job engine: due-time math, 30 s tick, run state file, `status`/`run_now` (§3.10) |
| `audit` | append-only JSONL audit log + rotation, `recent` (§3.11) |
| `notes` | per-player notes store (§3.11) |
| `provision` | `create_container` (§3.13): validation, Java → image tag, env file, run, settings write-back |
| `identity` | per-profile identity for the overview (§3.12): one `ps` for the phase + cached container `TYPE`/`VERSION` |
| `hub` | server profiles (§2.5, §3.12): `servers.json`, one `Core` per profile, `core(server_id)` lookup, server-scoped event fan-in (`HubEvent`), `poll_all` / `tick_all`, `overview` |

`src-tauri` contains: one command fn per §3 row (thin delegation — resolve the
targeted profile's `Core` via `hub.core(server_id)`, §3.0, then call the listed core
fn), event forwarding (`HubEvent` → `app.emit` of `ServerScoped<T>`), the 2 s
advanced-mode state poller (`Hub::poll_all`), the 30 s scheduler tick
(`Hub::tick_all`, §3.10), and path-resolver
wiring (`app_config_dir`, `app_data_dir`) injected into core at startup. No business
logic, no validation, no subprocess calls in `src-tauri`.
