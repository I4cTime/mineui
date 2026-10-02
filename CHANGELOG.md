# Changelog

All notable changes to MineUI are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [2.6.0] - 2026-10-01

### Added

- **Several servers at once**: MineUI now manages any number of server
  profiles (up to 16) simultaneously — for example a Forge and a Fabric
  container side by side. Each profile has its own mode, connection settings,
  RCON allowlist, scheduled tasks, backup policy, player notes and activity
  log, and scheduled tasks run for every server whether or not it is on
  screen. A server switcher in the header and an *All servers* strip on the
  dashboard show each server's state and player count, with start/stop for
  any of them (the strip shows two rows and scrolls beyond that). Manage the
  list in App Settings → Servers. Removing a server only removes it from
  MineUI; its container, world and backups stay.
- **Create containers from MineUI**: adding a server now offers *New
  container* — MineUI creates an `itzg/minecraft-server` container (Vanilla,
  Paper, Purpur, Fabric, Quilt, Forge or NeoForge; any Minecraft version;
  memory; ports; LAN or local-only), chooses the image tag with the Java that
  version needs, generates the RCON password and attaches to it. Attaching to
  an existing container and the managed vanilla server remain.
- **App Settings** page (sliders button in the header) for what is not about
  one server: the server list, theme and accent.
- Page headers and the server switcher now say what each server actually is —
  "Forge 1.21.1 · mc-forge · 127.0.0.1:25566" — read from the container itself.
- Seven new IPC commands (`list_servers`, `add_server`, `rename_server`,
  `remove_server`, `set_active_server`, `get_servers_overview`,
  `create_container`), an optional `serverId` on every existing command,
  `serverId` on every event, and the `SERVER_NOT_FOUND`, `CONTAINER_EXISTS`
  and `CONTAINER_CREATE_FAILED` error codes; contract §2.5, §3.0, §3.12,
  §3.13, §4.

### Fixed

- **RCON on Forge**: a command with no output (`say`, and with it scheduled
  broadcasts and restart warnings) waited 5 s and was reported as
  `RCON read timed out` even though it ran — Forge sends no reply packet for
  empty output where vanilla and Fabric send an empty one. The client now
  frames every command with a terminator packet.
- RCON output longer than 4096 bytes (large mod or player lists) was cut off
  after the first packet; multi-packet responses are now reassembled.
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
  from the app or by the scheduler — server start/stop/restart, player
  actions, RCON commands, backups, config edits, mod changes, settings saves —
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
- Header tooltips now say what each page is for ("Players — Who's on, history
  and notes") and only appear at widths where the nav is icon-only; at full
  width the visible label speaks for itself.
- Tauri 2.12 (tao 0.37 restores GTK's own Wayland decorations; the old
  overlay left title-bar buttons dead), `@tauri-apps/api` / `cli` 2.12.
- Settings gained `scheduler` and `backups` sections with serde defaults —
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
  critical RCE advisories in the image-optimization API — not reachable in
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
  theme's accent everywhere in the app — 8 preset swatches plus a full
  custom color picker, persisted locally. Text on accent fills picks
  whichever of the theme's own background/foreground tokens contrasts
  better, so every theme stays readable with any accent.

### Changed

- **New brand**: the app icon and in-app logo are now the "Ore Cube" mark —
  a neon isometric voxel with a glowing core — replacing the old boxed
  pixel-cross icon, matching the refreshed mineui.i4c.studio site.
- The Simple/Advanced mode switch in Settings is now an accessible radio
  group of rich option cards (keyboard arrows flip modes).
- UI sounds re-encoded — same cues, much smaller files.

### Fixed

- **AppImage: UI sounds now actually play.** The AppImage bundles the
  GStreamer media framework, so WebKitGTK audio works regardless of which
  host plugins are installed.

## [2.0.0] - 2026-07-25

### Added

- **Simple mode**: MineUI can now create and run its own vanilla Minecraft
  server — pick a version, accept the EULA, and MineUI downloads the
  official server jar (SHA-1 verified) and supervises the Java process.
  No container required. Requires Java on your system, version-checked
  automatically against the Minecraft release you pick.
- **Docker support** alongside Podman in Advanced mode, with runtime
  auto-detection (Podman tried first, then Docker) and a manual override in
  Settings.
- Four selectable themes — Deepslate & Emerald (default), Phosphor Amber,
  Quantum Fluidity, and Soft Glass — switchable from Settings and persisted
  locally.
- Toast notifications for background actions (downloads, backups, RCON
  results) via HeroUI's Toast.

### Changed

- **Rebuilt on Tauri v2**, replacing the Electron + Next.js API-route
  architecture. The app is now a native Rust binary calling into a
  Next.js static-export frontend over Tauri IPC — smaller install, no
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
  backup code paths — every subprocess call now uses argv arrays, closing
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
