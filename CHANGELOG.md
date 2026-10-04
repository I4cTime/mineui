# Changelog

All notable changes to MineUI are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [2.10.0] - 2026-10-04

### Added

- **Change the Minecraft version of a plain (Simple) server without losing
  the world.** Server Settings → Performance & network → *Change version…*:
  MineUI downloads the server for the version you pick, backs the world up
  first, and switches in place. The server has to be stopped. Moving to an
  *older* version needs an extra tick, because an older Minecraft usually
  cannot open a world saved by a newer one.
- **Sounds card in App Settings:** a volume slider and a choice of four sound
  sets - the original *Classic* plus *Blocks* (chiptune), *Glass* (soft
  bells) and *Terminal* (relay ticks and beeps) - each with a Preview button.
  The new sets are synthesized (no samples) and matched in loudness to the
  original, so switching sets does not make the app louder or quieter.
- **About card in App Settings:** the version and platform, where MineUI
  keeps its files (copy the path or open the folder), links to the website,
  changelog and issue tracker, and a *Check for updates* button. MineUI never
  checks on its own; pressing the button asks GitHub for the newest release
  and sends nothing about you or your servers.
- **Browse… buttons** for the backup copy folder (a folder picker) and the
  Java location; **Open folder** for a Simple server's files.
- Five new IPC commands: `change_instance_version`, `get_app_info`,
  `check_for_update`, `open_url`, `open_app_dir` (52 total).

### Changed

- Links that leave the app (EULA, install guides, the About links) now open
  through an allowlisted command in the system browser - `https` only, a
  fixed list of hosts - instead of relying on the webview's handling of
  `target="_blank"`, which is not dependable on every platform.

## [2.9.0] - 2026-10-03

