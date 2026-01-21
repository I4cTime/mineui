# MineUI

A desktop application for managing your local Minecraft server running in Podman.

## Features

- **Server Control** - Start, stop, and restart your Minecraft container
- **Live Status** - View TPS, MSPT, player count, and server version in real-time
- **Player List** - See who's online with live updates
- **Logs Viewer** - Stream server logs with filtering
- **Mods & Plugins** - Browse installed mods/plugins, upload new ones, or download from URLs
- **Configuration Editor** - Edit server configuration files directly
- **Backups** - One-click world backups
- **System Metrics** - CPU, memory, network, and disk usage (requires utility mod)

## Requirements

- **Podman** installed and running
- A Minecraft server container managed by Podman or Podman Compose
- The Podman socket must be accessible (typically at `/run/user/1000/podman/podman.sock`)

## Getting Started

1. **Launch MineUI** - Open the application
2. **Configure Settings** - Go to the **Settings** page and enter your server details:
   - `Container Name` - The name of your Minecraft Podman container (e.g., `minecraft-server`)
   - `Query Host` / `Query Port` - Minecraft query protocol address (default: `localhost:25565`)
   - `Podman Socket` - Path to your Podman socket
   - `RCON` settings - If you want to use RCON commands
3. **Connect** - Navigate to the **Status** page to see your server

## Optional: MineUI Server Utilities Mod

For enhanced metrics and features, you can install the **MineUI Server Utilities** Forge mod on your Minecraft server. This is **strongly recommended** but not required.

### Compatibility

| Minecraft Version | Forge Version | Download |
|-------------------|---------------|----------|
| 1.20.1            | 47.4.x        | [mineui-server-utils.jar](#) |

> **Note:** The utility mod is only compatible with **Minecraft 1.20.1** running **Forge 47.4.x**. Other versions are not supported at this time.

### Installation

1. Download the `mineui-server-utils.jar` file
2. Copy it to your server's `mods/` directory
3. Restart the Minecraft server
4. In MineUI **Settings**, set the `Server Utils URL` to `http://<server-ip>:8787`

### Enhanced Features (with utility mod)

When the utility mod is installed, you get:

- **Accurate TPS & MSPT** - Direct server metrics instead of estimates
- **Per-Dimension Stats** - Chunk and entity counts for each dimension
- **System Metrics** - Host CPU, memory, network I/O, and disk I/O
- **Container Stats** - Podman container resource usage
- **Mod List** - Detailed list of installed Forge mods
- **Direct Player API** - Player list without RCON

### Without the utility mod

MineUI will still work, but with limited functionality:

- Basic server status via Minecraft query protocol
- Container management (start/stop/restart)
- Log streaming
- File-based mod/plugin listing
- Configuration editing
- Backups

## Settings Reference

| Setting | Description | Default |
|---------|-------------|---------|
| Container Name | Podman container name | `minecraft-server` |
| Query Host | Minecraft server address | `localhost` |
| Query Port | Minecraft query port | `25565` |
| Podman Socket | Path to Podman socket | `/run/user/1000/podman/podman.sock` |
| Podman Binary | Podman executable | `podman` |
| World Directory | World folder name | `world` |
| RCON Host | RCON server address | `localhost` |
| RCON Port | RCON port | `25575` |
| RCON Password | RCON password | (none) |
| Server Utils URL | MineUI utility mod URL | (none) |

## Troubleshooting

### "Cannot connect to server"

- Ensure your Minecraft container is running
- Verify the container name matches your settings
- Check that the Podman socket path is correct

### "No metrics available"

- Install the MineUI Server Utilities mod for full metrics
- Verify the `Server Utils URL` is set correctly (e.g., `http://localhost:8787`)
- Check that the mod loaded successfully in server logs

### "Player list not showing"

- Enable the query protocol in your `server.properties`:
  ```properties
  enable-query=true
  query.port=25565
  ```
- Or install the utility mod for direct player listing

## License

MIT
[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/K3K11SM7LV)