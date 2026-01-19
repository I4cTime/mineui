# MineUI

Local Minecraft server control panel built with Next.js and Podman.

## Features

- Start/stop the server container
- Live status + player list (query protocol)
- Logs stream (tail)
- One-click backups to `/data/backups`
- Mods & plugins list from container

## Setup

1. Ensure Podman is running and the socket is available.
2. Start the Minecraft container (optional):

```bash
podman-compose up -d
```

3. Create a local env file:

```bash
cp env.local.example .env.local
```

4. Update variables in `.env.local`:

- `MINECRAFT_CONTAINER_NAME` (default: `minecraft-server`)
- `MINECRAFT_QUERY_HOST` / `MINECRAFT_QUERY_PORT`
- `PODMAN_SOCKET` (default: `/run/user/1000/podman/podman.sock`)
- `PODMAN_BINARY` (default: `podman`)
- `MINECRAFT_WORLD_DIR` (default: `world`)

5. Start the app:

```bash
pnpm dev
```

Open `http://localhost:3000`.

## Notes

- Player list requires the Minecraft query protocol to be enabled.
- Backups are created inside the container at `/data/backups`.
- Podman compose stores data in `../minecraft-data` by default.
- Mods/plugins list reads `/data/mods` and `/data/plugins`.