A full review of every screen and flow ("does this make sense to someone
running a server for friends?") plus light mode. Nothing here changes saved
settings or worlds.

### Added

- **Light mode.** App Settings → Appearance has a new *Mode* choice - Dark,
  Light, or Match system - that works with every style: Deepslate becomes
  *Calcite & Emerald*, Phosphor a warm *paper console*, Quantum *Daybreak*,
  Soft Glass warm paper and terracotta. Each light palette was checked
  numerically for text contrast (WCAG AA or better everywhere, including
  status chips). An accent override that would be unreadable on a light
  ground is shown darker in light mode; your pick is kept for dark mode.
  Dark stays the default, so nothing changes until you choose it.
- **"The server is stopped - Start it" where it matters.** Players, Console,
  Status and Backups say what state the server has to be in and carry the
  button, instead of an empty list or a raw connection error.
- **Unsaved-changes protection.** Server Settings and the config editor ask
  before you leave the page or switch servers with unsaved edits.

### Changed

- **The Simple/Advanced toggle is gone from the header.** One unlabelled click
  re-pointed a server at the other kind, which looked exactly like the server
  had been deleted. How a server is run now lives under *Advanced* in Server
  Settings, is refused while the server is running, and asks first - saying
  that nothing is deleted or moved.
- **Server Settings is reorganised by how often things are needed:** This
  server (rename it right there), Performance & network, Scheduled tasks,
  Backups, a collapsed *Advanced* section (connection details, console
  command rules, downloads from your own network, how the server is run) and
  a Danger zone. Every field says what it does in plain words. One *Unsaved
  changes - Discard / Save* bar replaces the Save buttons that sat in
  unrelated cards; it names what is wrong before you save. The container name
  is locked behind *Change…* (editing it silently pointed MineUI at nothing),
  and the RCON password can be revealed.
- **Dashboard status is one statement:** Online, Starting up… (running but
  not answering yet - the minutes a modpack needs on first start), Starting…,
  Stopping…, Stopped or Crashed, with a sentence saying what to expect and the
  address players join at. Start/Stop/Restart are only enabled when they make
  sense, say what actually happened ("is starting…", not "Start completed"),
  and Stop/Restart ask first when players are online.
- **Players:** Whitelist, Kick and Ban up front, Make admin / Remove admin /
  Unban in a menu, each explained and confirmed in its own words; the result
  shown is the server's own reply. A stopped server keeps your notes visible
  and editable.
- **Console** (was "RCON Tools"): says what it is, shows which commands are
  allowed, keeps a transcript with Up/Down recall, confirms `stop`.
- **Backups:** shows how many are kept and that older ones are deleted
  automatically, whether a second copy is set up, and which backup retention
  removed after a new one. Restore shows the backup's date and size and says
  what it rolls back and where the current world is kept.
- **Status:** "Players can join", game speed (TPS) explained with its
  1/5/15-minute averages, rings coloured by what good means, rows that can
  never have a value hidden, the activity log in plain words.
- **Mods:** restart-to-apply banner with the button after adding or deleting
  on a running server, a warning when a mod is made for another loader.
- **Create and Add-server flows** speak in user terms ("Modded or modpack
  server", "Plain Minecraft server", "A container I already run"), explain
  the EULA and RCON, say why *Create* is disabled, and give Java install
  advice for every OS.
- **Deleting a Simple server's files** ("Delete instance") now says it
  deletes every backup stored with the world, requires the server's name
  typed, and is unavailable while the server runs.
- `create_backup` returns the files retention removed; `get_player_history`
  returns `rconAvailable`; new error code `RUNTIME_UNAVAILABLE`.

### Fixed

- **Backups and mods of a stopped container server were invisible** - the
  page said "No backups yet" although restoring *requires* the server to be
  stopped. Listing and deleting now work while the container is stopped, and
  a listing that fails is shown as an error, never as an empty list.
- **Config editor could save one file's text into another.** Selecting a file
  switched the name immediately while the editor still held the previous
  file's text (for good, if the read failed) and Save stayed enabled. The
  editor and Save are now off until the opened file's own text has loaded, a
  failed read is shown with *Try again*, late reads of a previously clicked
  file are ignored, and switching files with unsaved edits asks first.
- **Player notes could not be edited** (the pencil did nothing).
- **"Install Podman or Docker" shown when one is installed but not running**
  (Docker Desktop closed, `podman machine` stopped): MineUI now says the
  runtime is installed but not responding, and how to start it. The *Runtime
  binary override* now also works while the runtime setting is on Auto, as
  the help text always claimed.
- The Console's `ops` preset was blocked by the default allowlist; presets
  are now built from the commands that are allowed.
- **Linux AppImage: "Podman or Docker is needed, and neither was found" on a
  machine that has Podman.** The AppImage launcher points `LD_LIBRARY_PATH`
  at its bundled libraries, and its `libseccomp.so.2` is older than the
  system's, so every `podman` call died with `undefined symbol:
  seccomp_export_bpf_mem`. Child processes (podman, docker, java) now get a
  clean environment inside an AppImage. The .deb was not affected.

## [2.8.0] - 2026-10-03

### Added

- **CurseForge modpacks from a zip**: the create-container flow's *A modpack*
  step has a third source, *CurseForge zip* - the file the CurseForge app
  makes with *Export profile* (`manifest.json` + `overrides/`). MineUI reads
  the pack's name, Minecraft version and loader from the manifest
  (`inspect_modpack_zip`), copies the zip into the container before its first
  start, and the image downloads the listed mods and applies the overrides.
  Packs for Minecraft 1.16 and older are refused: the Java 8 image has no
  CurseForge API key.

## [2.7.3] - 2026-10-02

### Fixed

- **Windows + Podman (WSL) in rootful mode: the server stays Offline even on
  2.7.2.** A rootful machine publishes ports with NAT rules rather than a
  listening socket, and WSL's localhost relay mirrors listening sockets only,
  so Windows never reaches them - confirmed on a tester's machine. MineUI now
  detects a rootful WSL machine and the Status page says so, with the fix
  (`podman machine stop; podman machine set --rootful=false; podman machine
  start`, then create the server again - the two modes have separate
  container stores) and the VM address the server answers at meanwhile.

## [2.7.2] - 2026-10-02

### Fixed

- **Windows: config files of a container server could not be opened**
  (`cat: '\data\config\fml.toml': No such file or directory`). Paths inside
  the container were joined with the host's separator; they are now always
  `/`-separated.
- **Windows + Podman (WSL): the server stayed "Offline" with no RCON although
  the log said Done.** A "keep on this computer" server was published on
  `127.0.0.1` *inside the Podman machine*, which Windows cannot reach - WSL's
  localhost relay only forwards ports bound on all of the machine's
  interfaces. On the WSL provider the ports are now published without a host
  address and arrive on the Windows host's own `127.0.0.1`. Hyper-V and
  Docker Desktop are unaffected. Servers created with 2.7.1 or earlier on
  WSL need to be deleted and created again.
- The Status page now says *why* the server is offline (the probe's error,
  e.g. "ping timed out (127.0.0.1:25566)") instead of only "No".

## [2.7.1] - 2026-10-02

### Fixed

- **Windows: no more flashing terminal windows.** Every `podman`/`docker`/
  `java` call MineUI makes is now spawned without a console window; before,
  the status poll opened and closed one several times a second.
- **Creating a container on Podman machines without `pids` delegation**
  (seen on WSL: `crun: controller pids is not available under
  /sys/fs/cgroup/non-systemd/…`). Podman's default pids limit (2048) cannot
  be applied there; when the runtime says so, MineUI removes the half-made
  container and creates it once more with no pids limit, as Docker would.
  Nothing else is retried.

## [2.7.0] - 2026-10-02

### Added

- **Modpack servers**: when MineUI creates a container you can now choose
  *A modpack* instead of a server type. Search Modrinth in the app (only
  packs that can run on a server are listed, most downloaded first) or paste
  a CurseForge pack's page address or slug, pick the Minecraft version, and
  the server starts with the pack's loader and mods installed. No API key is
  needed for either source. Memory defaults to 6144 MB for a pack. Servers
  made from a pack are identified by it ("cobblemon-fabric 1.21.1 · Modrinth
  pack · …"). A modpack is applied when the container is created; there is
  no way to put one onto an existing server.
- **Unpack a zip of mods** (Mods → Add mod or plugin): when the file you
  pick or link to is a `.zip`, the dialog asks whether it is several mods or
  one. For several, MineUI unpacks the `.jar` files inside and installs them
  in one go - from a zipped folder of mods, or from the `mods` folder of a
  server pack - and lists what went in and how many other files were left
  out. This is how to put a set of mods onto a server that already exists.
  Configs in the zip are not installed. A launcher modpack file (Modrinth
  `.mrpack`-style or a CurseForge export) is recognized and pointed at
  *create from a modpack* instead. Limits: 500 jars, 256 MiB each, 2 GiB in
  total, counted on what the zip actually unpacks to.
- **Install instructions for Podman and Docker**: wherever a container
  runtime is needed and neither is installed - the create-container flow,
  the dashboard of a container server, Server Settings - MineUI shows the
  steps for Linux, Windows and macOS with copyable commands, opening on your
  OS, and a *Check again* button. Previously the dashboard showed a generic
  "Backend unavailable" error. The same steps are in the README.
- **Delete a container from MineUI**: a failed or unwanted container server
  no longer has to be cleaned up with the runtime CLI. *Delete container* in
  Server Settings removes the container and keeps the server, so you can
  create it again - the way to switch loader or modpack. *Remove server* in
  App Settings can take the container along with a tick box. Both keep the
  world unless you tick *Also delete its world data* and type the
  container's name; then the data volume (world, configs, mods, backups) is
  deleted too. A world stored in a folder on your computer is never
  deleted. Everything is recorded in the activity log.
- **Back out of an unfinished server**: the create forms (container and
  managed vanilla) have a *Remove this server* button, so a server added by
  mistake, or one you changed your mind about, can be dropped before
  anything is created. The server you have open can now also be removed
  from App Settings → Servers; MineUI then moves to the first server, which
  is the only one that cannot be removed.
- IPC: `search_modpacks`, `unpack_mod_archive`, `delete_container`; `create_container` takes an
  optional `modpack`; the server overview reports `modpack`. Contract §3.5,
  §3.12, §3.13, §3.14, §6.2a.

### Fixed

- **Header overlap at 1200–1280 px**: with a longer server name the nav
  labels ran into the MineUI wordmark and the controls. Labels now appear
  from 1280 px (was 1200), and the server name in the switcher truncates at
  7rem (was 9rem). Checked in all four themes at every tier boundary.

### Changed

- MineUI's "never deletes a container" rule is replaced by "only on an
  explicit, confirmed request". Removing a server still deletes nothing by
  itself.
- The app's content-security policy allows images from `cdn.modrinth.com`
  (modpack icons in search results). Nothing else is loaded from it.
- New dependency: the `zip` crate (reading mod archives).

## [2.6.0] - 2026-10-01

### Added

- **Several servers at once**: MineUI now manages any number of server
  profiles (up to 16) simultaneously - for example a Forge and a Fabric
  container side by side. Each profile has its own mode, connection settings,
  RCON allowlist, scheduled tasks, backup policy, player notes and activity
  log, and scheduled tasks run for every server whether or not it is on
  screen. A server switcher in the header and an *All servers* strip on the
  dashboard show each server's state and player count, with start/stop for
  any of them (the strip shows two rows and scrolls beyond that). Manage the
  list in App Settings → Servers. Removing a server only removes it from
  MineUI; its container, world and backups stay.
- **Create containers from MineUI**: adding a server now offers *New
  container* - MineUI creates an `itzg/minecraft-server` container (Vanilla,
  Paper, Purpur, Fabric, Quilt, Forge or NeoForge; any Minecraft version;
  memory; ports; LAN or local-only), chooses the image tag with the Java that
  version needs, generates the RCON password and attaches to it. Attaching to
  an existing container and the managed vanilla server remain.
- **App Settings** page (sliders button in the header) for what is not about
  one server: the server list, theme and accent.
- Page headers and the server switcher now say what each server actually is -
  "Forge 1.21.1 · mc-forge · 127.0.0.1:25566" - read from the container itself.
- Seven new IPC commands (`list_servers`, `add_server`, `rename_server`,
  `remove_server`, `set_active_server`, `get_servers_overview`,
  `create_container`), an optional `serverId` on every existing command,
  `serverId` on every event, and the `SERVER_NOT_FOUND`, `CONTAINER_EXISTS`
  and `CONTAINER_CREATE_FAILED` error codes; contract §2.5, §3.0, §3.12,
  §3.13, §4.

### Fixed

- **RCON on Forge**: a command with no output (`say`, and with it scheduled
  broadcasts and restart warnings) waited 5 s and was reported as
  `RCON read timed out` even though it ran - Forge sends no reply packet for
  empty output where vanilla and Fabric send an empty one. The client now
  frames every command with a terminator packet.
- RCON output longer than 4096 bytes (large mod or player lists) was cut off
  after the first packet; multi-packet responses are now reassembled.
- Activity log: an entry could still be in flight when the log was re-read
  right after an action, so the newest entry was sometimes missing until the
  next refresh. Appends are now flushed before the action returns.
- A `PressResponder was rendered without a pressable child` console warning
  on every page that mounts a confirmation dialog.

### Changed

- **Settings is now per-server only** and titled "Server Settings";
  Appearance moved to App Settings.
- **Add mod or plugin** dialog (Mods) rebuilt as one flow: choose mod or
  plugin (preselected from what the server runs, with a warning when the
  choice cannot load there), then a link or a file from this computer.
  Fields are labelled and validated before anything is sent, progress and
  errors show inside the dialog, and it stays open listing what was added so
  several files can go in a row.
- Page headers are a single compact row (icon, title, server identity,
  actions) instead of a tall centred block.
- Header controls are grouped: this server (switcher, mode) then the app
  (sound, app settings, Ko-fi).
- `list_mc_versions` works in advanced mode too (the container flow uses it).
- Existing installs upgrade in place: the current server becomes the
  "Default" profile and keeps its files where they are
  (`settings.json`, scheduler state, notes, activity log). Additional servers
  live under `servers/<id>/`. A new `servers.json` holds the list.

## [2.5.0] - 2026-09-26

### Added

- **Scheduled tasks** (Settings → Scheduled tasks): automatic restarts with an
  optional 60 s chat warning, scheduled backups, and timed chat broadcasts.
  Schedules are every N hours, daily at a time, or weekly on a day; each job
  shows its next and last run and has a Run-now button. Jobs run while MineUI
  is open; a slot missed while it was closed is skipped, never run late.
- **Backup retention and off-box copy** (Settings → Backup policy): keep only
  the newest N snapshots (default 10, 0 = unlimited) and copy every new
  snapshot to a directory you choose. Both apply to manual and scheduled
  backups; a failed copy never fails the backup.
- **Player notes** (Players): a private note per player, edited inline.
- **Activity log** (Status): an append-only audit trail of every action taken
  from the app or by the scheduler - server start/stop/restart, player
  actions, RCON commands, backups, config edits, mod changes, settings saves -
  with source, target, outcome and error.
- Five new IPC commands (`get_scheduler_status`, `run_scheduled_job_now`,
  `get_player_notes`, `set_player_note`, `get_audit_log`); contract §3.10,
  §3.11.

### Fixed

- **Linux + NVIDIA + Wayland**: the app crashed before its first frame
  (`Error 71 (Protocol error) dispatching to Wayland display`, WebKitGTK's
  DMA-BUF renderer). MineUI now disables that renderer itself when the NVIDIA
  kernel module is loaded, unless `WEBKIT_DISABLE_DMABUF_RENDERER` is already
  set.
- Two `<Pressable> child must be focusable` console warnings on every page,
  from the Ko-fi popover trigger.

### Changed

- The theme picker moved out of the header into Settings → Appearance, next
  to the accent override, as a card grid with a description per theme.
- Header tooltips now say what each page is for ("Players - Who's on, history
  and notes") and only appear at widths where the nav is icon-only; at full
  width the visible label speaks for itself.
- Tauri 2.12 (tao 0.37 restores GTK's own Wayland decorations; the old
  overlay left title-bar buttons dead), `@tauri-apps/api` / `cli` 2.12.
- Settings gained `scheduler` and `backups` sections with serde defaults -
  existing `settings.json` files load unchanged (no schema bump).

## [2.1.2] - 2026-09-26

### Changed

- Frontend: motion 13.4.2 (from 12.x), React 19.3.0, Next.js 16.3.6,
  HeroUI 3.2.6, HeroUI Pro 1.0.0-beta.10 (KPI now comes from its
  `@heroui-pro/react/kpi` subpath), lucide-react 1.47, MapLibre GL 6.11.1,
  marked 18.0.14, react-resizable-panels 4.13.2. Dev: TypeScript 6.0.3,
  Tauri CLI 2.11.5.
- Rust crates: tauri 2.11.6, rand 0.10.3.
- CI: pnpm/action-setup 6.1.0, CodeQL 4.38.1, dtolnay/rust-toolchain
  refreshed. Dependabot now runs on the first and second Monday of each
  month instead of weekly.

## [2.1.1] - 2026-09-15

### Security

- Dependency refresh clearing every open advisory: Next.js 16.3.5 (two
  critical RCE advisories in the image-optimization API - not reachable in
  the static-export desktop build, but no longer shipped), Tiptap 3.31.3
  (Markdown ReDoS, `mergeAttributes` prototype key), MapLibre GL 6.10
  (sanitizer XSS bypass), and pinned floors for the transitive sharp,
  nanoid, DOMPurify, and Mermaid advisories.

### Changed

- Rust crates: thiserror 2.0.20, async-trait 0.1.92, uuid 1.26.1,
  flate2 1.1.10, tauri-plugin-dialog 2.7.3. HeroUI 3.2.5, lucide-react 1.46,
  react-aria-components 1.21 and other minor/patch frontend bumps.
- CI: pnpm/action-setup 6.0.10, rust-cache 2.9.2, CodeQL 4.37.9.

## [2.1.0] - 2026-08-04

### Added

- **Accent color override**: Settings → Appearance now lets you override the
  theme's accent everywhere in the app - 8 preset swatches plus a full
  custom color picker, persisted locally. Text on accent fills picks
  whichever of the theme's own background/foreground tokens contrasts
  better, so every theme stays readable with any accent.

### Changed

- **New brand**: the app icon and in-app logo are now the "Ore Cube" mark -
  a neon isometric voxel with a glowing core - replacing the old boxed
  pixel-cross icon, matching the refreshed mineui.i4c.studio site.
- The Simple/Advanced mode switch in Settings is now an accessible radio
  group of rich option cards (keyboard arrows flip modes).
- UI sounds re-encoded - same cues, much smaller files.

### Fixed

- **AppImage: UI sounds now actually play.** The AppImage bundles the
  GStreamer media framework, so WebKitGTK audio works regardless of which
  host plugins are installed.

## [2.0.0] - 2026-07-25

### Added

- **Simple mode**: MineUI can now create and run its own vanilla Minecraft
  server - pick a version, accept the EULA, and MineUI downloads the
  official server jar (SHA-1 verified) and supervises the Java process.
  No container required. Requires Java on your system, version-checked
  automatically against the Minecraft release you pick.
- **Docker support** alongside Podman in Advanced mode, with runtime
  auto-detection (Podman tried first, then Docker) and a manual override in
  Settings.
- Four selectable themes - Deepslate & Emerald (default), Phosphor Amber,
  Quantum Fluidity, and Soft Glass - switchable from Settings and persisted
  locally.
- Toast notifications for background actions (downloads, backups, RCON
  results) via HeroUI's Toast.

### Changed

- **Rebuilt on Tauri v2**, replacing the Electron + Next.js API-route
  architecture. The app is now a native Rust binary calling into a
  Next.js static-export frontend over Tauri IPC - smaller install, no
  bundled Chromium runtime, no local HTTP API server.
- Player join/leave history parsing now correctly matches `[Not Secure]`
  chat-signing log lines (previously silently skipped due to a regex bug).
- TPS parsing from RCON output now correctly matches Paper/Spigot's `tps`
  command output (previously silently failed due to a regex bug).
- Config-file editor paths are now relative (`server.properties`,
  `config/...`) instead of absolute container paths.
- Timestamps (player last-seen, mod update time, backup creation) are now
  sent as epoch milliseconds instead of pre-formatted or unix-second
  strings; the UI formats them for display.
- All fonts are now bundled offline (no runtime font requests), across all
  four themes.
- **Relicensed from MIT to AGPL-3.0-only** across `package.json`,
  `src-tauri/Cargo.toml`, `crates/mineui-core/Cargo.toml`, and `LICENSE`.

### Fixed

- Container/host command execution no longer shells out through
  `sh -c` with interpolated strings anywhere in the mod, config-editor, or
  backup code paths - every subprocess call now uses argv arrays, closing
  a class of shell-injection risk that existed in the v1 implementation.

## [1.0.0] - 2026-01

Initial release, distributed as an Electron desktop app wrapping a Next.js
frontend and local API routes.

### Added

- Attach to an existing Minecraft server container via Podman.
- Server control: start, stop, restart.
- Live status (TPS, player count, version) and streamed log viewer.
- Player management: online players, join/leave history, whitelist/op/ban/kick.
- RCON console with an allowlisted command set.
- Mods & plugins browser with upload and URL download.
- `server.properties` and `config/` file editor.
- World backups: create, list, restore, delete.
- System and container metrics (CPU, memory, disk, network/block IO).
- Optional enrichment from a companion server-utilities mod (TPS/MSPT,
  per-dimension chunk/entity counts).
