# MineUI

The desktop app your containerized Minecraft server has been missing.

MineUI is a container-first desktop app for managing Minecraft servers. It's
built on Tauri v2 (Rust backend) and Next.js (static-export frontend) — no
Electron, no local API server.

MineUI has two modes:

- **Simple mode (default)** — MineUI creates and runs a vanilla server for
  you: pick a Minecraft version, set memory, accept the EULA, and MineUI
  downloads the official server jar (SHA-1 verified), configures RCON, and
  supervises the Java process. No containers required.
- **Advanced mode** — attach to an existing Minecraft server container
  managed by **Docker or Podman** (auto-detected, Podman preferred): start/
  stop/restart, logs, players, RCON, mods/plugins, config editing, backups,
  and container metrics. MineUI attaches to a container that already exists
  (e.g. an `itzg/minecraft-server`-style image with the world/config under
  `/data`) — it does not create or pull one for you.

## Features

- **Server Control** — start, stop, and restart (managed process or container)
- **Live Status** — TPS, MSPT, player count, and server version
- **Live Logs** — streamed log viewer (no polling)
- **Player Management** — online players, history with last-seen and IP, and
  one-click whitelist/op/ban/kick actions
- **RCON Console** — allowlisted command panel
- **Mods & Plugins** — browse, upload from disk, or download from URLs
- **Configuration Editor** — edit `server.properties` and `config/` files
- **World Backups** — create, list, restore, and delete `.tar.gz` snapshots
- **System Metrics** — CPU, memory, disk (plus network/block IO for containers)

## Themes

Pick a theme in Settings; it's saved locally (`data-theme` + localStorage).
See `docs/theme-contract.md` for the token contract behind them.

| Theme | One-liner |
|---|---|
| **Deepslate & Emerald** *(default)* | Deepslate stone, emerald signal — the tool Mojang would ship. |
| **Phosphor Amber** | Near-black ops console with an amber phosphor glow. |
| **Quantum Fluidity** | Deep-space black, cyan signal, violet glow — the I4C look. |
| **Soft Glass** | Calm, rounded, native-grade — one warm apricot accent. |

## Requirements

### Simple mode

- A Java runtime on your PATH (or a Java path override in Settings). MineUI
  reads the required major version per Minecraft release from Mojang's
  manifest and checks your Java against it before letting you start a server
  — recent Minecraft versions require Java 21.

### Advanced mode

- **Docker** or **Podman** installed (MineUI auto-detects; Podman is tried
  first)
- A Minecraft server container already created (e.g. with `podman run` /
  `docker run` or compose) using an `/data`-rooted layout — world, config,
  mods, and plugins under `/data/...`, as used by images like
  `itzg/minecraft-server`. MineUI attaches to it; it does not create one.

## Getting Started

