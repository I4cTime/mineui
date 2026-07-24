# MineUI

A container-first desktop app for managing Minecraft servers. Built with
Tauri v2 (Rust backend) and Next.js (static export frontend).

MineUI v2 has two modes:

- **Simple mode (default)** — MineUI creates and runs a vanilla server for
  you: pick a Minecraft version, set memory, accept the EULA, and MineUI
  downloads the official server jar (SHA-1 verified), configures RCON, and
  supervises the Java process. No containers required.
- **Advanced mode** — attach to an existing Minecraft server container
  managed by **Podman or Docker** (the v1 feature set behind a runtime
  adapter): start/stop/restart, logs, players, RCON, mods/plugins, config
  editing, backups, and container metrics.

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

## Requirements

### Simple mode

- Java 21+ on your PATH (or a Java path override in Settings). Recent
  Minecraft versions require Java 21; MineUI checks compatibility for you.

### Advanced mode

- **Podman** or **Docker** installed
- A Minecraft server container (e.g. created with `podman run` / `docker run`
  or compose). MineUI attaches to an existing container; it does not create one.

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

## Development

Prerequisites: [pnpm](https://pnpm.io) and the
[Tauri v2 toolchain](https://v2.tauri.app/start/prerequisites/) (Rust stable).

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

- Install Java 21+ (e.g. `sudo apt install openjdk-21-jre-headless`)
- Or set a Java path override in Settings

### "RCON unavailable"

- Simple mode configures RCON automatically at instance creation — restart
  the server if you changed ports
- Advanced mode needs `enable-rcon=true` plus matching port/password in your
  server's `server.properties` and MineUI Settings

## License

MIT
[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/K3K11SM7LV)
