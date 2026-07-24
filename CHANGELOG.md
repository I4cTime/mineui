# Changelog

All notable changes to MineUI are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [2.0.0-unreleased]

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