1. **Launch MineUI.**
2. **Simple mode**: the dashboard walks you through creating your server —
   pick a version, set memory, accept the
   [Minecraft EULA](https://aka.ms/MinecraftEULA), and hit Create.
3. **Advanced mode**: open **Settings**, switch to Advanced, pick your
   runtime (Auto tries Podman first, then Docker), and enter your container
   name, query address, and RCON credentials.

Settings are stored by the backend in the platform config directory
(`settings.json`); there are no environment variables to configure.

## Platform support

MineUI is built and tested on **Linux** today (AppImage + `.deb`). Windows
(`nsis`) and macOS (`.dmg`) are configured as Tauri bundle targets but have
not been built, signed, or tested yet — they're pending the first tagged
release. Don't assume a Windows/macOS build works until one has actually
shipped.

## Architecture

- `crates/mineui-core` — pure-Rust business logic (no Tauri dependency),
  84 unit tests.
- `src-tauri` — thin `#[tauri::command]` shell (31 IPC commands) that
  delegates to `mineui-core` and forwards events; no business logic here.
- `app/` — Next.js App Router frontend, static-exported (`output: 'export'`)
  and bundled by Tauri. All backend calls go through typed wrappers in
  `app/lib/ipc.ts` — no raw `invoke()` or `fetch("/api/...")` elsewhere.

The IPC surface (commands, error codes, event payloads) is specified in
[`docs/v2-contract.md`](docs/v2-contract.md); the theme token system is
specified in [`docs/theme-contract.md`](docs/theme-contract.md). Both are
binding contracts, not suggestions — see CONTRIBUTING.md.

## Development

Prerequisites: [pnpm](https://pnpm.io) and Rust via
[rustup](https://rustup.rs) (stable toolchain) — see the
[Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/) for
platform-specific details.

On Linux you also need the WebKit/GTK build dependencies:

```bash
sudo apt install libwebkit2gtk-4.1-dev build-essential libssl-dev librsvg2-dev
```

Then:

```bash
pnpm install
pnpm tauri dev     # runs Next.js dev server + Tauri window
```

Other scripts:

- `pnpm dev` — frontend only, in a plain browser (no backend; IPC calls
  fail soft with a "Backend unavailable" notice)
- `pnpm build` — static export to `out/` (what Tauri bundles)
- `pnpm lint` — ESLint
- `pnpm tauri build` — production desktop bundle
- `cargo test -p mineui-core` — Rust unit tests (84 tests; must stay green)

## Note on HeroUI Pro

The UI uses `@heroui-pro/react` (KPI cards, EmptyState, Stepper, and other
Pro components), which is a **commercially licensed** package from NextUI
Inc. — see its bundled license at
`node_modules/@heroui-pro/react/LICENSE` after install.

**Building MineUI from source requires a HeroUI Pro license.** The npm
package on the public registry is a stub: its postinstall script downloads
the actual components only when it finds an authenticated session
(`npx heroui-pro login`) or an `HEROUI_AUTH_TOKEN` environment variable.
Without either, `pnpm install` appears to succeed but the package is empty
and the build fails to resolve `@heroui-pro/react` imports. Get a license
at [heroui.com/pro](https://heroui.com/pro), or open an issue if the Pro
dependency is blocking a contribution you want to make.

## Optional: MineUI Server Utilities Mod (Advanced mode)

For enriched metrics (accurate TPS/MSPT, per-dimension chunk/entity counts,
host system metrics, detailed mod list), a companion Forge mod is planned.

| Minecraft Version | Forge Version | Status      |
|-------------------|---------------|-------------|
| 1.20.1            | 47.4.x        | Coming soon |

Once installed on your server, set **Server utils URL** in Settings (e.g.
`http://<server-ip>:8787`). Without it, MineUI falls back to the Minecraft
server list ping and container/process metrics — everything else still works.

## Troubleshooting

### "Cannot connect to server" (Advanced)

- Ensure your Minecraft container is running
- Verify the container name in Settings matches (`podman ps` / `docker ps`)
- If you use a non-default socket, set the socket path override

### "No Java found" (Simple)

- Install a JDK matching the version MineUI reports as required (e.g.
  `sudo apt install openjdk-21-jre-headless` for modern Minecraft versions)
- Or set a Java path override in Settings

### "RCON unavailable"

- Simple mode configures RCON automatically at instance creation — restart
  the server if you changed ports
- Advanced mode needs `enable-rcon=true` plus matching port/password in your
  server's `server.properties` and MineUI Settings

## Credits

- Fonts are self-hosted (offline, zero runtime font requests): Inter,
  JetBrains Mono, Space Grotesk, IBM Plex Sans/Mono, Figtree, and Commit
  Mono via [Fontsource](https://fontsource.org) (each under its own
  upstream OFL/MIT license).
- [Monocraft](https://github.com/IdreesInc/Monocraft) by Idrees Hassan,
  vendored at `app/fonts/Monocraft-basic-latin.woff2` under the SIL Open
  Font License — see `app/fonts/Monocraft-LICENSE.txt`.

## License

MIT — see [LICENSE](LICENSE).

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/K3K11SM7LV)
