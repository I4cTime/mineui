# Contributing to MineUI

## Setup

See [README.md § Development](README.md#development) for prerequisites and
the `pnpm tauri dev` workflow. Don't duplicate those steps here — if they go
stale, fix them there.

- **pnpm only.** Do not commit a `package-lock.json` or `yarn.lock`.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)
  (`feat:`, `fix:`, `refactor:`, etc.) — matches existing repo history.

## Binding contracts

Two docs are **law**, not suggestions. Changes to either are design
decisions — open an issue/discussion first, don't drive-by edit them in an
unrelated PR:

- [`docs/v2-contract.md`](docs/v2-contract.md) — the Tauri IPC surface:
  every command, its args/return type, error codes, and event payloads.
  `mineui-core`, `src-tauri`, and `app/lib/ipc.ts` must all match it exactly.
- [`docs/theme-contract.md`](docs/theme-contract.md) — the theme token
  system: what each CSS variable means, which ones a component may set
  directly, and the four shipped themes. Components consume tokens; they
  never hardcode colors.

If you find code that's drifted from either contract, fix the contract and
the code together in the same PR — never leave them disagreeing.

## Before opening a PR

- `cargo test -p mineui-core` — must stay green (currently 84 tests). This
  is where the actual business logic lives; if you're adding a backend
  feature, it needs coverage here, not just a manual click-through.
- `pnpm build` and `pnpm lint` — must pass.
- `pnpm exec tsc --noEmit` (or your editor's TS check) — no new type errors.
- If you touched Rust: `cargo fmt` and `cargo clippy` clean.

## Scope boundaries

- `crates/mineui-core` stays Tauri-free — no `tauri` dependency, ever. It
  should be usable as a plain Rust library. Tauri-specific glue (commands,
  events, window/path APIs) belongs in `src-tauri` only.
- Any new subprocess call (Docker/Podman CLI, `java`, etc.) must build its
  command as an argv array (`Command::new(bin).arg(...).arg(...)`), never a
  shell string with interpolated values. A static, zero-interpolation
  `sh -c` is the only exception, and only if argv genuinely can't do it.
