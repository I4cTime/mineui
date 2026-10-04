# CLAUDE.md

MineUI - container-first Minecraft server manager. Tauri v2 + Next.js
static export. See README.md for architecture/stack, CONTRIBUTING.md for
contribution process; this file is conventions and constraints only.

## Commands

- `pnpm dev` - frontend only in a browser, no Tauri backend
- `pnpm build` - static export to `out/`
- `pnpm lint` - ESLint
- `pnpm tauri dev` - full app (Next.js dev server + Tauri window)
- `pnpm tauri build` - production desktop bundle
- `cargo test -p mineui-core` - Rust unit tests (240 tests, must stay green)
- `cargo fmt` / `cargo clippy` - run before committing any Rust change

pnpm only. Do not use npm/yarn/bun.

## Binding contracts - law, not suggestions

- `docs/v2-contract.md` - the entire Tauri IPC surface (commands, args,
  return types, error codes, events). `mineui-core`, `src-tauri`, and
  `app/lib/ipc.ts` must match it exactly. Amend the doc first, then code.
- `docs/theme-contract.md` - the theme token system and the four shipped
  themes (deepslate/phosphor/quantum/softglass). Amend the doc first, then
  code.

Do not change either contract as a side effect of unrelated work.

## Architecture constraints

- `crates/mineui-core` is pure Rust: **no `tauri` dependency, ever**. All
  business logic lives here; `src-tauri` is a thin `#[tauri::command]`
  shell that delegates to it and forwards events. No validation or
  subprocess calls in `src-tauri`.
- Every subprocess invocation (docker/podman CLI, `java`, `tar`, etc.) uses
  an argv array (`Command::new(bin).arg(...)`) - never a shell string with
  interpolated values. A compile-time-constant `sh -c` with zero
  interpolation is the only permitted exception.
- `app/lib/ipc.ts` is the only file that imports
  `@tauri-apps/api/core` / `@tauri-apps/api/event`. Pages/components never
  call `invoke()` raw or redeclare an IPC type locally.
- Multi-server (contract §2.5, §3.0): a `Core` is one server profile; the
  `Hub` (`crates/mineui-core/src/hub.rs`) owns one per profile. Core
  functions keep taking `&Core` - never thread a server id through them.
  On the frontend, pages never pass a `serverId`: `ipc.ts` holds the current
  target and only `app/components/ServerProvider.tsx` moves it.
- Scope split (theme contract §9.1): nav pages are per-server and use
  `<PageHeader>` (which names the server); anything app-wide goes on
  `/app-settings` with `<PageHeader scope="app">`, never into `/settings`.
- Deleting containers (contract §3.13): only `provision::delete`, only on an
  explicit confirmed request (`confirm: true`), a data volume only with
  `deleteData`, and never a bind-mounted host folder. Never remove a
  container or volume as a side effect of anything else - `remove_server`,
  errors, cleanup - except the half-made container a failed create leaves.
  One more removal exists: `provision::update_ports` (confirmed, server
  stopped) rebuilds a container with other published ports and removes the
  old container only after the new one exists - never its volume.
  The UI must show the container's name and require it typed before sending
  `deleteData: true`.

## Design tokens

- Components consume semantic CSS variables/utilities only (`bg-background`,
  `text-accent`, `border-border`, etc.) - never a hardcoded hex/oklch/rgb
  literal. If a color needs to change, change it in the relevant
  `app/themes/*.css` file (all four), per `docs/theme-contract.md`.
- Monocraft (`.font-pixel-num`) is numerals-only - player count, TPS, ping,
  download percentage. Never apply it to headings, labels, buttons, or body
  text.
- `--radius` is the only shape knob per theme; don't set per-component
  border radii.

## Secrets

- `@heroui-pro/react` is a stub on the public registry; its postinstall
  downloads the real components only with an authenticated
  `npx heroui-pro login` session or `HEROUI_AUTH_TOKEN` set. On this
  machine the token lives in q-ring: `qring get --raw HEROUI_AUTH_TOKEN`.
  Never print it, never write it into the repo. CI gets it as a GitHub
  Actions secret of the same name.
- `cargo test -p mineui-core` and the Rust side need no secrets.
- Any future credentials (code-signing keys, etc.): read via
  `qring get --raw <KEY>`, falling back to `process.env` only when `qring`
  is unavailable - same pattern as other I4C projects. Never hardcode or
  commit a token, and never add one to `.npmrc`/`pnpm-workspace.yaml` in
  plaintext.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes - APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` - verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
