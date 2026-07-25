<!--
  Thanks for contributing to MineUI. Keep PRs focused; one logical change per PR.
  CI (frontend + rust jobs) and 1 approval are required before merge on main.
-->

## Summary

<!-- What does this change, and why? -->

## Type

- [ ] Feature
- [ ] Fix
- [ ] Security
- [ ] Docs
- [ ] Chore / CI / deps

## Checklist

- [ ] `pnpm lint` passes
- [ ] `pnpm exec tsc --noEmit` passes
- [ ] `pnpm build` passes
- [ ] `cargo fmt --all --check` passes (if Rust touched)
- [ ] `cargo clippy -p mineui-core --all-targets -- -D warnings` passes (if Rust touched)
- [ ] `cargo test -p mineui-core` passes (if Rust touched)
- [ ] `CHANGELOG.md` updated under `[Unreleased]` (for user-facing changes)
- [ ] `docs/v2-contract.md` updated if the Tauri IPC surface changed (commands, args, events)
- [ ] `docs/theme-contract.md` updated if theme tokens changed
- [ ] Docs / README updated if behavior changed

## Breaking changes

<!-- None — or describe the impact and migration steps. -->
