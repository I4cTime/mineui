# MineUI Project Rules

## Runtime Sources
- Prefer `mineui_server_utils` HTTP endpoints for live server metrics and status.
- Only fallback to Podman/RCON or `minecraft-server-util` when the utilities service is unavailable.
- Keep API responses aligned with `/metrics` and `/status` payloads from the utilities mod.

## API Conventions
- Use `/app/api` routes as the only frontend data boundary.
- Return `ok` and `error` fields when requests can fail.
- Preserve existing response shapes to avoid UI regressions.

## Environment & Config
- Respect `MINEUI_SERVER_UTILS_URL` for metrics and status.
- Keep container access via `PODMAN_SOCKET` and `MINECRAFT_CONTAINER_NAME`.
- Use Java 17 and Gradle 8.14.3 for `mineui_server_utils`.

## Frontend Rules
- Keep UI updates in `app/` using existing design tokens and components.
- Avoid adding new UI libraries without approval.
- Add periodic refreshes using `setInterval` with cleanup.
- Use `motion` (Motion for React) for animations, not custom CSS keyframes.
- Prefer Tailwind utility classes for layout/spacing/typography.
- Use HeroUI v3 components and patterns; follow compound component APIs.

## MCP Reference Sources
- Motion for React guidance: use MCP utilities/search tools 
- HeroUI v3 guidance: use MCP utilities/search tools 
- Tailwind guidance: use MCP utilities/search tools 
- NextJS guidance: use MCP utilities/search tools 

## Mod & Plugin Management
- Mod uploads/downloads must only accept `.jar` or `.zip`.
- Write mods to `/data/mods`, plugins to `/data/plugins`.
- Sanitize filenames and block non-http(s) URLs.

## Electron Wrapper
- Electron must load the Next.js app (dev: localhost, prod: packaged).
- Avoid node integration in renderer; keep `contextIsolation` enabled.
